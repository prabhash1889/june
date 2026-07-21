// Shared HTTP client (3.1). STT, TTS and diagnostics each built a fresh
// `reqwest::Client` per call - a new connection pool + TLS handshake on both
// voice legs of every turn. One process-wide client, reused; callers set their
// own total timeout per request with `RequestBuilder::timeout`. A short connect
// timeout is baked in so a stalled connection surfaces fast on the voice path.

use std::sync::OnceLock;
use std::time::Duration;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Connect timeout common to every call. Per-request total timeouts differ (STT
/// 15s, TTS 30s, diagnostics 2s) and are set at each call site via `.timeout(..)`.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// The process-wide reqwest client. Built once, lazily, and reused. Build only
/// fails on a broken TLS backend, which is unreachable in a shipped bundle, so a
/// panic here is a startup invariant rather than a runtime error path.
pub fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .expect("failed to build shared reqwest client")
    })
}
