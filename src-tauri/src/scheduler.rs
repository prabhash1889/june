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
use tauri::AppHandle;

use crate::agent_runner::{run_unattended, AgentSession};

/// How often the scheduler wakes to check for due runs. 30s is fine granularity
/// for minute-resolution schedules without busy-spinning.
const TICK: std::time::Duration = std::time::Duration::from_secs(30);

/// A schedule that missed its exact minute (app was busy or asleep) still fires if
/// caught within this window, so a same-morning late launch still briefs you - but
/// launching in the evening won't replay the morning's 9am run.
const CATCHUP_MINUTES: i64 = 30;

/// Parse "HH:MM" (24h) into a NaiveTime, or None if malformed.
fn parse_hhmm(s: &str) -> Option<NaiveTime> {
    let (h, m) = s.split_once(':')?;
    NaiveTime::from_hms_opt(h.parse().ok()?, m.parse().ok()?, 0)
}

/// Whether a schedule should fire at `now`, given the day it last fired. Pure so the
/// due rule is unit-tested without a live clock. Fires at most once per calendar day,
/// only on a matching weekday (empty `days` = every day), within the catch-up window
/// after the scheduled time. `days` are 0=Sun..6=Sat, matching src/lib/schedules.ts.
fn is_due(now: NaiveDateTime, time: &str, days: &[u32], last_fired: Option<NaiveDate>) -> bool {
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
    time: String,
    days: Vec<u32>,
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

fn s(v: &serde_json::Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
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
                    time: s(v, "time"),
                    days: v
                        .get("days")
                        .and_then(|d| d.as_array())
                        .map(|a| a.iter().filter_map(|x| x.as_u64().map(|n| n as u32)).collect())
                        .unwrap_or_default(),
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

/// Render the fired-today map for `june-scheduler.json` (sorted for determinism).
/// Pure, so the roundtrip is unit-tested. Persisting this map (improvement-5 P0.4)
/// stops a restart inside the 30-minute catch-up window from re-firing a schedule
/// that already ran today.
fn render_fired(fired: &HashMap<String, NaiveDate>) -> String {
    let map: std::collections::BTreeMap<&String, String> = fired.iter().map(|(k, v)| (k, v.to_string())).collect();
    serde_json::to_string(&map).unwrap_or_else(|_| "{}".to_string())
}

/// Parse a persisted fired-today map; garbage (missing file contents, bad JSON,
/// malformed dates) reads as empty, which only risks the pre-persistence behaviour.
fn parse_fired(s: &str) -> HashMap<String, NaiveDate> {
    serde_json::from_str::<HashMap<String, String>>(s)
        .map(|m| m.into_iter().filter_map(|(k, v)| v.parse().ok().map(|d| (k, d))).collect())
        .unwrap_or_default()
}

/// `<app_data_dir>/june-scheduler.json` - NOT settings.json: a settings write
/// respawns the resident, which a bookkeeping update must never do.
fn state_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("june-scheduler.json"))
}

fn load_fired(app: &AppHandle) -> HashMap<String, NaiveDate> {
    state_file(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| parse_fired(&s))
        .unwrap_or_default()
}

/// Best-effort atomic write (temp + rename, the same pattern as memory/lessons).
/// A failed write only means restart-double-fire protection lapses until the next.
fn save_fired(app: &AppHandle, fired: &HashMap<String, NaiveDate>) {
    let Some(path) = state_file(app) else { return };
    let tmp = path.with_extension("json.tmp");
    let write = std::fs::write(&tmp, render_fired(fired).as_bytes()).and_then(|()| std::fs::rename(&tmp, &path));
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
        // Fired-today is persisted (june-scheduler.json, improvement-5 P0.4) so a
        // restart inside the catch-up window can't re-fire a schedule that already
        // ran. Trigger mtimes stay in-memory: a restart re-baselines them without
        // firing, so enabling/relaunching never acts on an already-old file.
        let mut fired: HashMap<String, NaiveDate> = load_fired(&app);
        let mut attempts: HashMap<String, u32> = HashMap::new();
        let mut mtimes: HashMap<String, std::time::SystemTime> = HashMap::new();

        loop {
            std::thread::sleep(TICK);
            let settings = crate::settings::read_settings(&app);
            let now = Local::now().naive_local();

            for sc in read_schedules(&settings) {
                if !sc.enabled {
                    continue;
                }
                if !is_due(now, &sc.time, &sc.days, fired.get(&sc.id).copied()) {
                    // Any half-spent retry budget is void once the window closes
                    // (or the day turns), so it can't bleed into the next fire.
                    attempts.remove(&sc.id);
                    continue;
                }
                if session.is_busy() {
                    continue; // don't preempt an interactive turn; retry next tick
                }
                // Mark fired only once the schedule is DONE for today (B3.3 +
                // improvement-5 P0.4): a spawn-race deferral retries next tick, and
                // an error retries up to MAX_ATTEMPTS before the day is given up.
                let outcome = fire(&app, &session, format!("schedule: {}", sc.label), sc.prompt.clone(), None);
                if settle_attempt(&mut attempts, &sc.id, &outcome) {
                    if let FireOutcome::Errored(e) = &outcome {
                        notify(&app, &format!("June couldn't finish: schedule: {}", sc.label), e);
                    }
                    fired.insert(sc.id.clone(), now.date());
                    save_fired(&app, &fired);
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
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
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
        assert!(is_due(at_time, "09:00", &[], None));
        // Already fired today -> no re-fire.
        assert!(!is_due(at_time, "09:00", &[], Some(at_time.date())));
    }

    #[test]
    fn respects_the_catch_up_window() {
        // 20 min late still fires (within the 30-min catch-up)...
        assert!(is_due(dt("2026-07-20 09:20"), "09:00", &[], None));
        // ...an hour late does not (missed for today).
        assert!(!is_due(dt("2026-07-20 10:00"), "09:00", &[], None));
        // Before the scheduled time never fires.
        assert!(!is_due(dt("2026-07-20 08:59"), "09:00", &[], None));
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
    fn fired_state_roundtrips_and_tolerates_garbage() {
        let mut fired = HashMap::new();
        fired.insert("morning".to_string(), dt("2026-07-20 09:00").date());
        fired.insert("evening".to_string(), dt("2026-07-20 21:00").date());
        assert_eq!(parse_fired(&render_fired(&fired)), fired);
        assert!(parse_fired("").is_empty());
        assert!(parse_fired("not json").is_empty());
        // A malformed date drops that entry, not the whole map.
        let partial = parse_fired(r#"{"ok":"2026-07-20","bad":"yesterday"}"#);
        assert_eq!(partial.len(), 1);
        assert!(partial.contains_key("ok"));
    }

    #[test]
    fn honours_weekday_filter() {
        // 2026-07-20 is Monday (weekday 1). Restrict to Sundays (0) -> no fire.
        assert!(!is_due(dt("2026-07-20 09:00"), "09:00", &[0], None));
        // Restrict to Mondays (1) -> fires.
        assert!(is_due(dt("2026-07-20 09:00"), "09:00", &[1], None));
        // Empty day list = every day.
        assert!(is_due(dt("2026-07-20 09:00"), "09:00", &[], None));
    }
}
