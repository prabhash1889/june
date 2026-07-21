use serde_json::Value;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Serializes every Rust read-modify-write of settings.json (7.7) so two Tauri
/// commands (a general save racing a schedule edit, or the scheduler retiring a
/// watch) can't interleave their read+write and clobber each other. The automation
/// MCP server is a separate process and can't share this lock - but it re-reads the
/// file immediately before each write, so the only residual race is a voice write
/// landing in the exact window of a panel automation edit (rare, both human-paced).
static SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Keys the automation MCP server and scheduler own out-of-band: voice-created
/// schedules/watches/triggers and the pending-mission queue. The general
/// `save_settings` (a whole-bag write from a webview snapshot that may be stale
/// relative to a concurrent voice write) must NOT author these - a last-writer-wins
/// overwrite would silently drop a just-created schedule (7.7). They are written
/// only by `save_automations` (the panel) or the automation server (voice).
const AUTOMATION_KEYS: [&str; 4] = ["schedules", "watches", "triggers", "pendingMissions"];

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// A general settings save (7.7): overlay `incoming` (the webview's whole bag) but
/// keep the automation-owned keys from the freshly-read `disk` bag, so a stale
/// snapshot can't drop a concurrently voice-created schedule/watch/trigger/mission.
/// Pure.
fn merge_general_save(disk: &Value, incoming: Value) -> Value {
    let mut out = incoming;
    if let Value::Object(map) = &mut out {
        for key in AUTOMATION_KEYS {
            match disk.get(key) {
                Some(v) => {
                    map.insert(key.to_string(), v.clone());
                }
                None => {
                    map.remove(key);
                }
            }
        }
    }
    out
}

/// The panel's dedicated automation save (7.7): overlay only the three panel-editable
/// lists onto the freshly-read `disk` bag, preserving every other key (including the
/// automation-server-owned `pendingMissions`, which the webview never authors). Pure.
fn merge_automation_save(disk: &Value, schedules: Value, watches: Value, triggers: Value) -> Value {
    let mut out = disk.clone();
    if let Value::Object(map) = &mut out {
        map.insert("schedules".into(), schedules);
        map.insert("watches".into(), watches);
        map.insert("triggers".into(), triggers);
    }
    out
}

/// Absolute path to settings.json for the resident's automation capability
/// (improvement-5 P1.5). The automation MCP server writes schedules/watch loops
/// here; the scheduler re-reads them each tick. None if the app-data dir can't be
/// resolved, in which case the capability is simply not attached.
pub(crate) fn settings_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    settings_path(app).ok()
}

fn read_settings_file(path: &Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Value::Object(Default::default())),
        Err(e) => Err(e.to_string()),
    }
}

