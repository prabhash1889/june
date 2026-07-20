import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { hasOpenAiKey, runAgent, setOpenAiKey, transcribe } from "../lib/stt.ts";
import { type Approval, cancelAgent, newConversation, openApp, usePendingApproval } from "../lib/session.ts";
import { DEFAULT_SETTINGS, type JuneSettings, loadSettings, voiceAllowed, voiceNeedsOpenAiKey } from "../lib/settings.ts";
import { recordLatency, TurnTimer } from "../lib/latency.ts";
import { SentenceBuffer, SpeechQueue } from "../lib/tts.ts";
import { startBargeMonitor, startCapture, type CaptureError, type CaptureHandle } from "../lib/voice-capture.ts";
import { startWakeListener } from "../lib/wake.ts";

// The voice surface: hold Ctrl+Shift+Space (or press the orb), speak, review the
// transcript, then June works and speaks the answer back (PLAN.md Phase 4 + 5).
// Nothing reaches the agent until the transcript is explicitly accepted (§5).
// Phase 5 adds the spoken round-trip: June streams the reply sentence-by-sentence
// (speaking before it finishes generating), and the user can barge in - by speech
// (echo-cancelled monitor mic) or by pressing to talk - to interrupt and start a
// new command. Barge-in only stops audio; it never re-runs a turn, so an
// interrupted command never executes twice.

type Phase =
  | { s: "need-key" }
  | { s: "idle" }
  | { s: "listening" }
  | { s: "transcribing" }
  | { s: "review"; transcript: string }
  | { s: "thinking" }
  | { s: "speaking"; text: string }
  | { s: "reply"; text: string }
  | { s: "error"; message: string };

const MAX_CAPTURE_MS = 15_000;
const WAVE_BARS = 28;

