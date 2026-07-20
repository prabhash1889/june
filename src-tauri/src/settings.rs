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
}