fn write_settings_file(path: &Path, settings: &Value) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    // Temp file + rename so a crash mid-write can't leave settings.json truncated/corrupt (7.8a).
    crate::fsutil::atomic_write(path, raw.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_settings(app: tauri::AppHandle) -> Result<Value, String> {
    read_settings_file(&settings_path(&app)?)
}

/// Flip one watch loop's `enabled` to false in settings.json (1.9). When a watch
/// hits its stop condition (or the iteration cap) the scheduler retires it so it
/// no longer lingers as "enabled" and re-arms on the next app restart. Read-
/// modify-write with the same atomic rename as `save_settings`; best-effort - a
/// failed write only means the watch stays enabled (its DONE state is still
/// persisted in june-scheduler.json, which stops the re-fire). Does NOT respawn
/// the resident (a watch edit isn't part of the system prompt); the scheduler's
/// own mtime watch emits `settings://changed` so open windows reload.
pub(crate) fn disable_watch(app: &tauri::AppHandle, id: &str) {
    let Ok(path) = settings_path(app) else { return };
    let _guard = SETTINGS_WRITE_LOCK.lock().unwrap();
    let Ok(mut settings) = read_settings_file(&path) else {
        return;
    };
    let Some(watches) = settings.get_mut("watches").and_then(|v| v.as_array_mut()) else {
        return;
    };
    let mut changed = false;
    for w in watches.iter_mut() {
        if w.get("id").and_then(|x| x.as_str()) == Some(id) {
            w["enabled"] = Value::Bool(false);
            changed = true;
        }
    }
    if changed {
        let _ = write_settings_file(&path, &settings);
    }
}

/// Flip one schedule's `enabled` to false in settings.json (improvement-6 4.1).
/// When a `once` reminder fires it retires itself so it neither re-fires this
/// session nor re-arms on the next app restart. Same atomic read-modify-write as
/// `disable_watch`; best-effort - a failed write only means the reminder stays
/// enabled, and the scheduler's persisted `fired` map still stops the re-fire.
pub(crate) fn disable_schedule(app: &tauri::AppHandle, id: &str) {
    let Ok(path) = settings_path(app) else { return };
    let _guard = SETTINGS_WRITE_LOCK.lock().unwrap();
    let Ok(mut settings) = read_settings_file(&path) else {
        return;
    };
    let Some(schedules) = settings.get_mut("schedules").and_then(|v| v.as_array_mut()) else {
        return;
    };
    let mut changed = false;
    for sc in schedules.iter_mut() {
        if sc.get("id").and_then(|x| x.as_str()) == Some(id) {
            sc["enabled"] = Value::Bool(false);
            changed = true;
        }
    }
    if changed {
        let _ = write_settings_file(&path, &settings);
    }
}

/// Pop the head of the `pendingMissions` queue in settings.json (improvement-6
/// 4.10), returning the popped request as raw JSON, or None if the queue is empty/
/// absent. The automation MCP server pushes a voice-started mission here (already
/// user-approved, since start_mission is gated); the scheduler consumes exactly one
/// per tick with this. Atomic read-modify-write like `disable_schedule`; a write
/// failure returns None (the request stays and retries next tick) rather than
/// starting a mission it couldn't dequeue, which would loop it forever.
pub(crate) fn take_pending_mission(app: &tauri::AppHandle) -> Option<Value> {
    let path = settings_path(app).ok()?;
    let _guard = SETTINGS_WRITE_LOCK.lock().unwrap();
    let mut settings = read_settings_file(&path).ok()?;
    let queue = settings.get_mut("pendingMissions")?.as_array_mut()?;
    if queue.is_empty() {
        return None;
    }
    let head = queue.remove(0);
    write_settings_file(&path, &settings).ok()?;
    Some(head)
}

/// Read the settings bag from Rust (e.g. to resolve the chosen brain before
/// spawning a turn). Missing/unreadable settings collapse to an empty object so
/// callers get defaults rather than an error.
pub(crate) fn read_settings(app: &tauri::AppHandle) -> Value {
    settings_path(app)
        .and_then(|p| read_settings_file(&p))
        .unwrap_or_else(|_| Value::Object(Default::default()))
}

/// True if the current privacy mode keeps voice on-device, so cloud STT/TTS must
/// be refused at the execution boundary (10.3) - the same rule the brain already
/// gets in agent/serve.ts. There is no local voice provider yet, so under
/// these modes cloud voice is simply blocked. Mirrors src/lib/privacy.ts.
pub(crate) fn cloud_voice_blocked(app: &tauri::AppHandle) -> bool {
    matches!(
        read_settings(app)
            .get("privacyMode")
            .and_then(|v| v.as_str()),
        Some("local-voice") | Some("strict-offline")
    )
}

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: Value) -> Result<(), String> {
    let path = settings_path(&app)?;
    // Merge-on-save (7.7): re-read disk under the write lock and keep the
    // automation-owned keys from disk, so this whole-bag write (from a possibly
    // stale webview snapshot) can't drop a concurrently voice-created schedule.
    {
        let _guard = SETTINGS_WRITE_LOCK.lock().unwrap();
        let disk = read_settings_file(&path).unwrap_or_else(|_| Value::Object(Default::default()));
        let merged = merge_general_save(&disk, settings);
        write_settings_file(&path, &merged)?;
    }
    // Live settings propagation (10.5): tell open windows to reload so wake/TTS/
    // privacy changes apply without an app restart. Best-effort broadcast.
    let _ = app.emit("settings://changed", ());
    // The resident agent (Phase 11.1) reads its brain/privacy/files config once at
    // spawn, so a settings change must respawn it - otherwise a live brain or
    // privacy-mode switch wouldn't take effect until an app restart. Respawn is
    // DEFERRED if a turn is in flight (B2.1): killing mid-turn would abort the very
    // command being sent (e.g. a review-gate correction saved as the turn runs).
    if let Some(session) = app.try_state::<crate::agent_runner::AgentSession>() {
        session.request_respawn();
    }
    Ok(())
}

