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

/// Fire one unattended run and notify with the outcome. Blocking (runs the whole
/// agent turn); called inline in the tick thread so unattended runs serialize.
fn fire(app: &AppHandle, session: &AgentSession, source: String, prompt: String, untrusted: Option<String>) {
    match run_unattended(app, session, prompt, source.clone(), untrusted) {
        Ok(reply) => {
            let body = if reply.trim().is_empty() { "Done.".to_string() } else { truncate(&reply, 240) };
            notify(app, &format!("June finished: {source}"), &body);
        }
        Err(e) => notify(app, &format!("June couldn't finish: {source}"), &e),
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

/// Start the scheduler's background thread (Phase 18). Reads settings each tick, so
/// added/edited schedules and triggers take effect on the next tick with no restart.
/// A busy session (an interactive turn or a pending approval) defers this tick's
/// fires so an unattended run never barges in on the user.
pub fn start(app: AppHandle, session: AgentSession) {
    std::thread::spawn(move || {
        // In-memory only (never settings.json - a settings write would respawn the
        // resident mid-run). Lost on restart, which is fine: the catch-up window
        // still fires a same-day schedule, and a first-seen file mtime is recorded
        // without firing so enabling a trigger doesn't act on an already-old file.
        let mut fired: HashMap<String, NaiveDate> = HashMap::new();
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
                    continue;
                }
                if session.is_busy() {
                    continue; // don't preempt an interactive turn; retry next tick
                }
                fired.insert(sc.id.clone(), now.date());
                fire(&app, &session, format!("schedule: {}", sc.label), sc.prompt.clone(), None);
            }

            for tr in read_triggers(&settings) {
                if !tr.enabled {
                    continue;
                }
                let Ok(modified) = std::fs::metadata(&tr.path).and_then(|m| m.modified()) else {
                    continue; // file missing/unreadable this tick
                };
                let prev = mtimes.insert(tr.id.clone(), modified);
                // Fire only on a CHANGE we have seen before: the first sighting just
                // records the baseline, so turning a trigger on doesn't fire on an
                // already-stale file.
                let changed = matches!(prev, Some(p) if modified > p);
                if !changed || session.is_busy() {
                    continue;
                }
                let payload = std::fs::read_to_string(&tr.path).unwrap_or_default();
                fire(&app, &session, format!("trigger: {}", tr.label), tr.prompt.clone(), Some(payload));
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
    fn honours_weekday_filter() {
        // 2026-07-20 is Monday (weekday 1). Restrict to Sundays (0) -> no fire.
        assert!(!is_due(dt("2026-07-20 09:00"), "09:00", &[0], None));
        // Restrict to Mondays (1) -> fires.
        assert!(is_due(dt("2026-07-20 09:00"), "09:00", &[1], None));
        // Empty day list = every day.
        assert!(is_due(dt("2026-07-20 09:00"), "09:00", &[], None));
    }
}
