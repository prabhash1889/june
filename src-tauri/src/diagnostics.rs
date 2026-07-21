// Diagnostics (PLAN.md §4, Phase 7). A read-only health probe of the saple-bridge
// control endpoint, surfaced in the app's Diagnostics section so the user can see
// whether June's one committed capability is reachable before issuing commands.
//
// This reads the same discovery record the MCP server does
// (mcp/saple-bridge-control/bridge.ts) and hits /capabilities with its token. It
// is intentionally a small independent probe rather than spawning the MCP server
// just to health-check it - a stalled bridge must surface in seconds.

use std::path::PathBuf;
use std::time::Duration;

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(serde::Serialize)]
pub struct BridgeHealth {
    /// A discovery record was found on disk.
    found: bool,
    /// The endpoint answered /capabilities successfully.
    healthy: bool,
    version: String,
    endpoint: String,
    /// Human-readable reason when not healthy (missing record, refused, etc.).
    detail: String,
}

impl BridgeHealth {
    fn miss(detail: impl Into<String>) -> Self {
        BridgeHealth {
            found: false,
            healthy: false,
            version: String::new(),
            endpoint: String::new(),
            detail: detail.into(),
        }
    }
}

/// `%APPDATA%\ai.saple.bridge\june-control.json` on Windows,
/// `~/.config/ai.saple.bridge/june-control.json` elsewhere - kept in lockstep
/// with bridge's `config_dir()` and the MCP server's `discoveryPath()`.
fn discovery_path() -> Option<PathBuf> {
    let dir = if cfg!(windows) {
        PathBuf::from(std::env::var("APPDATA").ok()?)
    } else {
        PathBuf::from(std::env::var("HOME").ok()?).join(".config")
    };
    Some(dir.join("ai.saple.bridge").join("june-control.json"))
}

/// Probe bridge liveness for the Diagnostics panel. Never errors - every failure
/// mode is reported as an unhealthy `BridgeHealth` with a reason.
#[tauri::command]
pub async fn bridge_health() -> BridgeHealth {
    let Some(path) = discovery_path() else {
        return BridgeHealth::miss("Could not locate the bridge discovery directory.");
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => {
            return BridgeHealth::miss(
                "No bridge discovery record. Is saple-bridge running with \"June Voice Control\" enabled?",
            );
        }
    };
    let record: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return BridgeHealth::miss("The bridge discovery record is corrupt."),
    };
    let endpoint = record.get("endpoint").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let token = record.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let version = record.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if endpoint.is_empty() {
        return BridgeHealth::miss("The bridge discovery record has no endpoint.");
    }

    match crate::http::client()
        .get(format!("{endpoint}/capabilities"))
        .timeout(PROBE_TIMEOUT)
        .bearer_auth(&token)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => BridgeHealth {
            found: true,
            healthy: true,
            version,
            endpoint,
            detail: "Bridge is reachable.".to_string(),
        },
        Ok(resp) => BridgeHealth {
            found: true,
            healthy: false,
            version,
            endpoint,
            detail: format!("Bridge answered HTTP {} (stale token? restart June control).", resp.status()),
        },
        Err(_) => BridgeHealth {
            found: true,
            healthy: false,
            version,
            endpoint,
            detail: "Found a discovery record, but the bridge endpoint did not respond.".to_string(),
        },
    }
}

/// Result of a per-stage "test" button (§4: "test button per stage"). `ms` is
/// the round-trip latency, which also feeds the Diagnostics latency breakdown.
#[derive(serde::Serialize)]
pub struct ProbeResult {
    ok: bool,
    detail: String,
    ms: u64,
}

/// The keychain service name holding this provider's API key, or "" for a local
/// provider (ollama / lmstudio) that needs none. Pure, so the mapping is tested.
fn key_service_for(provider: &str) -> &'static str {
    match provider {
        "claude" => "june_provider_anthropic_api_key",
        "openai" => "june_provider_openai_api_key",
        "gemini" => "june_provider_google_api_key",
        "custom" => "june_provider_custom_api_key",
        _ => "", // ollama / lmstudio: local, no key
    }
}

/// Turn a keychain read into the key to probe with, or a probe-failure reason
/// (2.8). `Ok(None)` (no key set) is a legitimate empty key - Claude falls back to
/// local sign-in; `Err` is a broken/locked keychain and must NOT read as "no key".
/// Pure, so the "broken keychain is not an empty key" rule is unit-tested.
fn resolve_key(read: Result<Option<String>, String>) -> Result<String, String> {
    match read {
        Ok(Some(k)) => Ok(k),
        Ok(None) => Ok(String::new()),
        Err(e) => Err(format!("Could not read the API key from the keychain: {e}")),
    }
}