/// The Settings panel's dedicated write path for the automation lists (7.7). Because
/// the panel and the automation MCP server both author schedules/watches/triggers, a
/// general whole-bag save can't own them (it would clobber a concurrent voice write);
/// instead the panel calls this, which re-reads disk under the write lock and
/// overlays only these three lists. Does NOT respawn the resident - automation lists
/// aren't in its system prompt (matching disable_watch/disable_schedule), and a
/// respawn would churn the wake mic on every schedule keystroke.
#[tauri::command]
pub fn save_automations(
    app: tauri::AppHandle,
    schedules: Value,
    watches: Value,
    triggers: Value,
) -> Result<(), String> {
    let path = settings_path(&app)?;
    {
        let _guard = SETTINGS_WRITE_LOCK.lock().unwrap();
        let disk = read_settings_file(&path).unwrap_or_else(|_| Value::Object(Default::default()));
        let merged = merge_automation_save(&disk, schedules, watches, triggers);
        write_settings_file(&path, &merged)?;
    }
    // The scheduler re-reads settings each tick and open windows reload on this;
    // best-effort broadcast so an idle panel reflects the change at once.
    let _ = app.emit("settings://changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "june-settings-test-{}-{}",
            std::process::id(),
            name
        ))
    }

    #[test]
    fn missing_file_reads_as_empty_object() {
        let path = temp_path("missing.json");
        assert_eq!(read_settings_file(&path).unwrap(), serde_json::json!({}));
    }

    #[test]
    fn round_trips_arbitrary_json() {
        let path = temp_path("roundtrip.json");
        let value = serde_json::json!({ "launchCount": 3, "nested": { "a": [1, 2, 3] } });

        write_settings_file(&path, &value).unwrap();
        assert_eq!(read_settings_file(&path).unwrap(), value);

        fs::remove_file(&path).unwrap();
    }

    /// A general save keeps the automation-owned keys from disk (7.7): a stale
    /// webview snapshot writing an unrelated key can't drop a concurrently
    /// voice-created schedule / pending mission.
    #[test]
    fn general_save_preserves_automation_keys_from_disk() {
        let disk = serde_json::json!({
            "privacyMode": "standard",
            "schedules": [{ "id": "s1", "label": "Voice-added" }],
            "pendingMissions": [{ "outcome": "queued" }],
        });
        // The webview loaded before the voice write, so its bag has no schedules and
        // is changing only privacyMode.
        let incoming = serde_json::json!({
            "privacyMode": "local-voice",
            "schedules": [],
            "volume": 0.8,
        });
        let merged = merge_general_save(&disk, incoming);
        // Webview-owned keys win...
        assert_eq!(merged["privacyMode"], "local-voice");
        assert_eq!(merged["volume"], 0.8);
        // ...but the automation keys are taken from disk, not the stale payload.
        assert_eq!(merged["schedules"][0]["id"], "s1");
        assert_eq!(merged["pendingMissions"][0]["outcome"], "queued");
    }

    /// A general save whose disk bag has no automation key must not carry a stale
    /// automation key in from the payload either - it's dropped to match disk.
    #[test]
    fn general_save_drops_automation_key_absent_from_disk() {
        let disk = serde_json::json!({ "privacyMode": "standard" });
        let incoming = serde_json::json!({ "privacyMode": "standard", "schedules": [{ "id": "stale" }] });
        let merged = merge_general_save(&disk, incoming);
        assert!(merged.get("schedules").is_none());
    }

    /// The panel's automation save overlays only the three lists and preserves every
    /// other key - notably the automation-server-owned pendingMissions (7.7).
    #[test]
    fn automation_save_overlays_lists_and_preserves_the_rest() {
        let disk = serde_json::json!({
            "privacyMode": "standard",
            "schedules": [{ "id": "old" }],
            "pendingMissions": [{ "outcome": "queued" }],
        });
        let merged = merge_automation_save(
            &disk,
            serde_json::json!([{ "id": "edited" }]),
            serde_json::json!([]),
            serde_json::json!([]),
        );
        assert_eq!(merged["schedules"][0]["id"], "edited");
        assert_eq!(merged["watches"].as_array().unwrap().len(), 0);
        // Non-automation-list keys survive untouched.
        assert_eq!(merged["privacyMode"], "standard");
        assert_eq!(merged["pendingMissions"][0]["outcome"], "queued");
    }

    /// The pending-mission dequeue is FIFO, pops exactly one, persists the shortened
    /// queue, and preserves other keys (4.10). Exercises the pure IO directly (the
    /// public helper needs an AppHandle, but the head-pop + write is the logic).
    #[test]
    fn pending_missions_pop_head_and_persist_rest() {
        let path = temp_path("pending.json");
        let value = serde_json::json!({
            "voiceEnabled": true,
            "pendingMissions": [
                { "outcome": "first", "tasks": ["a"] },
                { "outcome": "second", "tasks": ["b"] }
            ]
        });
        write_settings_file(&path, &value).unwrap();

        // Mirror take_pending_mission's read-modify-write against the temp path.
        let mut settings = read_settings_file(&path).unwrap();
        let queue = settings
            .get_mut("pendingMissions")
            .unwrap()
            .as_array_mut()
            .unwrap();
        let head = queue.remove(0);
        write_settings_file(&path, &settings).unwrap();

        assert_eq!(head["outcome"], "first");
        let after = read_settings_file(&path).unwrap();
        assert_eq!(after["pendingMissions"].as_array().unwrap().len(), 1);
        assert_eq!(after["pendingMissions"][0]["outcome"], "second");
        assert_eq!(after["voiceEnabled"], true); // other keys preserved

        fs::remove_file(&path).unwrap();
    }
}
