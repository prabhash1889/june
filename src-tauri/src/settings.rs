use serde_json::Value;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
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
    // Temp file + rename so a crash mid-write can't leave settings.json truncated/corrupt.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
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
    write_settings_file(&settings_path(&app)?, &settings)?;
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