/// Verify the selected brain is reachable and authenticated, cheaply (a GET
/// /models probe - no tokens spent). The key is read from the OS keychain HERE
/// so it never crosses IPC; the webview only passes the non-secret provider id
/// and base URL (resolved from its registry). Claude with no key falls back to
/// the SDK's local sign-in, which this can't cheaply verify, so it reports that
/// honestly rather than claiming success.
#[tauri::command]
pub async fn test_brain(provider: String, base_url: String) -> ProbeResult {
    let started = std::time::Instant::now();
    let elapsed = |t: std::time::Instant| t.elapsed().as_millis() as u64;

    let key_service = key_service_for(&provider);
    // Distinguish a broken/locked keychain from "no key set" (2.8): the old
    // `.unwrap_or_default()` collapsed both to an empty string, so a keychain
    // failure masqueraded as "no key" and Claude then reported success (falls back
    // to local sign-in). A real read error now fails the probe with the reason.
    let key = if key_service.is_empty() {
        String::new()
    } else {
        match resolve_key(crate::keychain::get_api_key_opt(key_service.to_string())) {
            Ok(k) => k,
            Err(detail) => return ProbeResult { ok: false, detail, ms: elapsed(started) },
        }
    };

    let client = crate::http::client();

    let req = if provider == "claude" {
        if key.trim().is_empty() {
            return ProbeResult {
                ok: true,
                detail: "No Anthropic key set - June will use your local Claude sign-in. Run a command to fully verify.".to_string(),
                ms: elapsed(started),
            };
        }
        client
            .get("https://api.anthropic.com/v1/models")
            .header("x-api-key", key.trim())
            .header("anthropic-version", "2023-06-01")
    } else {
        if base_url.trim().is_empty() {
            return ProbeResult { ok: false, detail: "No endpoint set for this provider.".to_string(), ms: elapsed(started) };
        }
        let url = format!("{}/models", base_url.trim_end_matches('/'));
        let mut r = client.get(url);
        if !key.trim().is_empty() {
            r = r.bearer_auth(key.trim());
        }
        r
    };

    match req.timeout(PROBE_TIMEOUT).send().await {
        Ok(resp) if resp.status().is_success() => {
            ProbeResult { ok: true, detail: "Reachable and authenticated.".to_string(), ms: elapsed(started) }
        }
        Ok(resp) => {
            let status = resp.status();
            let hint = if status.as_u16() == 401 || status.as_u16() == 403 {
                " (check the API key)"
            } else {
                ""
            };
            ProbeResult { ok: false, detail: format!("Endpoint returned HTTP {status}{hint}."), ms: elapsed(started) }
        }
        Err(e) => {
            let detail = if e.is_timeout() {
                "The endpoint did not respond in time.".to_string()
            } else {
                format!("Could not reach the endpoint: {e}")
            };
            ProbeResult { ok: false, detail, ms: elapsed(started) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_service_maps_each_provider() {
        assert_eq!(key_service_for("claude"), "june_provider_anthropic_api_key");
        assert_eq!(key_service_for("openai"), "june_provider_openai_api_key");
        assert_eq!(key_service_for("gemini"), "june_provider_google_api_key");
        assert_eq!(key_service_for("custom"), "june_provider_custom_api_key");
        // Local providers (ollama/lmstudio) and anything unknown need no key.
        assert_eq!(key_service_for("ollama"), "");
        assert_eq!(key_service_for("whatever"), "");
    }

    #[test]
    fn resolve_key_passes_through_a_stored_key() {
        assert_eq!(resolve_key(Ok(Some("sk-123".into()))), Ok("sk-123".into()));
    }

    #[test]
    fn resolve_key_treats_no_entry_as_an_empty_key() {
        // `Ok(None)` = no key set: a legitimate empty key, not a failure.
        assert_eq!(resolve_key(Ok(None)), Ok(String::new()));
    }

    #[test]
    fn resolve_key_reports_a_broken_keychain_instead_of_masking_it() {
        // The whole point of 2.8: a keychain read error must NOT collapse to an
        // empty key (which would report success), but surface as a probe failure.
        let out = resolve_key(Err("keychain locked".into()));
        assert!(out.is_err());
        assert!(out.unwrap_err().contains("keychain locked"));
    }
}
