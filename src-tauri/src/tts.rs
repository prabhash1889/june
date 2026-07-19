// Text-to-speech (PLAN.md Phase 5, §3). The `TtsProvider` seam mirrors the
// `SttProvider`/`Brain` seams: one trait, one committed impl now (OpenAI, cloud),
// local Kokoro a later impl of the same trait - never a new call path (exactly
// how Phase 4 committed OpenAI Whisper and left faster-whisper for Phase 7).
//
// Same reason the STT call lives in Rust: the OpenAI key is read from the OS
// keychain here and never crosses IPC. The webview sends text down and gets back
// encoded audio bytes it just plays - the secret stays on this side.

use std::time::Duration;

use crate::keychain::get_api_key_inner;

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
        let key = get_api_key_inner(OPENAI_KEY_SERVICE.to_string())
            .map_err(|_| "No OpenAI API key set. Add one in June's settings.".to_string())?;
        if key.trim().is_empty() {
            return Err("The OpenAI API key is empty. Set it in June's settings.".to_string());
        }

        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;

        let resp = client
            .post(SPEECH_URL)
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

/// Synthesize one chunk of June's reply to mp3 bytes. Empty text is a no-op
/// (`Ok(vec![])`) so the caller can enqueue freely without guarding every chunk.
#[tauri::command]
pub async fn synthesize(
    text: String,
    voice: Option<String>,
    model: Option<String>,
) -> Result<Vec<u8>, String> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    OpenAiTts::new(voice, model).synthesize(&text).await
}

#[cfg(test)]
mod tests {
    use super::{OpenAiTts, DEFAULT_MODEL, DEFAULT_VOICE};

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
