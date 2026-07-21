use keyring::Entry;
use tauri::{AppHandle, Emitter};

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
pub async fn set_api_key(app: AppHandle, service: String, key: String) -> Result<(), String> {
    let svc = service.clone();
    tauri::async_runtime::spawn_blocking(move || set_api_key_inner(service, key))
        .await
        .map_err(|e| e.to_string())??;
    // 7.12: tell both windows a key changed (the app shows a confirmation toast; the
    // widget can re-check its key gate). No secret rides in the payload.
    let _ = app.emit(
        "keychain://changed",
        serde_json::json!({ "service": svc, "action": "set" }),
    );
    Ok(())
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

// --- MCP server secrets (keychain-backed env vars / HTTP headers) --------------
// Custom MCP servers need tokens (GITHUB_PERSONAL_ACCESS_TOKEN, Authorization
// headers). Those used to sit in plaintext in settings.json; now the value lives
// in the OS keychain and settings.json holds only the sentinel `keychain:`
// (mcp-servers.ts KEYCHAIN_REF). Service name: `june_mcp::<id>::<env|hdr>::<KEY>`
// - deterministic so the renderer's set/delete and the resident-spawn rehydration
// (agent_runner::mcp_servers_env) agree without a raw service string crossing IPC.

/// Sentinel a settings.json env/header value carries when its secret is in the
/// keychain. Must match mcp-servers.ts KEYCHAIN_REF.
pub(crate) const MCP_SENTINEL: &str = "keychain:";

fn mcp_service(server_id: &str, kind: &str, key: &str) -> String {
    format!("june_mcp::{server_id}::{kind}::{key}")
}

/// Validate the parts the renderer supplies before they become a keychain service
/// name. `server_id` is a slug (as coerced by mcp-servers.ts), `kind` is env/hdr,
/// `key` is an env-var / header name. Rejecting here keeps the renderer from
/// writing arbitrary keychain entries via these commands.
fn validate_mcp_parts(server_id: &str, kind: &str, key: &str) -> Result<(), String> {
    let slug_ok = !server_id.is_empty()
        && server_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    let kind_ok = kind == "env" || kind == "hdr";
    let key_ok = !key.is_empty()
        && key.len() <= 128
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    if slug_ok && kind_ok && key_ok {
        Ok(())
    } else {
        Err(format!(
            "Invalid MCP secret target (server '{server_id}', kind '{kind}', key '{key}')."
        ))
    }
}

/// MCP secret mutations only happen in the full Settings window. Deny them from the
/// widget or any other webview (least privilege, same stance as delete_api_key).
fn require_app_window(window: &tauri::Window) -> Result<(), String> {
    if window.label() == "app" {
        Ok(())
    } else {
        Err("Editing server secrets is only available from the Settings window.".into())
    }
}

/// Read one MCP secret for resident-spawn rehydration. Returns None for a missing
/// entry OR a broken/locked keychain - the caller substitutes an empty value, so a
/// stale sentinel never leaks the literal "keychain:" to the child as a token.
pub(crate) fn get_mcp_secret(server_id: &str, kind: &str, key: &str) -> Option<String> {
    get_api_key_opt(mcp_service(server_id, kind, key))
        .ok()
        .flatten()
}

#[tauri::command]
pub async fn set_mcp_secret(
    app: AppHandle,
    window: tauri::Window,
    server_id: String,
    kind: String,
    key: String,
    value: String,
) -> Result<(), String> {
    require_app_window(&window)?;
    validate_mcp_parts(&server_id, &kind, &key)?;
    let svc = mcp_service(&server_id, &kind, &key);
    tauri::async_runtime::spawn_blocking(move || {
        let entry = Entry::new(&svc, KEYCHAIN_USER).map_err(|e| e.to_string())?;
        entry.set_password(&value).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit(
        "keychain://changed",
        serde_json::json!({ "scope": "mcp", "action": "set" }),
    );
    Ok(())
}

#[tauri::command]
pub async fn delete_mcp_secret(
    app: AppHandle,
    window: tauri::Window,
    server_id: String,
    kind: String,
    key: String,
) -> Result<(), String> {
    require_app_window(&window)?;
    validate_mcp_parts(&server_id, &kind, &key)?;
    let svc = mcp_service(&server_id, &kind, &key);
    tauri::async_runtime::spawn_blocking(move || {
        let entry = Entry::new(&svc, KEYCHAIN_USER).map_err(|e| e.to_string())?;
        match entry.delete_password() {
            Ok(_) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit(
        "keychain://changed",
        serde_json::json!({ "scope": "mcp", "action": "deleted" }),
    );
    Ok(())
}

#[tauri::command]
pub async fn delete_api_key(
    app: AppHandle,
    window: tauri::Window,
    service: String,
) -> Result<(), String> {
    // 7.12: deletion is destructive and only the full Settings window (label "app")
    // ever needs it - the widget only ever ADDS a key via its onboarding gate. Deny
    // deletion from any other webview (least privilege).
    if window.label() != "app" {
        return Err("Deleting keys is only available from the Settings window.".into());
    }
    let svc = service.clone();
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
    .map_err(|e| e.to_string())??;
    let _ = app.emit(
        "keychain://changed",
        serde_json::json!({ "service": svc, "action": "deleted" }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{mcp_service, validate_mcp_parts, validate_service_name};

    #[test]
    fn mcp_service_name_is_deterministic() {
        assert_eq!(
            mcp_service("github", "env", "GITHUB_PERSONAL_ACCESS_TOKEN"),
            "june_mcp::github::env::GITHUB_PERSONAL_ACCESS_TOKEN"
        );
        assert_eq!(
            mcp_service("my-server", "hdr", "Authorization"),
            "june_mcp::my-server::hdr::Authorization"
        );
    }

    #[test]
    fn accepts_valid_mcp_parts() {
        assert!(validate_mcp_parts("github", "env", "GITHUB_TOKEN").is_ok());
        assert!(validate_mcp_parts("brave-search", "env", "BRAVE_API_KEY").is_ok());
        assert!(validate_mcp_parts("srv", "hdr", "X-Api-Key").is_ok());
        assert!(validate_mcp_parts("s1", "hdr", "Authorization").is_ok());
    }

    #[test]
    fn rejects_bad_mcp_parts() {
        // Bad slug (would let a renderer target another app's namespace via ::).
        assert!(validate_mcp_parts("UPPER", "env", "K").is_err());
        assert!(validate_mcp_parts("has space", "env", "K").is_err());
        assert!(validate_mcp_parts("has::colons", "env", "K").is_err());
        assert!(validate_mcp_parts("", "env", "K").is_err());
        // Bad kind.
        assert!(validate_mcp_parts("srv", "other", "K").is_err());
        // Bad key (separators that could break out of the service name).
        assert!(validate_mcp_parts("srv", "env", "").is_err());
        assert!(validate_mcp_parts("srv", "env", "has space").is_err());
        assert!(validate_mcp_parts("srv", "env", "has::colon").is_err());
    }

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
