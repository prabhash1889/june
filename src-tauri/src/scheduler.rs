// Autonomy: scheduled runs & watch loops (improvement-4 Phase 18). A single
// background thread wakes every TICK, reads the schedules and file-triggers from
// settings.json (fresh each tick, so an edit takes effect with no restart), and
// fires any that are due as UNATTENDED agent runs through the resident.
//
// The safety invariant lives one layer down: an unattended run BLOCKS every gated
// tool call (agent/serve.ts, 18.2), so nothing here can act beyond June's leash.
// This module only decides WHEN to run and hands the prompt off; it never approves
// anything.
//
// Deviation from the doc's "cron expressions": a daily HH:MM + optional weekday
// set covers the exit criterion (a daily 9am briefing) with a small, fully
// unit-tested rule and no cron-parser dependency. Full cron is the upgrade path.
//
// The "runs while you don't" headline ultimately wants the bundled sidecar (16.4,
// deferred) to run headless with no window; today the tick fires while the app is
// open, which is where a local-first agent lives anyway ("laptop closed" is
// explicitly out of scope).

use std::collections::HashMap;

use chrono::{Datelike, Local, NaiveDate, NaiveDateTime, NaiveTime};
use tauri::{AppHandle, Emitter};

use crate::agent_runner::{run_unattended, AgentSession};

/// How often the scheduler wakes to check for due runs. 30s is fine granularity
/// for minute-resolution schedules without busy-spinning.
const TICK: std::time::Duration = std::time::Duration::from_secs(30);

/// A schedule that missed its exact minute (app was busy or asleep) still fires if
/// caught within this window, so a same-morning late launch still briefs you - but
/// launching in the evening won't replay the morning's 9am run.
const CATCHUP_MINUTES: i64 = 30;

/// How many iterations a watch loop (P1.2) may run before giving up, so a stop
/// condition that never comes true still stops rather than looping forever.
const MAX_WATCH_ITERS: u32 = 30;

/// Parse "HH:MM" (24h) into a NaiveTime, or None if malformed.
fn parse_hhmm(s: &str) -> Option<NaiveTime> {
    let (h, m) = s.split_once(':')?;
    NaiveTime::from_hms_opt(h.parse().ok()?, m.parse().ok()?, 0)
}

/// How a schedule recurs (improvement-5 P1.1). Mirrors src/lib/schedules.ts.
#[derive(Debug, PartialEq, Clone, Copy)]
enum Kind {
    Daily,
    Every,
}

/// Whether a schedule should fire at `now`, given when it last fired. Pure so the
/// due rule is unit-tested without a live clock. Dispatches on kind: a `daily`
/// schedule fires at most once per calendar day within the catch-up window; an
/// `every` schedule fires once its interval has elapsed since the last fire.
fn is_due(now: NaiveDateTime, sc: &Schedule, last_fired: Option<NaiveDateTime>) -> bool {
    match sc.kind {
        Kind::Daily => daily_due(now, &sc.time, &sc.days, last_fired.map(|d| d.date())),
        Kind::Every => interval_due(now, sc.every_minutes, last_fired),
    }
}

/// The daily rule (Phase 18.1): fires at most once per calendar day, only on a
/// matching weekday (empty `days` = every day), within the catch-up window after
/// the scheduled time. `days` are 0=Sun..6=Sat, matching src/lib/schedules.ts.
fn daily_due(now: NaiveDateTime, time: &str, days: &[u32], last_fired: Option<NaiveDate>) -> bool {
    let today = now.date();
    let weekday = today.weekday().num_days_from_sunday();
    if !days.is_empty() && !days.contains(&weekday) {
        return false;
    }
    if last_fired == Some(today) {
        return false; // already fired today
    }
    let Some(t) = parse_hhmm(time) else {
        return false;
    };
    let scheduled = today.and_time(t);
    let elapsed = now - scheduled;
    elapsed >= chrono::Duration::zero() && elapsed < chrono::Duration::minutes(CATCHUP_MINUTES)
}

/// The interval rule (improvement-5 P1.1/P1.2): fires when it has never fired, or
/// once `every_minutes` have elapsed since the last fire. Shared by `every`
/// schedules and watch loops. Pure so the interval rule is unit-tested.
fn interval_due(now: NaiveDateTime, every_minutes: u32, last_fired: Option<NaiveDateTime>) -> bool {
    match last_fired {
        None => true,
        Some(prev) => now - prev >= chrono::Duration::minutes(every_minutes.max(1) as i64),
    }
}

