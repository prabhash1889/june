use serde_json::Value;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use tauri::Manager;

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

#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: Value) -> Result<(), String> {
    write_settings_file(&settings_path(&app)?, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("june-settings-test-{}-{}", std::process::id(), name))
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
