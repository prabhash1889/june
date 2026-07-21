// Text-to-speech (PLAN.md Phase 5, §3). The `TtsProvider` seam mirrors the
// `SttProvider`/`Brain` seams: one trait, one committed impl now (OpenAI, cloud),
// local Kokoro a later impl of the same trait - never a new call path (exactly
// how Phase 4 committed OpenAI Whisper and left faster-whisper for Phase 7).
//
// Same reason the STT call lives in Rust: the OpenAI key is read from the OS
// keychain here and never crosses IPC. The webview sends text down and gets back
// encoded audio bytes it just plays - the secret stays on this side.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use std::time::Duration;

use tokio::sync::Notify;

use crate::keychain::get_api_key_async;

const OPENAI_KEY_SERVICE: &str = "june_provider_openai_api_key";
const SPEECH_URL: &str = "https://api.openai.com/v1/audio/speech";
const DEFAULT_MODEL: &str = "tts-1"; // fast tier; tts-1-hd trades latency for quality
const DEFAULT_VOICE: &str = "alloy";
const VOICES: [&str; 6] = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const MODELS: [&str; 2] = ["tts-1", "tts-1-hd"];
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// One synthesis backend. `text` is a single chunk (June streams a sentence at a
/// time). Returns encoded audio bytes (mp3) the webview can play as-is, or a
/// human-readable error surfaced to the UI.
trait TtsProvider {
    async fn synthesize(&self, text: &str) -> Result<Vec<u8>, String>;
}

/// Cloud default: OpenAI TTS. Reuses the same keychain key as STT, so an
/// empty/missing key is a clear, actionable error rather than an opaque 401. The
/// user's chosen voice/model (§4 Voice) are validated against the known sets, so
/// a bad settings value falls back rather than sending a rejected request.
struct OpenAiTts {
    voice: String,
    model: String,
}

impl OpenAiTts {
    fn new(voice: Option<String>, model: Option<String>) -> Self {
        let pick = |val: Option<String>, allowed: &[&str], default: &str| {
            val.filter(|v| allowed.contains(&v.as_str()))
                .unwrap_or_else(|| default.to_string())
        };
        OpenAiTts {
            voice: pick(voice, &VOICES, DEFAULT_VOICE),
            model: pick(model, &MODELS, DEFAULT_MODEL),
        }
    }
}

impl TtsProvider for OpenAiTts {
    async fn synthesize(&self, text: &str) -> Result<Vec<u8>, String> {
        let key = get_api_key_async(OPENAI_KEY_SERVICE.to_string())
            .await
            .map_err(|_| "No OpenAI API key set. Add one in June's settings.".to_string())?;
        if key.trim().is_empty() {
            return Err("The OpenAI API key is empty. Set it in June's settings.".to_string());
        }

        let resp = crate::http::client()
            .post(SPEECH_URL)
            .timeout(REQUEST_TIMEOUT)
            .bearer_auth(key)
            .json(&serde_json::json!({
                "model": self.model,
                "voice": self.voice,
                "input": text,
                "response_format": "mp3",
            }))
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    "Speech timed out. Check your connection and try again.".to_string()
                } else {
                    format!("Could not reach the speech service: {e}")
                }
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Speech failed ({status}): {}", body.trim()));
        }

        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        Ok(bytes.to_vec())
    }
}

/// Barge-in cancellation registry (3.11). Each `SpeechQueue` on the webview owns a
/// token; every synthesis it starts registers under that token here. `stop()` calls
/// `cancel_synthesis(token)`, which wakes exactly that queue's in-flight synths so
/// they drop the network read and free the tokio task the next capture's STT wants -
/// instead of finishing an mp3 no one will hear. A per-token refcount reaps the entry
/// when its last synth ends, so the map never grows across a session. Scoping to the
/// token (not a global signal) matters: the "On it" backchannel is stopped the instant
/// the real reply starts speaking, and a global cancel would kill the reply's own
/// still-in-flight sentences.
type CancelReg = Mutex<HashMap<u64, (Arc<Notify>, usize)>>;

fn cancel_registry() -> &'static CancelReg {
    static R: OnceLock<CancelReg> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register one in-flight synth under `token`, returning the shared Notify to race.
