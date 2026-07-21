// Speech-to-text (PLAN.md Phase 4, §3). The `SttProvider` seam mirrors the
// `Brain` seam on the agent side: one trait, one committed impl now (OpenAI
// Whisper, cloud), local faster-whisper a later impl - never a new call path.
//
// The transcription call lives in Rust on purpose: the API key is read from the
// OS keychain here and never crosses the IPC boundary to the webview (the same
// rule keychain.rs was built for). The webview captures mic audio and hands the
// raw bytes down; Rust adds the secret and returns only text.

use std::time::Duration;

use crate::keychain::get_api_key_inner;

const OPENAI_KEY_SERVICE: &str = "june_provider_openai_api_key";
const WHISPER_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
const WHISPER_MODEL: &str = "whisper-1";
// Voice UX: fail fast. A stalled connection (VPN hiccup) must surface as an
// error in seconds, not pin the UI in "Transcribing…" for half a minute. The
// connect timeout is baked into the shared client (http.rs); this is the total.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// One transcription backend. `audio` is a complete encoded clip (e.g. webm/opus
/// straight from the browser MediaRecorder); `mime` is its content type. Returns
/// the plain transcript, or a human-readable error string (surfaced to the UI).
trait SttProvider {
    async fn transcribe(&self, audio: Vec<u8>, mime: &str) -> Result<String, String>;
}

/// Cloud default: OpenAI Whisper. Key comes from the keychain, so an empty/missing
/// key is reported as a clear, actionable error rather than an opaque 401.
struct OpenAiStt;

impl SttProvider for OpenAiStt {
    async fn transcribe(&self, audio: Vec<u8>, mime: &str) -> Result<String, String> {
        let key = get_api_key_inner(OPENAI_KEY_SERVICE.to_string())
            .map_err(|_| "No OpenAI API key set. Add one in June's settings.".to_string())?;
        if key.trim().is_empty() {
            return Err("The OpenAI API key is empty. Set it in June's settings.".to_string());
        }

        let filename = filename_for(mime);
        let part = reqwest::multipart::Part::bytes(audio)
            .file_name(filename)
            .mime_str(mime)
            .map_err(|e| format!("Bad audio content type '{mime}': {e}"))?;
        let form = reqwest::multipart::Form::new()
            .text("model", WHISPER_MODEL)
            .part("file", part);

        let resp = crate::http::client()
            .post(WHISPER_URL)
            .timeout(REQUEST_TIMEOUT)
            .bearer_auth(key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    "Transcription timed out. Check your connection and try again.".to_string()
                } else {
                    format!("Could not reach the transcription service: {e}")
                }
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Transcription failed ({status}): {}", body.trim()));
        }

        let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let text = json
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        Ok(text)
    }
}

/// Whisper keys off the file extension for format detection, so give it one that
/// matches the browser's chosen container. Defaults to webm (WebView2/Chromium).
fn filename_for(mime: &str) -> &'static str {
    let base = mime.split(';').next().unwrap_or("").trim();
    match base {
        "audio/ogg" => "audio.ogg",
        "audio/mp4" => "audio.mp4",
        "audio/mpeg" | "audio/mp3" => "audio.mp3", // mpeg is .mp3, not .mp4 (10.8)
        "audio/wav" | "audio/x-wav" => "audio.wav",
        _ => "audio.webm",
    }
}

/// Transcribe a captured clip. The empty-transcript case is a first-class result,
/// not an error: silence or an unintelligible clip returns `Ok("")` and the UI
/// asks the user to try again rather than feeding an empty command to the agent.
#[tauri::command]
pub async fn transcribe(
    app: tauri::AppHandle,
    audio: Vec<u8>,
    mime: String,
) -> Result<String, String> {
    // Privacy at the execution boundary (10.3): refuse cloud STT under an
    // on-device mode here in Rust, not just in the UI, so audio never leaves the
    // machine even if the webview asks. This is the only cloud STT provider today.
    if crate::settings::cloud_voice_blocked(&app) {
        return Err(
            "Voice is off in your current privacy mode - cloud transcription is blocked."
                .to_string(),
        );
    }
    if audio.is_empty() {
        return Err("No audio was captured.".to_string());
    }
    OpenAiStt.transcribe(audio, &mime).await
}

#[cfg(test)]
mod tests {
    use super::filename_for;

    #[test]
    fn maps_mime_to_whisper_friendly_extension() {
        assert_eq!(filename_for("audio/webm;codecs=opus"), "audio.webm");
        assert_eq!(filename_for("audio/ogg;codecs=opus"), "audio.ogg");
        assert_eq!(filename_for("audio/mp4"), "audio.mp4");
        assert_eq!(filename_for("audio/mpeg"), "audio.mp3");
        assert_eq!(filename_for("audio/wav"), "audio.wav");
        assert_eq!(filename_for("something/unknown"), "audio.webm");
    }
}