// `onActiveChange` lets the widget shell expand into a card while June is doing
// anything (and collapse back to a bare orb at rest) - the shell owns the window
// geometry, VoicePanel owns the pipeline (PLAN.md Phase 6 widget spec).
export function VoicePanel({ onActiveChange }: { onActiveChange?: (active: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const [levels, setLevels] = useState<number[]>([]);
  const { approval, decide } = usePendingApproval();
  const capture = useRef<CaptureHandle | null>(null);
  // Guard the async stop path so a hotkey-up and a VAD endpoint can't both fire it.
  const stopping = useRef(false);
  // Bumped to abandon an in-flight transcription (press-to-cancel, Cancel,
  // barge into a new capture) so a slow network can never lock the widget in
  // "Transcribing…" and a late result can't overwrite a newer state.
  const transcribeRef = useRef(0);

  // Streaming-speech state. `turn` tags each command so deltas/onIdle from a turn
  // that was barged in on are dropped. `spoke` guards the silent-reply case.
  const turnRef = useRef(0);
  const queueRef = useRef<SpeechQueue | null>(null);
  const splitterRef = useRef(new SentenceBuffer());
  const streamTextRef = useRef("");
  const replyRef = useRef("");
  const spokeRef = useRef(false);
  // Latency instrumentation (Phase 11.5): one timer per turn, marked across the
  // pipeline (capture-end -> transcript -> first token -> first audio). Held from
  // beginTranscribe through accept into the speech queue; dropped on cancel/barge.
  const timerRef = useRef<TurnTimer | null>(null);

  // The user's chosen voice stack (§4). Loaded once; a load failure (e.g. no
  // backend in tests) leaves the defaults, so the pipeline still works.
  const settingsRef = useRef<JuneSettings>(DEFAULT_SETTINGS);
  const voiceBlockedRef = useRef(false);
  const [voiceBlocked, setVoiceBlocked] = useState(false);
  // Wake config in state (not just the ref) so the hands-free listener effect
  // re-arms when settings load or the user toggles it.
  const [wake, setWake] = useState(DEFAULT_SETTINGS.wake);

  // Load the voice stack + privacy mode, and decide the key gate. Under a mode
  // that blocks cloud voice (June has no local voice provider yet) the mic is
  // disabled up front rather than failing mid-capture (§5). The OpenAI key is
  // demanded ONLY when the chosen voice stack actually uses it and voice isn't
  // blocked (10.6) - a local/keyless stack or a strict mode never nags for it.
  // Re-run on `settings://changed` so a save applies live, no restart (10.5).
  const refreshSettings = useCallback(async () => {
    const s = await loadSettings().catch(() => DEFAULT_SETTINGS);
    settingsRef.current = s;
    setWake(s.wake);
    const blocked = !voiceAllowed(s);
    voiceBlockedRef.current = blocked;
    setVoiceBlocked(blocked);

    const needsKey = !blocked && voiceNeedsOpenAiKey(s);
    const hasKey = needsKey ? await hasOpenAiKey().catch(() => false) : true;
    setPhase((p) => {
      if (needsKey && !hasKey) return p.s === "need-key" ? p : { s: "need-key" };
      // Key satisfied or no longer needed: release the gate, but never interrupt
      // work already in flight - only the resting need-key/idle phase is touched.
      if (p.s === "need-key") return { s: "idle" };
      return p;
    });
  }, []);

  useEffect(() => {
    void refreshSettings();
    const unlisten = listen("settings://changed", () => void refreshSettings());
    return () => {
      void unlisten.then((f) => f());
    };
  }, [refreshSettings]);

  const beginTranscribe = useCallback(async () => {
    const handle = capture.current;
    capture.current = null;
    if (!handle) return;
    const tid = ++transcribeRef.current;
    const timer = new TurnTimer();
    setPhase({ s: "transcribing" });
    try {
      const { audio, mime } = await handle.stop();
      timer.captureEnded();
      if (transcribeRef.current !== tid) return; // cancelled while stopping
      if (audio.length === 0) {
        setPhase({ s: "error", message: "I didn't catch any audio. Try again." });
        return;
      }
      // Belt-and-braces over the backend's own timeout: if the invoke never
      // settles, the UI must not sit in "Transcribing…" forever.
      const text = await Promise.race([
        transcribe(audio, mime, settingsRef.current.stt),
        new Promise<string>((_, reject) =>
          window.setTimeout(
            () => reject(new Error("Transcription took too long. Check your connection and try again.")),
            20_000,
          ),
        ),
      ]);
      if (transcribeRef.current !== tid) return; // cancelled while transcribing
      if (!text.trim()) {
        setPhase({ s: "error", message: "I didn't hear a command. Try again." });
        return;
      }
      timer.gotTranscript();
      timerRef.current = timer;
      setPhase({ s: "review", transcript: text });
    } catch (e) {
      if (transcribeRef.current !== tid) return;
      setPhase({ s: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const stopListening = useCallback(() => {
    if (stopping.current) return;
    stopping.current = true;
    void beginTranscribe();
  }, [beginTranscribe]);

  const startListening = useCallback(async () => {
    if (voiceBlockedRef.current) {
      setPhase({
        s: "error",
        message: "Voice is off in your current privacy mode. Switch to Standard or add a local voice provider in settings.",
      });
      return;
    }
    stopping.current = false;
    try {
      capture.current = await startCapture({ onEndpoint: () => stopListening(), maxMs: MAX_CAPTURE_MS });
      setPhase({ s: "listening" });
    } catch (e) {
      const err = e as CaptureError;
      setPhase({ s: "error", message: err?.message ?? "Could not start the microphone." });
    }
  }, [stopListening]);

  // Barge-in: stop June talking and start capturing the new command. Bumping the
  // turn invalidates the in-flight turn's deltas and onIdle; `cancelAgent` also
  // aborts that turn on the backend so it stops spending tokens immediately
  // (Phase 11.3) rather than running to completion unheard while the user speaks
  // the next command. Cancel BEFORE bumping - the dying turn is the current one.
  const bargeIn = useCallback(() => {
    void cancelAgent(turnRef.current);
    turnRef.current += 1;
    queueRef.current?.stop();
    queueRef.current = null;
    decide("deny"); // interrupting also withdraws any approval the old turn was awaiting
    void startListening();
  }, [startListening, decide]);

  const accept = useCallback(async (transcript: string) => {
    const turn = (turnRef.current += 1);
    splitterRef.current = new SentenceBuffer();
    streamTextRef.current = "";
    replyRef.current = "";
    spokeRef.current = false;
    // Latency (Phase 11.5): the brain clock starts now (Send), so the review
    // pause is excluded; first audio closes the turn's voice-to-voice path.
    const timer = timerRef.current;
    timer?.sent();
    // The turn is over only when BOTH the agent has resolved and the speech
    // queue has drained - either can finish first. A drain alone means speech
    // merely caught up with the token stream (e.g. during a slow tool call).
    let agentDone = false;
    const queue = new SpeechQueue(
      () => {
        if (turnRef.current === turn && agentDone) setPhase({ s: "reply", text: replyRef.current });
      },
      settingsRef.current.tts,
      () => {
        const sample = timer?.firstAudio();
        if (sample) void recordLatency(sample).catch(() => {});
      },
    );
    queueRef.current = queue;
    setPhase({ s: "thinking" });
    try {
      const reply = await runAgent(transcript, turn);
      if (turnRef.current !== turn) return; // barged in while generating
      timer?.firstToken(); // no-op if a text delta already marked it (no-delta brains)
      replyRef.current = reply;
      agentDone = true;
      const tail = splitterRef.current.flush();
      if (tail) {
        queue.enqueue(tail);
        spokeRef.current = true;
      }
      // Fallback: the brain streamed no deltas -> speak the whole reply at once.
      if (!spokeRef.current && reply.trim()) {
        queue.enqueue(reply);
        spokeRef.current = true;
        streamTextRef.current = reply;
      }
      // Speech may already be done (it drained before the agent resolved and
      // nothing was left to flush) - then the drain callback will never fire
      // again, so finish the turn here instead of parking in "speaking".
      if (queue.idle) setPhase({ s: "reply", text: reply });
      else setPhase({ s: "speaking", text: streamTextRef.current });
    } catch (e) {
      if (turnRef.current !== turn) return;
      setPhase({ s: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  // Stream text deltas from the running turn into speech, sentence by sentence.
  useEffect(() => {
    const unlisten = listen<{ turn: number; delta: string }>("agent://text", (e) => {
      if (e.payload.turn !== turnRef.current) return; // stale (barged-in) turn
      const queue = queueRef.current;
      if (!queue) return;
      timerRef.current?.firstToken(); // earliest token wins; later deltas are no-ops
      streamTextRef.current += e.payload.delta;
      for (const sentence of splitterRef.current.push(e.payload.delta)) {
        queue.enqueue(sentence);
        spokeRef.current = true;
      }
      setPhase({ s: "speaking", text: streamTextRef.current });
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Open an echo-cancelled monitor mic only while June is speaking, so the user's
  // voice can barge in. June's own audio is removed by the browser's AEC, so it
  // can't trip the monitor (PLAN.md Phase 5: "June's own audio must never be
  // picked up"). No mic for barge-in? Press-to-interrupt still works.
  useEffect(() => {
    if (phase.s !== "speaking") return;
    let active = true;
    let stop = () => {};
    startBargeMonitor({ onSpeech: () => active && bargeIn() })
      .then((s) => (active ? (stop = s) : s()))
      .catch(() => {});
    return () => {
      active = false;
      stop();
    };
  }, [phase.s, bargeIn]);

  // Poll the input level while listening: the newest sample drives the orb's
  // glow ring, the trailing window renders as the live waveform.
  useEffect(() => {
    if (phase.s !== "listening") {
      setLevels([]);
      return;
    }
    setLevels(Array(WAVE_BARS).fill(0));
    const id = window.setInterval(() => {
      const v = capture.current?.level() ?? 0;
      setLevels((xs) => [...xs.slice(1 - WAVE_BARS), v]);
    }, 90);
    return () => window.clearInterval(id);
  }, [phase.s]);
  const level = levels.length > 0 ? levels[levels.length - 1] : 0;

  // A press (orb or push-to-talk down) either starts a command or barges in on
  // one in progress; a release ends the capture. Keep the current phase in a ref
  // so the global listeners can stay attached once.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const activate = useCallback(() => {
    const s = phaseRef.current.s;
    if (s === "thinking" || s === "speaking") bargeIn();
    // A press during transcription abandons it and records again - a stalled
    // network must never lock the user out of the mic.
    else if (s === "idle" || s === "reply" || s === "error" || s === "transcribing") {
      transcribeRef.current += 1;
      void startListening();
    }
  }, [bargeIn, startListening]);

  useEffect(() => {
    const unlistenDown = listen("ptt://down", () => activate());
    const unlistenUp = listen("ptt://up", () => {
      if (phaseRef.current.s === "listening") stopListening();
    });
    return () => {
      void unlistenDown.then((f) => f());
      void unlistenUp.then((f) => f());
    };
  }, [activate, stopListening]);

  // Hands-free wake word (PLAN.md Phase 8): while June is at rest and voice is
  // allowed, listen ambiently for the phrase and activate on it - exactly what a
  // push-to-talk press does. Only runs when idle so the mic isn't contended while
  // June is already capturing, thinking, or speaking; the effect tears the
  // listener down the moment activation moves us out of "idle".
  useEffect(() => {
    if (!wake.enabled || voiceBlocked || approval || phase.s !== "idle") return;
    let alive = true;
    let stop = () => {};
    startWakeListener({
      phrase: wake.phrase,
      sensitivity: wake.sensitivity,
      onWake: () => alive && activate(),
      allowCloudFallback: !voiceBlocked,
    })
      .then((h) => (alive ? (stop = h.stop) : h.stop()))
      .catch(() => {}); // no mic -> hands-free unavailable; PTT and the orb still work
    return () => {
      alive = false;
      stop();
    };
  }, [wake, voiceBlocked, approval, phase.s, activate]);

  // Tell the shell to expand whenever June is doing anything (or awaiting an
  // approval), and collapse back to the bare orb at rest.
  const active = phase.s !== "idle" || approval != null;
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  // Stop any audio if the panel unmounts mid-reply.
  useEffect(() => () => queueRef.current?.stop(), []);

  const cancel = useCallback(() => {
    void cancelAgent(turnRef.current); // abort any in-flight turn on the backend (Phase 11.3)
    capture.current?.cancel();
    capture.current = null;
    queueRef.current?.stop();
    queueRef.current = null;
    timerRef.current = null; // abandon this turn's latency sample
    turnRef.current += 1;
    transcribeRef.current += 1; // drop any in-flight transcription result
    decide("deny"); // cancelling also rejects any approval left pending
    setPhase({ s: "idle" });
  }, [decide]);

  // "New conversation" (Phase 11.2): drop June's memory of this session. Stop any
  // in-flight capture/speech first (same teardown as cancel), then tell the
  // backend to reset the resident and clear the shared transcript in both faces.
  const startNewConversation = useCallback(() => {
    cancel();
    void newConversation();
  }, [cancel]);

  const speakingText = phase.s === "speaking" ? phase.text : phase.s === "reply" ? phase.text : "";
  const orbState =
    phase.s === "listening"
      ? "listening"
      : phase.s === "speaking"
        ? "speaking"
        : phase.s === "thinking" || phase.s === "transcribing"
          ? "thinking"
          : "";

  return (
    <div className="voice" data-tauri-drag-region>
      <div className="voice-card">
        <header className="voice-head" data-tauri-drag-region>
          <span className="voice-logo" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M6 0l1.4 4.6L12 6 7.4 7.4 6 12 4.6 7.4 0 6l4.6-1.4z" />
            </svg>
          </span>
          <span className="voice-title">June</span>
          <button
            className="new-convo-orb"
            title="New conversation - June forgets this session"
            aria-label="Start a new conversation"
            onClick={startNewConversation}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M12 7A5 5 0 1 1 10.5 3.5M10.5 1v2.5H8"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            className="open-app"
            title="Open the full June window"
            aria-label="Open the full June window"
            onClick={() => void openApp()}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M8 1h5v5M13 1 7.5 6.5M6 2.5H2.5A1.5 1.5 0 0 0 1 4v7.5A1.5 1.5 0 0 0 2.5 13H10a1.5 1.5 0 0 0 1.5-1.5V8"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </header>

        {phase.s === "need-key" ? (
          <KeyGate onSaved={() => setPhase({ s: "idle" })} />
        ) : (
          <>
            <Status phase={phase} approval={approval} />
            {voiceBlocked && (
              <p className="err">Voice is off in your privacy mode. Change it in the full app settings.</p>
            )}
            {approval && <ApprovalCard approval={approval} onDecide={decide} />}
            {phase.s === "review" && (
              <ReviewCard
                transcript={phase.transcript}
                onAccept={accept}
                onCancel={cancel}
                onRedo={() => void startListening()}
              />
            )}
            {speakingText && (
              <div className="reply-block">
                <span className="who who-june">June</span>
                <p className="reply">{speakingText}</p>
              </div>
            )}
            {phase.s === "error" && <p className="err">{phase.message}</p>}
            {phase.s === "listening" && <Waveform levels={levels} />}
          </>
        )}
      </div>

      <button
        className={`orb ${orbState}`}
        style={phase.s === "listening" ? ({ "--level": Math.min(level * 6, 1) } as CSSProperties) : undefined}
        disabled={phase.s === "need-key"}
        // Pointer capture, not mouse events: pressing the orb expands the OS
        // window mid-press, and WebView2 drops the plain mouseup when the window
        // moves under a held button - the widget then sticks in "listening".
        // Capturing the pointer routes the release to the orb regardless, and
        // lostpointercapture is the fail-safe if even that release is eaten.
        onPointerDown={(e) => {
          activate();
          // Capture after acting: if capture throws (WebView2 has rejected the
          // pointer id for injected input), the press must still register.
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Release then falls back to pointerup/VAD endpoint/15s cap.
          }
        }}
        onPointerUp={() => {
          if (phaseRef.current.s === "listening") stopListening();
        }}
        onLostPointerCapture={() => {
          if (phaseRef.current.s === "listening") stopListening();
        }}
        aria-label="Push to talk"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
          <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/** The trailing input-level window as a live gradient waveform (the sample's
 *  signature element), rendered only while listening. */
function Waveform({ levels }: { levels: number[] }) {
  return (
    <div className="wave" aria-hidden="true">
      {levels.map((v, i) => (
        <span key={i} style={{ height: `${6 + Math.min(v * 8, 1) * 30}px` }} />
      ))}
    </div>
  );
}

function Status({ phase, approval }: { phase: Phase; approval: Approval | null }) {
  if (approval) return <p className="status">June needs your OK before it can continue.</p>;
  const text: Record<Phase["s"], string> = {
    "need-key": "",
    idle: "Hold Ctrl + Shift + Space, or click the orb, and speak.",
    listening: "Listening…",
    transcribing: "Transcribing… press the orb to cancel.",
    review: "Is this right?",
    thinking: "Working on it…",
    speaking: "Speaking… talk or press to interrupt.",
    reply: "",
    error: "",
  };
  const busy = phase.s === "listening" || phase.s === "transcribing" || phase.s === "thinking" || phase.s === "speaking";
  if (!text[phase.s]) return null;
  return (
    <p className="status">
      {busy && <span className="status-dot busy" aria-hidden="true" />}
      {text[phase.s]}
    </p>
  );
}

// The visible approval gate (PLAN.md §5): the exact action and count June is
// about to take, with an explicit yes/no. Rendered in the widget and the full
// app alike - either can approve, because the pending approval is shared state.
function ApprovalCard({ approval, onDecide }: { approval: Approval; onDecide: (d: "allow" | "deny") => void }) {
  return (
    <div className="approval">
      <p className="approval-what">{approval.summary}?</p>
      <div className="row">
        <button className="primary" onClick={() => onDecide("allow")}>
          Approve
        </button>
        <button className="danger" onClick={() => onDecide("deny")}>
          Reject
        </button>
      </div>
    </div>
  );
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
      <span className="who">You said</span>
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
    <div className="keygate">
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