fn acquire_cancel(token: u64) -> Arc<Notify> {
    let mut m = cancel_registry().lock();
    let entry = m.entry(token).or_insert_with(|| (Arc::new(Notify::new()), 0));
    entry.1 += 1;
    entry.0.clone()
}

/// Drop one in-flight synth; reap the token's entry once its last synth is done.
fn release_cancel(token: u64) {
    let mut m = cancel_registry().lock();
    if let Some(entry) = m.get_mut(&token) {
        entry.1 -= 1;
        if entry.1 == 0 {
            m.remove(&token);
        }
    }
}

/// Wake every synth registered under `token` (barge-in). No-op if the token has no
/// in-flight synths, so a late/duplicate stop is harmless.
#[tauri::command]
pub fn cancel_synthesis(token: u64) {
    if let Some(entry) = cancel_registry().lock().get(&token) {
        entry.0.notify_waiters();
    }
}

/// Synthesize one chunk of June's reply to mp3 bytes. Empty text is a no-op
/// (`Ok(vec![])`) so the caller can enqueue freely without guarding every chunk.
/// `cancel_token` (0/absent = uncancelable) ties this synth to a `SpeechQueue` so a
/// barge-in can abort it mid-flight (3.11).
#[tauri::command]
pub async fn synthesize(
    app: tauri::AppHandle,
    text: String,
    voice: Option<String>,
    model: Option<String>,
    cancel_token: Option<u64>,
) -> Result<Vec<u8>, String> {
    // Privacy at the execution boundary (10.3): refuse cloud TTS under an
    // on-device mode here in Rust, so June's reply text never leaves the machine
    // even if the webview asks. This is the only cloud TTS provider today.
    if crate::settings::cloud_voice_blocked(&app) {
        return Err(
            "Voice is off in your current privacy mode - cloud speech is blocked.".to_string(),
        );
    }
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let provider = OpenAiTts::new(voice, model);
    let token = cancel_token.unwrap_or(0);
    if token == 0 {
        return provider.synthesize(&text).await;
    }
    // Race the synth against a barge-in on this token. `biased` polls the cancel
    // branch first so its waiter is registered before the request runs; on cancel
    // the request future is dropped, ending the network read at once.
    let notify = acquire_cancel(token);
    let work = provider.synthesize(&text);
    tokio::pin!(work);
    let result = tokio::select! {
        biased;
        _ = notify.notified() => Err("Speech cancelled.".to_string()),
        res = &mut work => res,
    };
    release_cancel(token);
    result
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_cancel, cancel_registry, release_cancel, OpenAiTts, DEFAULT_MODEL, DEFAULT_VOICE,
    };

    #[test]
    fn cancel_registry_reaps_a_token_when_its_last_synth_ends() {
        let token = 0xC0FFEE;
        let a = acquire_cancel(token);
        let b = acquire_cancel(token); // two sentences share one queue's token
        assert!(std::sync::Arc::ptr_eq(&a, &b), "same token shares one Notify");
        assert!(cancel_registry().lock().contains_key(&token));
        release_cancel(token);
        assert!(
            cancel_registry().lock().contains_key(&token),
            "one synth still in flight keeps the entry"
        );
        release_cancel(token);
        assert!(
            !cancel_registry().lock().contains_key(&token),
            "entry reaped once the last synth releases"
        );
        release_cancel(token); // extra release is harmless (late/duplicate stop)
    }

    #[test]
    fn validates_voice_and_model_falling_back_on_bad_input() {
        let ok = OpenAiTts::new(Some("nova".into()), Some("tts-1-hd".into()));
        assert_eq!(ok.voice, "nova");
        assert_eq!(ok.model, "tts-1-hd");

        // Unknown values fall back to the defaults rather than reaching the API.
        let bad = OpenAiTts::new(Some("robot".into()), Some("tts-9".into()));
        assert_eq!(bad.voice, DEFAULT_VOICE);
        assert_eq!(bad.model, DEFAULT_MODEL);

        let none = OpenAiTts::new(None, None);
        assert_eq!(none.voice, DEFAULT_VOICE);
        assert_eq!(none.model, DEFAULT_MODEL);
    }
}
