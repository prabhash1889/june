import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { hasOpenAiKey, runAgent, setOpenAiKey, transcribe } from "../lib/stt.ts";
import { startCapture, type CaptureError, type CaptureHandle } from "../lib/voice-capture.ts";

// The Phase 4 voice surface: hold Ctrl+Shift+Space (or click the orb), speak,
// review the transcript, then it feeds the agent. Nothing is sent to the agent
// until the transcript is explicitly accepted (PLAN.md Phase 4 + §5: voice
// removes the "read before you click" safety net).

type Phase =
  | { s: "need-key" }
  | { s: "idle" }
  | { s: "listening" }
  | { s: "transcribing" }
  | { s: "review"; transcript: string }
  | { s: "thinking" }
  | { s: "reply"; text: string }
  | { s: "error"; message: string };

const MAX_CAPTURE_MS = 15_000;

export function VoicePanel() {
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const [level, setLevel] = useState(0);
  const capture = useRef<CaptureHandle | null>(null);
  // Guard the async stop path so a hotkey-up and a VAD endpoint can't both fire it.
  const stopping = useRef(false);

  // Prompt for the OpenAI key up front if it's missing - transcription can't work
  // without it, and this keeps the failure actionable instead of a mid-flow 401.
  useEffect(() => {
    void hasOpenAiKey().then((has) => {
      if (!has) setPhase({ s: "need-key" });
    });
  }, []);

  const beginTranscribe = useCallback(async () => {
    const handle = capture.current;
    capture.current = null;
    if (!handle) return;
    setPhase({ s: "transcribing" });
    try {
      const { audio, mime } = await handle.stop();
      if (audio.length === 0) {
        setPhase({ s: "error", message: "I didn't catch any audio. Try again." });
        return;
      }
      const text = await transcribe(audio, mime);
      if (!text.trim()) {
        setPhase({ s: "error", message: "I didn't hear a command. Try again." });
        return;
      }
      setPhase({ s: "review", transcript: text });
    } catch (e) {
      setPhase({ s: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const stopListening = useCallback(() => {
    if (stopping.current) return;
    stopping.current = true;
    void beginTranscribe();
  }, [beginTranscribe]);

  const startListening = useCallback(async () => {
    setLevel(0);
    stopping.current = false;
    try {
      capture.current = await startCapture({ onEndpoint: () => stopListening(), maxMs: MAX_CAPTURE_MS });
      setPhase({ s: "listening" });
    } catch (e) {
      const err = e as CaptureError;
      setPhase({ s: "error", message: err?.message ?? "Could not start the microphone." });
    }
  }, [stopListening]);

  // Poll the input level while listening so the meter animates.
  useEffect(() => {
    if (phase.s !== "listening") return;
    const id = window.setInterval(() => setLevel(capture.current?.level() ?? 0), 100);
    return () => window.clearInterval(id);
  }, [phase.s]);

  // Global push-to-talk: Rust emits ptt://down on key press, ptt://up on release.
  // Use refs via state closures - listeners are attached once.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  useEffect(() => {
    const canStart = () => ["idle", "reply", "error"].includes(phaseRef.current.s);
    const unlistenDown = listen("ptt://down", () => {
      if (canStart()) void startListening();
    });
    const unlistenUp = listen("ptt://up", () => {
      if (phaseRef.current.s === "listening") stopListening();
    });
    return () => {
      void unlistenDown.then((f) => f());
      void unlistenUp.then((f) => f());
    };
  }, [startListening, stopListening]);

  const accept = useCallback(async (transcript: string) => {
    setPhase({ s: "thinking" });
    try {
      const reply = await runAgent(transcript);
      setPhase({ s: "reply", text: reply });
    } catch (e) {
      setPhase({ s: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const cancel = useCallback(() => {
    capture.current?.cancel();
    capture.current = null;
    setPhase({ s: "idle" });
  }, []);

  if (phase.s === "need-key") return <KeyGate onSaved={() => setPhase({ s: "idle" })} />;

  return (
    <div className="voice">
      <button
        className={`orb ${phase.s === "listening" ? "listening" : ""}`}
        style={phase.s === "listening" ? { transform: `scale(${1 + Math.min(level * 6, 0.6)})` } : undefined}
        disabled={phase.s === "transcribing" || phase.s === "thinking"}
        onMouseDown={() => {
          if (["idle", "reply", "error"].includes(phase.s)) void startListening();
        }}
        onMouseUp={() => {
          if (phase.s === "listening") stopListening();
        }}
        aria-label="Push to talk"
      />
      <Status phase={phase} />
      {phase.s === "review" && (
        <ReviewCard transcript={phase.transcript} onAccept={accept} onCancel={cancel} onRedo={() => void startListening()} />
      )}
      {phase.s === "reply" && <p className="reply">{phase.text}</p>}
      {phase.s === "error" && <p className="err">{phase.message}</p>}
    </div>
  );
}

function Status({ phase }: { phase: Phase }) {
  const text: Record<Phase["s"], string> = {
    "need-key": "",
    idle: "Hold Ctrl + Shift + Space, or click the orb, and speak.",
    listening: "Listening…",
    transcribing: "Transcribing…",
    review: "Is this right?",
    thinking: "Working on it…",
    reply: "",
    error: "",
  };
  return <p className="status">{text[phase.s]}</p>;
}

function ReviewCard({
  transcript,
  onAccept,
  onCancel,
  onRedo,
}: {
  transcript: string;
  onAccept: (t: string) => void;
  onCancel: () => void;
  onRedo: () => void;
}) {
  const [text, setText] = useState(transcript);
  return (
    <div className="review">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
      <div className="row">
        <button className="primary" disabled={!text.trim()} onClick={() => onAccept(text.trim())}>
          Send to June
        </button>
        <button onClick={onRedo}>Re-record</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function KeyGate({ onSaved }: { onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="voice keygate">
      <p className="status">Add an OpenAI API key to enable speech. It's stored in your OS keychain.</p>
      <input type="password" placeholder="sk-…" value={key} onChange={(e) => setKey(e.target.value)} />
      <button
        className="primary"
        disabled={!key.trim() || saving}
        onClick={() => {
          setSaving(true);
          setErr(null);
          setOpenAiKey(key.trim())
            .then(onSaved)
            .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
            .finally(() => setSaving(false));
        }}
      >
        Save key
      </button>
      {err && <p className="err">{err}</p>}
    </div>
  );
}