/// Show an OS notification (Phase 18.1 "OS notification on completion"). Best-effort:
/// a missing notification permission or headless environment must never break a run.
pub(crate) fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

/// A parsed schedule from settings.json. Mirrors src/lib/schedules.ts::Schedule; the
/// TS side coerces/validates for the UI, this reads the same stored shape defensively.
struct Schedule {
    id: String,
    label: String,
    prompt: String,
    kind: Kind,
    time: String,
    days: Vec<u32>,
    every_minutes: u32,
    enabled: bool,
}

/// A parsed file-trigger from settings.json. Mirrors src/lib/schedules.ts::FileTrigger.
struct Trigger {
    id: String,
    label: String,
    path: String,
    prompt: String,
    enabled: bool,
}

/// A parsed watch loop from settings.json (improvement-5 P1.2). Mirrors
/// src/lib/schedules.ts::WatchLoop.
struct Watch {
    id: String,
    label: String,
    prompt: String,
    every_minutes: u32,
    until_condition: String,
    enabled: bool,
}

fn s(v: &serde_json::Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// Read an interval-minutes field defensively, clamped to at least one minute so a
/// garbled 0/negative value can't busy-fire every tick.
fn every_minutes(v: &serde_json::Value) -> u32 {
    v.get("everyMinutes")
        .and_then(|x| x.as_u64())
        .map(|n| n.clamp(1, u32::MAX as u64) as u32)
        .unwrap_or(60)
}

/// A watch loop's stop verdict, parsed from June's reply (P1.2). Defaults to
/// `Continue` when ambiguous - the safer choice, since the iteration cap still
/// stops a loop whose condition never resolves.
#[derive(Debug, PartialEq)]
enum Verdict {
    Done,
    Continue,
}

/// Parse June's watch reply into a stop verdict. Pure so the rule is unit-tested.
/// Prefers a line that is exactly DONE/CONTINUE (ignoring surrounding punctuation);
/// falls back to a whole-reply scan, treating an unqualified DONE as done.
fn parse_verdict(reply: &str) -> Verdict {
    for line in reply.lines() {
        let t = line
            .trim()
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_ascii_uppercase();
        if t == "DONE" {
            return Verdict::Done;
        }
        if t == "CONTINUE" {
            return Verdict::Continue;
        }
    }
    let up = reply.to_ascii_uppercase();
    if up.contains("DONE") && !up.contains("CONTINUE") {
        Verdict::Done
    } else {
        Verdict::Continue
    }
}

/// Compose a watch loop's task prompt (P1.2): the user's check, plus the stop
/// instruction that makes June end DONE or CONTINUE. `run_unattended` wraps this
/// again in the unattended frame (18.2), which is the actual leash. Pure.
fn frame_watch(prompt: &str, until: &str) -> String {
    let task = if prompt.trim().is_empty() {
        "Check the current status."
    } else {
        prompt.trim()
    };
    let cond = until.trim();
    if cond.is_empty() {
        format!(
            "{task}\n\nWhen this is finished and there is nothing left to check, reply with exactly \
             the word DONE on its own line. Otherwise reply CONTINUE. Then add one short sentence of status."
        )
    } else {
        format!(
            "{task}\n\nRe-check this each time. If this condition is now true - {cond} - reply with \
             exactly the word DONE on its own line. Otherwise reply CONTINUE. Then add one short sentence of status."
        )
    }
}

fn read_schedules(settings: &serde_json::Value) -> Vec<Schedule> {
    settings
        .get("schedules")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|v| Schedule {
                    id: s(v, "id"),
                    label: s(v, "label"),
                    prompt: s(v, "prompt"),
                    kind: if s(v, "kind") == "every" { Kind::Every } else { Kind::Daily },
                    time: s(v, "time"),
                    days: v
                        .get("days")
                        .and_then(|d| d.as_array())
                        .map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u32)).collect())
                        .unwrap_or_default(),
                    every_minutes: every_minutes(v),
                    enabled: v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn read_watches(settings: &serde_json::Value) -> Vec<Watch> {
    settings
        .get("watches")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|v| Watch {
                    id: s(v, "id"),
                    label: s(v, "label"),
                    prompt: s(v, "prompt"),
                    every_minutes: every_minutes(v),
                    until_condition: s(v, "untilCondition"),
                    enabled: v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn read_triggers(settings: &serde_json::Value) -> Vec<Trigger> {
    settings
        .get("triggers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|v| Trigger {
                    id: s(v, "id"),
                    label: s(v, "label"),
                    path: s(v, "path"),
                    prompt: s(v, "prompt"),
                    enabled: v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// What one attempted unattended run did (improvement-5 P0.4): the caller decides
/// what to record - a deferred run must retry next tick, an errored SCHEDULE gets
/// a few retries before the day is given up, an errored TRIGGER is consumed.
enum FireOutcome {
    Ran,
    /// A user turn slipped in during spawn (B3.3); retry next tick.
    Deferred,
    Errored(String),
}

/// How many failed attempts a schedule gets (one per 30s tick) before its day is
/// given up. A transient brain/network failure must not cost the day's run.
const MAX_ATTEMPTS: u32 = 3;

/// Fold one schedule attempt into the per-id retry counter. Returns true when the
/// schedule is DONE for today (ran, or errored out of attempts) - the caller then
/// marks it fired. Pure so the retry rule is unit-tested without a clock.
fn settle_attempt(attempts: &mut HashMap<String, u32>, id: &str, outcome: &FireOutcome) -> bool {
    match outcome {
        FireOutcome::Deferred => false,
        FireOutcome::Ran => {
            attempts.remove(id);
            true
        }
        FireOutcome::Errored(_) => {
            let n = attempts.entry(id.to_string()).or_insert(0);
            *n += 1;
            if *n >= MAX_ATTEMPTS {
                attempts.remove(id);
                true
            } else {
                false
            }
        }
    }
}

/// Fire one unattended run. Blocking (runs the whole agent turn); called inline in
/// the tick thread so unattended runs serialize. Success notifies here; a failure
/// is returned so the caller can retry silently and notify only on giving up.
fn fire(app: &AppHandle, session: &AgentSession, source: String, prompt: String, untrusted: Option<String>) -> FireOutcome {
    match run_unattended(app, session, prompt, source.clone(), untrusted) {
        Ok(Some(reply)) => {
            let body = if reply.trim().is_empty() { "Done.".to_string() } else { truncate(&reply, 240) };
            notify(app, &format!("June finished: {source}"), &body);
            FireOutcome::Ran
        }
        Ok(None) => FireOutcome::Deferred,
        Err(e) => FireOutcome::Errored(e),
    }
}

/// Bytes of a watched trigger file to read into an unattended run's prompt. The TS
/// side caps the payload at 4000 chars (schedules.ts); 64 KiB here is comfortably
/// above that even for multi-byte text, while stopping a multi-GB log from
/// ballooning memory before that cap ever applies (B3.8).
const TRIGGER_READ_LIMIT: u64 = 64 * 1024;

/// Read only the head of a (possibly huge) trigger file (B3.8), lossily decoded. A
/// missing/unreadable file reads as empty, like the prior `read_to_string`.
fn read_trigger_head(path: &str) -> String {
    use std::io::Read;
    let Ok(file) = std::fs::File::open(path) else {
        return String::new();
    };
    let mut buf = Vec::new();
    let _ = file.take(TRIGGER_READ_LIMIT).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// What to do with a file trigger this tick, given its previous baseline mtime, the
/// current mtime, and whether the session is busy. Pure so the "defer WITHOUT
/// advancing the baseline" rule (B3.1) is unit-tested without a clock or filesystem.
#[derive(Debug, PartialEq)]
enum TriggerAction {
    /// Unchanged, or deferred while busy: leave the baseline untouched.
    Ignore,
    /// First sighting: record the baseline, but don't fire on an already-old file.
    Baseline,
    /// Changed and free: fire, then (only on real dispatch) advance the baseline.
    Fire,
}

fn trigger_action(
    prev: Option<std::time::SystemTime>,
    modified: std::time::SystemTime,
    busy: bool,
) -> TriggerAction {
    match prev {
        None => TriggerAction::Baseline,
        // A change while busy is deferred WITHOUT advancing the baseline (B3.1): the
        // old code advanced it before the busy check, so a change during a user turn
        // was silently swallowed and never fired.
        Some(p) if modified > p => {
            if busy {
                TriggerAction::Ignore
            } else {
                TriggerAction::Fire
            }
        }
        _ => TriggerAction::Ignore,
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// Timestamp format persisted in `june-scheduler.json`. Explicit (not `Display`,
/// whose space separator `NaiveDateTime`'s parser rejects) so it round-trips.
const FIRED_FMT: &str = "%Y-%m-%dT%H:%M:%S";

/// The persisted scheduler bookkeeping (`june-scheduler.json`). `fired` stops a
/// daily/`every` schedule re-firing across a restart (improvement-5 P0.4/P1.1);
/// the watch fields (1.9) stop a DONE watch loop re-arming, re-firing and
/// re-notifying on every app restart, forever - watch state used to live only in
/// memory. All four persist together in one file.
#[derive(Default, Debug, PartialEq)]
struct Persisted {
    fired: HashMap<String, NaiveDateTime>,
    watch_fired: HashMap<String, NaiveDateTime>,
    watch_iters: HashMap<String, u32>,
    watch_done: std::collections::HashSet<String>,
}

/// Parse one id->timestamp map from a JSON object, tolerating a legacy date-only
/// value (pre-P1.1) as that day's midnight and dropping malformed entries.
fn parse_time_map(v: &serde_json::Value) -> HashMap<String, NaiveDateTime> {
    v.as_object()
        .map(|o| {
            o.iter()
                .filter_map(|(k, val)| {
                    let s = val.as_str()?;
                    NaiveDateTime::parse_from_str(s, FIRED_FMT)
                        .ok()
                        .or_else(|| s.parse::<NaiveDate>().ok().map(|d| d.and_hms_opt(0, 0, 0).unwrap()))
                        .map(|dt| (k.clone(), dt))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Render an id->timestamp map to a sorted (deterministic) JSON object value.
fn render_time_map(m: &HashMap<String, NaiveDateTime>) -> serde_json::Value {
    let sorted: std::collections::BTreeMap<&String, String> =
        m.iter().map(|(k, v)| (k, v.format(FIRED_FMT).to_string())).collect();
    serde_json::to_value(sorted).unwrap_or_else(|_| serde_json::json!({}))
}

/// Render the persisted state for `june-scheduler.json` (sorted for determinism).
/// Pure, so the roundtrip is unit-tested.
fn render_state(p: &Persisted) -> String {
    let iters: std::collections::BTreeMap<&String, u32> = p.watch_iters.iter().map(|(k, v)| (k, *v)).collect();
    let mut done: Vec<&String> = p.watch_done.iter().collect();
    done.sort();
    serde_json::json!({
        "fired": render_time_map(&p.fired),
        "watchFired": render_time_map(&p.watch_fired),
        "watchIters": iters,
        "watchDone": done,
    })
    .to_string()
}

/// Parse persisted state; garbage (missing file, bad JSON, malformed timestamps)
/// reads as empty, which only risks the pre-persistence behaviour. Migrates the
/// legacy pre-1.9 format (a flat id->timestamp map that was the whole `fired` set).
fn parse_state(s: &str) -> Persisted {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(s) else {
        return Persisted::default();
    };
    // Legacy format: a flat map of id -> timestamp string (no nested "fired"
    // object, no watch keys) was the entire fired set before 1.9.
    let is_new = v.get("fired").map(|f| f.is_object()).unwrap_or(false) || v.get("watchDone").is_some();
    if !is_new {
        return Persisted {
            fired: parse_time_map(&v),
            ..Default::default()
        };
    }
    Persisted {
        fired: v.get("fired").map(parse_time_map).unwrap_or_default(),
        watch_fired: v.get("watchFired").map(parse_time_map).unwrap_or_default(),
        watch_iters: v
            .get("watchIters")
            .and_then(|x| x.as_object())
            .map(|o| o.iter().filter_map(|(k, val)| val.as_u64().map(|n| (k.clone(), n as u32))).collect())
            .unwrap_or_default(),
        watch_done: v
            .get("watchDone")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default(),
    }
}

/// `<app_data_dir>/june-scheduler.json` - NOT settings.json: a settings write
/// respawns the resident, which a bookkeeping update must never do.
fn state_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("june-scheduler.json"))
}

fn load_state(app: &AppHandle) -> Persisted {
    state_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| parse_state(&s))
        .unwrap_or_default()
}

/// Best-effort atomic write (temp + rename, the same pattern as memory/lessons).
/// A failed write only means restart-double-fire protection lapses until the next.
fn save_state(
    app: &AppHandle,
    fired: &HashMap<String, NaiveDateTime>,
    watch_fired: &HashMap<String, NaiveDateTime>,
    watch_iters: &HashMap<String, u32>,
    watch_done: &std::collections::HashSet<String>,
) {
    let Some(path) = state_file(app) else { return };
    let state = Persisted {
        fired: fired.clone(),
        watch_fired: watch_fired.clone(),
        watch_iters: watch_iters.clone(),
        watch_done: watch_done.clone(),
    };
    let tmp = path.with_extension("json.tmp");
    let write = std::fs::write(&tmp, render_state(&state).as_bytes()).and_then(|()| std::fs::rename(&tmp, &path));
    if let Err(e) = write {
        eprintln!("[scheduler] couldn't persist fired state: {e}");
    }
}

/// Start the scheduler's background thread (Phase 18). Reads settings each tick, so
/// added/edited schedules and triggers take effect on the next tick with no restart.
/// A busy session (an interactive turn or a pending approval) defers this tick's
/// fires so an unattended run never barges in on the user.
pub fn start(app: AppHandle, session: AgentSession) {
    std::thread::spawn(move || {
        // Scheduler bookkeeping is persisted (june-scheduler.json, improvement-5
        // P0.4 + 1.9) so a restart can't re-fire a schedule that already ran, nor
        // re-arm a watch that already finished. Trigger mtimes stay in-memory: a
        // restart re-baselines them without firing, so relaunching never acts on an
        // already-old file.
        let loaded = load_state(&app);
        let mut fired: HashMap<String, NaiveDateTime> = loaded.fired;
        let mut attempts: HashMap<String, u32> = HashMap::new();
        let mut mtimes: HashMap<String, std::time::SystemTime> = HashMap::new();
        // Watch-loop state (P1.2, now persisted per 1.9): last-fired, iteration
        // count, and the set that have hit their stop condition (or the iteration
        // cap). Persisting `watch_done` stops a finished watch re-firing on restart.
        let mut watch_fired: HashMap<String, NaiveDateTime> = loaded.watch_fired;
        let mut watch_iters: HashMap<String, u32> = loaded.watch_iters;
        let mut watch_done: std::collections::HashSet<String> = loaded.watch_done;
        // Last-seen settings.json mtime, to notice an out-of-band write (P1.5: the
        // automation MCP server writes schedules/watches straight to settings.json,
        // which can't emit a Tauri event itself).
        let mut settings_mtime: Option<std::time::SystemTime> = None;

        loop {
            std::thread::sleep(TICK);
            let settings = crate::settings::read_settings(&app);
            let now = Local::now().naive_local();

            // An out-of-band settings write (e.g. a voice-created automation, P1.5)
            // should reach open windows, so the settings panel reloads instead of
            // later saving a stale copy over the new automation. Emit the same
            // `settings://changed` the save command emits; the panel ignores it
            // while mid-edit, so this never clobbers what the user is typing.
            if let Some(p) = crate::settings::settings_file(&app) {
                if let Ok(m) = std::fs::metadata(&p).and_then(|md| md.modified()) {
                    if settings_mtime.is_some() && settings_mtime != Some(m) {
                        let _ = app.emit("settings://changed", ());
                    }
                    settings_mtime = Some(m);
                }
            }

            for sc in read_schedules(&settings) {
                if !sc.enabled {
                    continue;
                }
                if !is_due(now, &sc, fired.get(&sc.id).copied()) {
                    // Any half-spent retry budget is void once the window closes
                    // (or the interval passes), so it can't bleed into the next fire.
                    attempts.remove(&sc.id);
                    continue;
                }
                if session.is_busy() {
                    continue; // don't preempt an interactive turn; retry next tick
                }
                // Mark fired only once the schedule is DONE for this cycle (B3.3 +
                // improvement-5 P0.4): a spawn-race deferral retries next tick, and
                // an error retries up to MAX_ATTEMPTS before the cycle is given up.
                let outcome = fire(&app, &session, format!("schedule: {}", sc.label), sc.prompt.clone(), None);
                if settle_attempt(&mut attempts, &sc.id, &outcome) {
                    if let FireOutcome::Errored(e) = &outcome {
                        notify(&app, &format!("June couldn't finish: schedule: {}", sc.label), e);
                    }
                    // Full timestamp (P1.1): a daily schedule compares the date, an
                    // `every` schedule measures the elapsed interval from here.
                    fired.insert(sc.id.clone(), now);
                    save_state(&app, &fired, &watch_fired, &watch_iters, &watch_done);
                }
            }

            for tr in read_triggers(&settings) {
                if !tr.enabled {
                    continue;
                }
                let Ok(modified) = std::fs::metadata(&tr.path).and_then(|m| m.modified()) else {
                    continue; // file missing/unreadable this tick
                };
                match trigger_action(mtimes.get(&tr.id).copied(), modified, session.is_busy()) {
                    TriggerAction::Ignore => {}
                    TriggerAction::Baseline => {
                        mtimes.insert(tr.id.clone(), modified);
                    }
                    TriggerAction::Fire => {
                        let payload = read_trigger_head(&tr.path);
                        // Advance the baseline ONLY once the run actually dispatched:
                        // a run deferred by the spawn-race (B3.3) must re-fire on the
                        // next tick, so the change isn't lost (B3.1). An errored run
                        // consumes the change (retrying the same payload would loop).
                        match fire(&app, &session, format!("trigger: {}", tr.label), tr.prompt.clone(), Some(payload)) {
                            FireOutcome::Deferred => {}
                            FireOutcome::Ran => {
                                mtimes.insert(tr.id.clone(), modified);
                            }
                            FireOutcome::Errored(e) => {
                                notify(&app, &format!("June couldn't finish: trigger: {}", tr.label), &e);
                                mtimes.insert(tr.id.clone(), modified);
                            }
                        }
                    }
                }
            }

            // Watch loops (improvement-5 P1.2): re-run an observe-only unattended turn
            // on an interval, stopping when June replies DONE (the condition holds) or
            // the iteration cap is hit. The unattended leash (18.2) makes this safe by
            // construction - a watch can read and report, never act.
            for w in read_watches(&settings) {
                if !w.enabled || watch_done.contains(&w.id) {
                    continue;
                }
                if !interval_due(now, w.every_minutes, watch_fired.get(&w.id).copied()) {
                    continue;
                }
                if session.is_busy() {
                    continue; // don't preempt an interactive turn; retry next tick
                }
                let framed = frame_watch(&w.prompt, &w.until_condition);
                match run_unattended(&app, &session, framed, format!("watch: {}", w.label), None) {
                    // Spawn-race deferral (B3.3): retry next tick without advancing the
                    // baseline, so the interval isn't reset by a run that never fired.
                    Ok(None) => {}
                    outcome => {
                        watch_fired.insert(w.id.clone(), now);
                        let iters = {
                            let n = watch_iters.entry(w.id.clone()).or_insert(0);
                            *n += 1;
                            *n
                        };
                        // Decide whether this watch is finished (DONE) or has hit its
                        // check cap, and the completion note to speak.
                        let retire: Option<(String, String)> = match outcome {
                            Ok(Some(reply)) => {
                                if parse_verdict(&reply) == Verdict::Done {
                                    Some((format!("Watch complete: {}", w.label), truncate(&reply, 240)))
                                } else if iters >= MAX_WATCH_ITERS {
                                    Some((format!("Watch stopped (max checks): {}", w.label), truncate(&reply, 240)))
                                } else {
                                    None
                                }
                            }
                            // A transient error counts as an iteration; give up at the cap.
                            Err(e) if iters >= MAX_WATCH_ITERS => {
                                Some((format!("Watch stopped: {}", w.label), e))
                            }
                            Err(_) => None,
                            Ok(None) => unreachable!("Ok(None) handled above"),
                        };
                        // Retire a finished watch: mark it done AND flip its `enabled`
                        // off in settings (1.9), so it neither re-arms on restart nor
                        // lingers as "enabled" in the UI.
                        if let Some((title, body)) = retire {
                            watch_done.insert(w.id.clone());
                            crate::settings::disable_watch(&app, &w.id);
                            notify(&app, &title, &body);
                        }
                        // Persist the watch bookkeeping so a restart honours the interval
                        // and the DONE set (1.9).
                        save_state(&app, &fired, &watch_fired, &watch_iters, &watch_done);
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    /// A `daily` schedule for the due-rule tests.
    fn daily(time: &str, days: &[u32]) -> Schedule {
        Schedule {
            id: "s".into(),
            label: "S".into(),
            prompt: String::new(),
            kind: Kind::Daily,
            time: time.into(),
            days: days.to_vec(),
            every_minutes: 60,
            enabled: true,
        }
    }

    /// An `every` schedule for the interval tests.
    fn every(minutes: u32) -> Schedule {
        Schedule {
            id: "s".into(),
            label: "S".into(),
            prompt: String::new(),
            kind: Kind::Every,
            time: "09:00".into(),
            days: vec![],
            every_minutes: minutes,
            enabled: true,
        }
    }

    #[test]
    fn parses_valid_times_only() {
        assert!(parse_hhmm("09:00").is_some());
        assert!(parse_hhmm("23:59").is_some());
        assert!(parse_hhmm("24:00").is_none());
        assert!(parse_hhmm("9am").is_none());
        assert!(parse_hhmm("").is_none());
    }

    #[test]
    fn fires_once_in_window_then_not_again_today() {
        // 2026-07-20 is a Monday.
        let at_time = dt("2026-07-20 09:00");
        assert!(is_due(at_time, &daily("09:00", &[]), None));
        // Already fired today -> no re-fire (even at a different time that day).
        assert!(!is_due(at_time, &daily("09:00", &[]), Some(dt("2026-07-20 09:00"))));
    }

    #[test]
    fn respects_the_catch_up_window() {
        // 20 min late still fires (within the 30-min catch-up)...
        assert!(is_due(dt("2026-07-20 09:20"), &daily("09:00", &[]), None));
        // ...an hour late does not (missed for today).
        assert!(!is_due(dt("2026-07-20 10:00"), &daily("09:00", &[]), None));
        // Before the scheduled time never fires.
        assert!(!is_due(dt("2026-07-20 08:59"), &daily("09:00", &[]), None));
    }

    #[test]
    fn interval_schedules_fire_once_per_interval() {
        // Never fired -> due now.
        assert!(is_due(dt("2026-07-20 09:00"), &every(30), None));
        // 29 min after the last fire -> not yet.
        assert!(!is_due(dt("2026-07-20 09:29"), &every(30), Some(dt("2026-07-20 09:00"))));
        // Exactly 30 min later -> due again.
        assert!(is_due(dt("2026-07-20 09:30"), &every(30), Some(dt("2026-07-20 09:00"))));
        // A garbled 0-minute interval is clamped to at least 1, so the same minute
        // doesn't busy-fire, but a minute later does.
        assert!(!is_due(dt("2026-07-20 09:00"), &every(0), Some(dt("2026-07-20 09:00"))));
        assert!(is_due(dt("2026-07-20 09:01"), &every(0), Some(dt("2026-07-20 09:00"))));
    }

    #[test]
    fn parse_verdict_reads_done_and_defaults_to_continue() {
        assert_eq!(parse_verdict("DONE\nThe build is green."), Verdict::Done);
        assert_eq!(parse_verdict("continue.\nStill building."), Verdict::Continue);
        assert_eq!(parse_verdict("The build is done now, so: DONE"), Verdict::Done);
        // Ambiguous / no verdict -> keep going (the cap still stops it).
        assert_eq!(parse_verdict("I checked the logs."), Verdict::Continue);
        // Mentions both words -> the safe default, not a premature stop.
        assert_eq!(parse_verdict("Not done yet, CONTINUE watching."), Verdict::Continue);
    }

    #[test]
    fn frame_watch_carries_the_condition_and_stop_instruction() {
        let f = frame_watch("check the CI build", "the build is green");
        assert!(f.contains("check the CI build"));
        assert!(f.contains("the build is green"));
        assert!(f.contains("DONE"));
        assert!(f.contains("CONTINUE"));
        // No condition still asks for a DONE/CONTINUE verdict.
        let g = frame_watch("", "");
        assert!(g.contains("DONE"));
    }

    #[test]
    fn defers_a_change_while_busy_without_losing_it() {
        use std::time::{Duration, SystemTime};
        let t0 = SystemTime::UNIX_EPOCH;
        let t1 = t0 + Duration::from_secs(1);
        // First sighting records the baseline, never fires on an already-old file.
        assert_eq!(trigger_action(None, t0, false), TriggerAction::Baseline);
        // A change while BUSY is ignored WITHOUT advancing the baseline (B3.1)...
        assert_eq!(trigger_action(Some(t0), t1, true), TriggerAction::Ignore);
        // ...so the SAME change (baseline still t0) fires on a later idle tick.
        assert_eq!(trigger_action(Some(t0), t1, false), TriggerAction::Fire);
        // No change is ignored regardless of busy.
        assert_eq!(trigger_action(Some(t1), t1, false), TriggerAction::Ignore);
    }

    #[test]
    fn retries_a_failed_fire_then_gives_up_for_the_day() {
        let mut attempts = HashMap::new();
        let err = FireOutcome::Errored("boom".into());
        // Two failures leave the day open (retry on later ticks)...
        assert!(!settle_attempt(&mut attempts, "s1", &err));
        assert!(!settle_attempt(&mut attempts, "s1", &err));
        // ...the third gives up (marks fired) and clears the counter.
        assert!(settle_attempt(&mut attempts, "s1", &err));
        assert!(attempts.is_empty());
        // A success is done immediately and clears any counter.
        assert!(!settle_attempt(&mut attempts, "s2", &err));
        assert!(settle_attempt(&mut attempts, "s2", &FireOutcome::Ran));
        assert!(attempts.is_empty());
        // A deferral records nothing.
        assert!(!settle_attempt(&mut attempts, "s3", &FireOutcome::Deferred));
        assert!(attempts.is_empty());
    }

    #[test]
    fn scheduler_state_roundtrips_and_tolerates_garbage() {
        let mut p = Persisted::default();
        p.fired.insert("morning".to_string(), dt("2026-07-20 09:00"));
        p.fired.insert("interval".to_string(), dt("2026-07-20 21:34"));
        p.watch_fired.insert("build".to_string(), dt("2026-07-20 10:00"));
        p.watch_iters.insert("build".to_string(), 5);
        p.watch_done.insert("build".to_string());
        // Full state (schedules + watch bookkeeping) round-trips (1.9).
        assert_eq!(parse_state(&render_state(&p)), p);
        assert_eq!(parse_state(""), Persisted::default());
        assert_eq!(parse_state("not json"), Persisted::default());
    }

    #[test]
    fn scheduler_state_migrates_the_legacy_flat_fired_map() {
        // Pre-1.9 june-scheduler.json was a flat id->timestamp map that was the whole
        // `fired` set; it must still load, with watch state defaulting to empty. A
        // malformed timestamp drops that entry, not the whole map; a legacy date-only
        // value (pre-P1.1) is read as that day's midnight.
        let legacy = parse_state(r#"{"ts":"2026-07-20T09:00:00","legacy":"2026-07-19","bad":"yesterday"}"#);
        assert_eq!(legacy.fired.len(), 2);
        assert_eq!(legacy.fired.get("legacy"), Some(&dt("2026-07-19 00:00")));
        assert!(!legacy.fired.contains_key("bad"));
        assert!(legacy.watch_done.is_empty());
        // A new-format file with an empty fired object is NOT mistaken for legacy.
        let empty_new = parse_state(r#"{"fired":{},"watchDone":["w1"]}"#);
        assert!(empty_new.fired.is_empty());
        assert!(empty_new.watch_done.contains("w1"));
    }

    #[test]
    fn honours_weekday_filter() {
        // 2026-07-20 is Monday (weekday 1). Restrict to Sundays (0) -> no fire.
        assert!(!is_due(dt("2026-07-20 09:00"), &daily("09:00", &[0]), None));
        // Restrict to Mondays (1) -> fires.
        assert!(is_due(dt("2026-07-20 09:00"), &daily("09:00", &[1]), None));
        // Empty day list = every day.
        assert!(is_due(dt("2026-07-20 09:00"), &daily("09:00", &[]), None));
    }
}
