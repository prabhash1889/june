use keyring::Entry;

const KEYCHAIN_USER: &str = "june_user";

/// The renderer may only touch keychain entries following the `june_provider_<provider>_api_key`
/// convention (mirrors saple-bridge). `service` crosses the renderer->Rust trust boundary, so
/// mutating commands reject anything else.
fn validate_service_name(service: &str) -> Result<(), String> {
    let provider = service
        .strip_prefix("june_provider_")
        .and_then(|rest| rest.strip_suffix("_api_key"))
        .unwrap_or("");
    let valid = !provider.is_empty()
        && provider
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if valid {
        Ok(())
    } else {
        Err(format!(
            "Invalid keychain service '{}': expected june_provider_<provider>_api_key",
            service
        ))
    }
}

#[tauri::command]
pub async fn set_api_key(service: String, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_api_key_inner(service, key))
        .await
        .map_err(|e| e.to_string())?
}

fn set_api_key_inner(service: String, key: String) -> Result<(), String> {
    validate_service_name(&service)?;
    let entry = Entry::new(&service, KEYCHAIN_USER).map_err(|e| e.to_string())?;
    entry.set_password(&key).map_err(|e| e.to_string())
}

// NOTE: there is intentionally no `get_api_key` Tauri command. Secrets are read only in Rust
// (e.g. when a provider call is made) via `get_api_key_inner`; the renderer uses `has_api_key` so
// a raw key never crosses the IPC boundary.
#[allow(dead_code)] // wired up once a provider call site needs it (Phase 3+)
pub(crate) fn get_api_key_inner(service: String) -> Result<String, String> {
    let entry = Entry::new(&service, KEYCHAIN_USER).map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| e.to_string())
}

/// Read a key, distinguishing "no key set" (`Ok(None)`) from an actual keychain
/// failure (`Err`) - unlike `get_api_key_inner`, whose callers `.unwrap_or_default()`
/// a broken/locked keychain into an empty string indistinguishable from no key
/// (2.8). `Ok(Some(key))` when a key is stored.
pub(crate) fn get_api_key_opt(service: String) -> Result<Option<String>, String> {
    let entry = Entry::new(&service, KEYCHAIN_USER).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(k) => Ok(Some(k)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Async wrappers (7.8c): the keyring OS call BLOCKS, so callers on the tokio
/// runtime (stt/tts/diagnostics probes) must read the key off a blocking pool rather
/// than stalling an async worker on the credential store. Same result as the sync
/// pair, just moved off the runtime.
pub(crate) async fn get_api_key_async(service: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || get_api_key_inner(service))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) async fn get_api_key_opt_async(service: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || get_api_key_opt(service))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn has_api_key(service: String) -> Result<bool, String> {
    validate_service_name(&service)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entry = Entry::new(&service, KEYCHAIN_USER).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(_) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_api_key(service: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_service_name(&service)?;
        let entry = Entry::new(&service, KEYCHAIN_USER).map_err(|e| e.to_string())?;
        match entry.delete_password() {
            Ok(_) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::validate_service_name;

    #[test]
    fn accepts_provider_convention_services() {
        for s in [
            "june_provider_claude_api_key",
            "june_provider_openai_api_key",
            "june_provider_deepgram_api_key",
            "june_provider_a1_b2_api_key",
        ] {
            assert!(validate_service_name(s).is_ok(), "{s} should be accepted");
        }
    }

    #[test]
    fn rejects_arbitrary_services() {
        for s in [
            "openai_api_key",
            "june_provider__api_key",
            "june_provider_UPPER_api_key",
            "june_provider_a b_api_key",
            "some_other_apps_secret",
            "",
        ] {
            assert!(validate_service_name(s).is_err(), "{s:?} should be rejected");
        }
    }
}
