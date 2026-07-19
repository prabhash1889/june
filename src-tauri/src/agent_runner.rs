// Feeds an accepted transcript to the agent core (PLAN.md Phase 4 exit:
// "transcription feed the agent"). Rather than re-implement the Node agent loop
// in Rust, this spawns the existing core through agent/run-once.ts and returns
// June's final reply - the core is reused verbatim, only the surface differs.
//
// ponytail: dev-time invocation via `npx tsx`, matching how the Phase 1-3
// harnesses already run. Packaging the Node core as a bundled sidecar binary is
// Phase 9 hardening, not a Phase 4 concern. Approvals are fail-closed in
// run-once.ts (gated actions denied until the Phase 6 approval UI exists), so
// this returns June's reply without needing an interactive gate here.

use std::path::PathBuf;
use std::process::Command;

/// Absolute path to agent/run-once.ts, resolved from this crate at compile time
/// (`<repo>/src-tauri` -> `<repo>/agent/run-once.ts`).
fn run_once_script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|repo| repo.join("agent").join("run-once.ts"))
        .unwrap_or_else(|| PathBuf::from("agent/run-once.ts"))
}

/// Run one agent turn from the given transcript and return June's spoken-style
/// reply. Errors (spawn failure, non-zero exit with no final line) come back as
/// `Err` so the UI can surface them instead of pretending success.
#[tauri::command]
pub async fn run_agent(transcript: String) -> Result<String, String> {
    let transcript = transcript.trim().to_string();
    if transcript.is_empty() {
        return Err("Nothing to send: the transcript was empty.".to_string());
    }

    let script = run_once_script();
    let cwd = script
        .parent()
        .and_then(|agent_dir| agent_dir.parent())
        .map(|p| p.to_path_buf())
        .ok_or("Could not locate the June project root.")?;

    // Blocking child process off the async runtime (Tauri has no tokio "process"
    // feature enabled). The agent turn can take tens of seconds.
    let output = tauri::async_runtime::spawn_blocking(move || {
        // On Windows `npx` is a .cmd shim that can't be exec'd directly, so go
        // through the shell. Elsewhere invoke npx directly.
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.arg("/C").arg("npx");
            c
        } else {
            Command::new("npx")
        };
        cmd.arg("tsx")
            .arg(&script)
            .arg(&transcript)
            .current_dir(&cwd)
            .output()
    })
    .await
    .map_err(|e| format!("Agent task failed: {e}"))?
    .map_err(|e| format!("Could not start the agent: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    // run-once.ts emits JSONL; the reply is the last {"t":"final",...} line.
    let final_line = stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .filter(|v| v.get("t").and_then(|t| t.as_str()) == Some("final"));

    match final_line {
        Some(v) => Ok(v
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string()),
        None => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!(
                "The agent produced no reply. {}",
                stderr.trim()
            ))
        }
    }
}
