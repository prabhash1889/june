import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { matchApproval } from "../lib/approval-voice.ts";
import { hasOpenAiKey, injectText, runAgent, setOpenAiKey, transcribe } from "../lib/stt.ts";
import { type Approval, cancelAgent, interactiveTurnBase, newConversation, openApp, useMission, usePendingApproval } from "../lib/session.ts";
import { missionProgress } from "../lib/missions.ts";
import { DEFAULT_SETTINGS, type HandsFreeConfig, type JuneSettings, loadSettings, saveSettings, voiceAllowed, voiceNeedsOpenAiKey, type WakeConfig } from "../lib/settings.ts";
import { captureCorrections, cleanTranscript } from "../lib/transcript.ts";
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
  | { s: "dictated"; text: string } // Phase 15.4: text was injected into the focused app
  | { s: "error"; message: string };

const MAX_CAPTURE_MS = 15_000;
const WAVE_BARS = 28;

// Hands-free timings (Phase 14). Small, fixed constants - not settings knobs.
const AUTO_ACCEPT_SECONDS = 3; // 14.1: review-card countdown before auto-send
const FOLLOWUP_WINDOW_MS = 6_000; // 14.3: how long the mic stays armed after a reply
const SPOKEN_APPROVAL_MS = 8_000; // 14.2: how long to listen for a spoken yes/no
const DICTATED_CONFIRM_MS = 2_500; // 15.4: how long the "sent to your app" note lingers
const ERROR_EXPIRE_MS = 4_000; // B2.5: how long an error lingers before returning to idle

// Compare the effects-driving voice configs by value (B2.3): a settings save that
// didn't touch these must not hand the wake/hands-free effects a new object, or
// they tear down and re-arm the mic on every keystroke-driven settings://changed.
function sameWake(a: WakeConfig, b: WakeConfig): boolean {
  return a.enabled === b.enabled && a.phrase === b.phrase && a.sensitivity === b.sensitivity;
}
function sameHandsFree(a: HandsFreeConfig, b: HandsFreeConfig): boolean {
  return (
    a.autoAccept === b.autoAccept &&
    a.spokenApprovals === b.spokenApprovals &&
    a.followUp === b.followUp &&
    a.backchannel === b.backchannel
  );
}

// `onActiveChange` lets the widget shell expand into a card while June is doing
// anything (and collapse back to a bare orb at rest) - the shell owns the window
// geometry, VoicePanel owns the pipeline (PLAN.md Phase 6 widget spec).
export function VoicePanel({ onActiveChange }: { onActiveChange?: (active: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>({ s: "idle" });
  const [levels, setLevels] = useState<number[]>([]);
  const { approval, decide } = usePendingApproval();
  // Mission state (Phase 19.1), shared with the full app. The widget shows a compact
  // chip while a mission is active so both faces reflect the same board.
  const mission = useMission();
  const missionActive = mission?.status === "active";
  const capture = useRef<CaptureHandle | null>(null);
  // Guard the async stop path so a hotkey-up and a VAD endpoint can't both fire it.
  const stopping = useRef(false);
  // A PTT release that arrived WHILE startCapture was still opening the mic (B4.8):
  // the up handler can't stop a capture that isn't "listening" yet, so it flags this
  // and startListening honours it the instant the capture is ready - otherwise a
  // quick tap leaves the mic open until the 15s cap.
  const releaseDuringSetup = useRef(false);
  // Approval state mirrored to a ref so the always-attached backchannel listener can
  // read it without re-subscribing (B4.10: no "On it." over a spoken repeat-back).
  const approvalRef = useRef<Approval | null>(null);
  // Bumped to abandon an in-flight transcription (press-to-cancel, Cancel,
  // barge into a new capture) so a slow network can never lock the widget in
  // "Transcribing…" and a late result can't overwrite a newer state.
  const transcribeRef = useRef(0);

  // Streaming-speech state. `turn` tags each command so deltas/onIdle from a turn
  // that was barged in on are dropped. `spoke` guards the silent-reply case. Seeded
  // from a monotonic per-load base (B3.7) so a webview reload never reuses a turn
  // number still registered in the shared Rust map.
  const turnRef = useRef(interactiveTurnBase());
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
  // Hands-free config (Phase 14) in state so the follow-up / spoken-approval /
  // auto-accept effects re-arm live when the user toggles them; the backchannel
  // listener reads it off the ref instead.
  const [handsFree, setHandsFree] = useState<HandsFreeConfig>(DEFAULT_SETTINGS.handsFree);
  // A one-shot queue for June's "on it" backchannel (14.4), kept separate from the
  // reply queue so it never pollutes the latency mark; torn down on barge/cancel
  // and the moment the real reply starts speaking.
  const ackRef = useRef<SpeechQueue | null>(null);
  const ackTurnRef = useRef(-1);

  // Dictation mode (Phase 15.4): when on, a user-held PTT press dictates the
  // cleaned transcript into the focused app instead of running a command. Kept in
  // state (drives the header toggle + status) and a ref (read in the ptt handler).
  // `captureMode` tags each capture so beginTranscribe routes it: only a dictation
  // PTT press sets "dictation", so injection is strictly user-PTT-gated.
  const [dictation, setDictation] = useState(false);
  const dictationRef = useRef(false);
  dictationRef.current = dictation;
  approvalRef.current = approval;
  const captureModeRef = useRef<"command" | "dictation">("command");

  // Load the voice stack + privacy mode, and decide the key gate. Under a mode
  // that blocks cloud voice (June has no local voice provider yet) the mic is
  // disabled up front rather than failing mid-capture (§5). The OpenAI key is
  // demanded ONLY when the chosen voice stack actually uses it and voice isn't
  // blocked (10.6) - a local/keyless stack or a strict mode never nags for it.
  // Re-run on `settings://changed` so a save applies live, no restart (10.5).
  const refreshSettings = useCallback(async () => {
    const s = await loadSettings().catch(() => DEFAULT_SETTINGS);
    settingsRef.current = s;
    // Keep the previous object identity when the value is unchanged (B2.3) so the
    // wake / hands-free effects don't needlessly re-arm the mic on every save.
    setWake((prev) => (sameWake(prev, s.wake) ? prev : s.wake));
    setHandsFree((prev) => (sameHandsFree(prev, s.handsFree) ? prev : s.handsFree));
    const blocked = !voiceAllowed(s);
    voiceBlockedRef.current = blocked;
    setVoiceBlocked(blocked);
    if (blocked) setDictation(false); // no usable STT for this mode - leave dictation mode

    const needsKey = !blocked && voiceNeedsOpenAiKey(s);
    const hasKey = needsKey ? await hasOpenAiKey().catch(() => false) : true;
    setPhase((p) => {
      // Only demand the key from a RESTING phase (B2.8): entering need-key from a
      // live review/thinking/speaking phase (a settings change to an OpenAI stack
      // mid-turn) would discard the turn in flight.
      if (needsKey && !hasKey) {
        return p.s === "idle" || p.s === "error" || p.s === "need-key" ? { s: "need-key" } : p;
      }
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
      // Phase 15.1-15.3: clean the raw transcript (snippets -> dictionary -> filler
      // pass) before it reaches the review gate or the injector. Pure and local.
      const cleaned = cleanTranscript(text, settingsRef.current.transcript);
      const dictating = captureModeRef.current === "dictation";
      if (!cleaned.trim()) {
        // Nothing usable: a dictation clip just stands down quietly; a command
        // surfaces the same "try again" it always has.
        setPhase(dictating ? { s: "idle" } : { s: "error", message: "I didn't hear a command. Try again." });
        return;
      }
      // Phase 15.4: dictation injects into the focused app instead of the agent.
      // This is the ONLY caller of injectText, and it is reached only from a
      // user-held PTT press (captureMode is set to "dictation" nowhere else).
      if (dictating) {
        try {
          await injectText(cleaned);
          if (transcribeRef.current !== tid) return;
          setPhase({ s: "dictated", text: cleaned });
        } catch (e) {
          if (transcribeRef.current !== tid) return;
          setPhase({ s: "error", message: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      timer.gotTranscript();
      timerRef.current = timer;
      setPhase({ s: "review", transcript: cleaned });
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
    releaseDuringSetup.current = false;
    try {
      capture.current = await startCapture({ onEndpoint: () => stopListening(), maxMs: MAX_CAPTURE_MS });
      setPhase({ s: "listening" });
      // A PTT release landed while the mic was still opening (B4.8): stop now so a
      // quick tap doesn't sit recording until the 15s cap.
      if (releaseDuringSetup.current) {
        releaseDuringSetup.current = false;
        stopListening();
      }
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
    ackRef.current?.stop(); // silence any "on it" backchannel too (14.4)
    ackRef.current = null;
    decide("deny"); // interrupting also withdraws any approval the old turn was awaiting
    void startListening();
  }, [startListening, decide]);

  // Learn corrections from a review-gate edit (Phase 15.2): if the user changed
  // words before sending, capture the 1:1 substitutions into the personal
  // dictionary so the same mishearing self-corrects next time. Persisted AFTER the
  // turn is dispatched (not before), so growing the dictionary never respawns the
  // resident in the middle of the very command being sent.
  const learnCorrections = useCallback(async (before: string, after: string) => {
    const cfg = settingsRef.current.transcript;
    const dictionary = captureCorrections(before, after, cfg.dictionary);
    if (dictionary === cfg.dictionary) return; // nothing new to store
    const next = { ...settingsRef.current, transcript: { ...cfg, dictionary } };
    settingsRef.current = next;
    await saveSettings(next).catch(() => {});
  }, []);

  const accept = useCallback(async (transcript: string, original?: string) => {
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
        // The real reply is starting: silence any lingering "on it" backchannel
        // (14.4) so the two never overlap, and mark voice-to-voice latency.
        ackRef.current?.stop();
        ackRef.current = null;
        const sample = timer?.firstAudio();
        if (sample) void recordLatency(sample).catch(() => {});
      },
    );
    queueRef.current = queue;
    setPhase({ s: "thinking" });
    try {
      const { text: reply } = await runAgent(transcript, turn);
      if (turnRef.current !== turn) return; // barged in while generating
      // Learn the review-gate correction only now the turn is dispatched and done
      // (B2.2): growing the dictionary persists settings, which respawns the
      // resident - doing it before the turn killed the very command being sent.
      if (original) void learnCorrections(original, transcript);
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
  }, [learnCorrections]);

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

  // Backchannel (Phase 14.4): a brief spoken "on it" the first time a turn starts
  // a tool call, so the user hears June is working during a slow action. Skipped
  // once June is already talking (a reply sentence has been spoken) - no need to
  // acknowledge over its own voice - and only once per turn. Spoken on a dedicated
  // one-shot queue so it stays out of the reply's latency mark.
  useEffect(() => {
    const unlisten = listen<{ turn: number }>("agent://tool", (e) => {
      if (e.payload.turn !== turnRef.current) return; // stale (barged-in) turn
      if (!settingsRef.current.handsFree.backchannel || spokeRef.current) return;
      if (approvalRef.current) return; // B4.10: never "On it." over a spoken repeat-back
      if (ackTurnRef.current === e.payload.turn) return; // one "on it" per turn
      ackTurnRef.current = e.payload.turn;
      const ack = new SpeechQueue(() => {}, settingsRef.current.tts);
      ackRef.current = ack;
      ack.enqueue("On it.");
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
    // Not while an approval is pending: the mic then belongs to the spoken-approval
    // flow (14.2), and answering a gate isn't barging into a reply.
    if (phase.s !== "speaking" || approval) return;
    let active = true;
    let stop = () => {};
    startBargeMonitor({ onSpeech: () => active && bargeIn() })
      .then((s) => (active ? (stop = s) : s()))
      .catch(() => {});
    return () => {
      active = false;
      stop();
    };
  }, [phase.s, approval, bargeIn]);

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

  // Clear the "sent to your app" dictation note after a moment (15.4), returning
  // the widget to rest. A new PTT press cancels it early via startListening.
  useEffect(() => {
    if (phase.s !== "dictated") return;
    const id = window.setTimeout(() => setPhase({ s: "idle" }), DICTATED_CONFIRM_MS);
    return () => window.clearTimeout(id);
  }, [phase.s]);

  // Auto-recover from a transient error back to rest (B2.5). One "I didn't hear a
  // command" otherwise parks in `error` forever, which permanently disables the
  // hands-free wake listener (it only runs while idle) until the orb is clicked.
  // Expire to idle after a few seconds so wake re-arms; a press clears it sooner.
  useEffect(() => {
    if (phase.s !== "error") return;
    const id = window.setTimeout(() => setPhase({ s: "idle" }), ERROR_EXPIRE_MS);
    return () => window.clearTimeout(id);
  }, [phase.s]);

  // A press (orb or push-to-talk down) either starts a command or barges in on
  // one in progress; a release ends the capture. Keep the current phase in a ref
  // so the global listeners can stay attached once.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const activate = useCallback(() => {
    captureModeRef.current = "command"; // every activate() path is a command; only PTT dictation opts out
    const s = phaseRef.current.s;
    if (s === "thinking" || s === "speaking") bargeIn();
    // A press during transcription abandons it and records again - a stalled
    // network must never lock the user out of the mic. A press in `review` re-records
    // (B4.10: the orb was inert there), same as the card's Re-record button.
    else if (s === "idle" || s === "reply" || s === "error" || s === "transcribing" || s === "dictated" || s === "review") {
      transcribeRef.current += 1;
      void startListening();
    }
  }, [bargeIn, startListening]);

  useEffect(() => {
    const unlistenDown = listen("ptt://down", () => {
      // Dictation mode (15.4): a PTT press captures for injection into the focused
      // app. Start it directly (not via activate, which is command-only) so the
      // capture is tagged "dictation" and never routed to the agent. PTT is the one
      // and only dictation trigger - the orb is disabled in this mode.
      if (dictationRef.current) {
        if (phaseRef.current.s === "listening") return;
        captureModeRef.current = "dictation";
        transcribeRef.current += 1;
        void startListening();
        return;
      }
      activate();
    });
    const unlistenUp = listen("ptt://up", () => {
      if (phaseRef.current.s === "listening") stopListening();
      else releaseDuringSetup.current = true; // released before the mic finished opening (B4.8)
    });
    return () => {
      void unlistenDown.then((f) => f());
      void unlistenUp.then((f) => f());
    };
  }, [activate, stopListening, startListening]);

  // Hands-free wake word (PLAN.md Phase 8): while June is at rest and voice is
  // allowed, listen ambiently for the phrase and activate on it - exactly what a
  // push-to-talk press does. Only runs when idle so the mic isn't contended while
  // June is already capturing, thinking, or speaking; the effect tears the
  // listener down the moment activation moves us out of "idle".
  useEffect(() => {
    if (!wake.enabled || voiceBlocked || approval || dictation || phase.s !== "idle") return;
    let alive = true;
    let stop = () => {};
    startWakeListener({
      phrase: wake.phrase,
      sensitivity: wake.sensitivity,
      onWake: () => alive && activate(),
      allowCloudFallback: !voiceBlocked,
      stt: settingsRef.current.stt, // B4.6: burst fallback uses the user's STT choice
    })
      .then((h) => (alive ? (stop = h.stop) : h.stop()))
      .catch(() => {}); // no mic -> hands-free unavailable; PTT and the orb still work
    return () => {
      alive = false;
      stop();
    };
  }, [wake, voiceBlocked, approval, dictation, phase.s, activate]);

  // Follow-up mode (Phase 14.3): after each reply, keep the mic armed for a few
  // seconds with no wake word so the user can just keep talking. Reuses the Silero
  // speech-onset monitor (same as barge-in): on confirmed speech we open a real
  // capture; if nothing is said in the window we quietly stand down (no empty-
  // capture error, no 15s hang). Opt-in.
  // ponytail: the first ~200ms of the follow-up can clip while the capture opens
  // after onset; acceptable for v1, a continuous rolling buffer is the upgrade.
  useEffect(() => {
    if (!handsFree.followUp || voiceBlocked || approval || dictation || phase.s !== "reply") return;
    let alive = true;
    let stop = () => {};
    const timer = window.setTimeout(() => {
      alive = false;
      stop();
    }, FOLLOWUP_WINDOW_MS);
    startBargeMonitor({
      onSpeech: () => {
        if (!alive) return;
        alive = false;
        window.clearTimeout(timer);
        stop();
        activate(); // in "reply", this starts a fresh capture
      },
    })
      .then((s) => (alive ? (stop = s) : s()))
      .catch(() => {}); // no mic -> follow-up unavailable; PTT and the orb still work
    return () => {
      alive = false;
      window.clearTimeout(timer);
      stop();
    };
  }, [handsFree.followUp, voiceBlocked, approval, dictation, phase.s, activate]);

  // Spoken approvals (Phase 14.2): for EXPENSIVE actions only, June speaks the
  // exact repeat-back and listens for a strict local yes/no. Destructive/external
  // actions are deliberately excluded - they still require a click on the approval
  // card. The matcher (approval-voice.ts) runs only over the user's own speech and
  // is a fixed word list, never the LLM and never tool output, so nothing but a
  // human "yes" can approve. No clear yes within ~8s (or a no/gibberish/silence) is
  // a denial, announced aloud. The click path stays live: if the user (or the
  // other window) decides first, this effect's cleanup aborts the spoken flow.
  useEffect(() => {
    // Bail under a voice-off privacy mode (B2.9): with no usable STT this flow
    // would open no mic and silently auto-deny the gate ~8s in, racing the user's
    // click. Leave the decision entirely to the approval card in that mode.
    if (!approval || !handsFree.spokenApprovals || approval.cls !== "expensive" || voiceBlocked) return;
    // Silence any lingering "on it" backchannel before the repeat-back so the two
    // never overlap (B4.10); the guard in the backchannel listener stops a new one.
    ackRef.current?.stop();
    ackRef.current = null;
    let alive = true;
    let listening = false;
    let cap: CaptureHandle | null = null;
    const tts = settingsRef.current.tts;
    const say = (text: string) => new SpeechQueue(() => {}, tts).enqueue(text);
    const finish = (decision: "allow" | "deny", spoken?: string) => {
      if (!alive) return;
      alive = false;
      if (spoken) say(spoken);
      decide(decision);
    };

    const endCapture = async () => {
      const c = cap;
      cap = null;
      if (!c || !alive) return;
      const heardSpeech = c.heardSpeech();
      const { audio, mime } = await c.stop();
      if (!alive) return;
      let decision: "allow" | "deny" | null = null;
      // Refuse to transcribe a speechless clip (B1.4): cloud Whisper hallucinates
      // "Okay." on pure silence, which would approve a paid action with no human
      // input. Only a clip the VAD actually heard speech in reaches the matcher.
      if (audio.length > 0 && heardSpeech) {
        decision = await transcribe(audio, mime, settingsRef.current.stt).then(matchApproval).catch(() => null);
      }
      if (decision === "allow") finish("allow");
      else if (decision === "deny") finish("deny", "Okay, cancelled.");
      else finish("deny", "I didn't catch a yes, so I cancelled that.");
    };

    // Speak the repeat-back, then start listening once it drains (onIdle).
    const prompt = new SpeechQueue(() => {
      if (!alive || listening) return;
      listening = true;
      startCapture({ onEndpoint: () => void endCapture(), maxMs: SPOKEN_APPROVAL_MS })
        .then((h) => (alive ? (cap = h) : h.cancel()))
        .catch(() => finish("deny", "I couldn't open the microphone, so I cancelled that."));
    }, tts);
    prompt.enqueue(`${approval.summary}. Say yes to approve, or no to cancel.`);

    return () => {
      alive = false;
      prompt.stop();
      cap?.cancel();
    };
  }, [approval, handsFree.spokenApprovals, voiceBlocked, decide]);

  // Tell the shell to expand whenever June is doing anything (or awaiting an
  // approval, or a mission is running), and collapse back to the bare orb at rest.
  // Dictation is included (B2.6): latched-and-idle, the card must stay visible so
  // its on/off toggle and "dictation on" status are reachable (the orb is disabled
  // in this mode), matching 15.4's "visible indicator throughout".
  const active = phase.s !== "idle" || approval != null || missionActive || dictation;
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  // Stop any audio if the panel unmounts mid-reply.
  useEffect(() => () => {
    queueRef.current?.stop();
    ackRef.current?.stop();
  }, []);

  const cancel = useCallback(() => {
    void cancelAgent(turnRef.current); // abort any in-flight turn on the backend (Phase 11.3)
    capture.current?.cancel();
    capture.current = null;
    queueRef.current?.stop();
    queueRef.current = null;
    ackRef.current?.stop();
    ackRef.current = null;
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

  // React to a "New conversation" started from the OTHER face (B2.7). The app
  // window can reset the resident while this widget is mid-reply or capturing;
  // the backend broadcasts agent://reset, so tear our pipeline down (same as
  // Cancel) instead of speaking/capturing a turn the resident has forgotten.
  // Skip it while `thinking`: that is our OWN idle-reset (Phase 11.2), which fires
  // agent://reset at the start of a turn we just dispatched - tearing down then
  // would kill the very turn in flight.
  useEffect(() => {
    const unlisten = listen("agent://reset", () => {
      if (phaseRef.current.s !== "thinking") cancel();
    });
    return () => {
      void unlisten.then((f) => f());
    };
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
        {mission && <MissionChip mission={mission} />}
        <header className="voice-head" data-tauri-drag-region>
          <span className="voice-logo" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M6 0l1.4 4.6L12 6 7.4 7.4 6 12 4.6 7.4 0 6l4.6-1.4z" />
            </svg>
          </span>
          <span className="voice-title">June</span>
          <button
            className={`dictation-toggle${dictation ? " on" : ""}`}
            title={
              dictation
                ? "Dictation on - hold Ctrl+Shift+Space to type into your focused app. Click to turn off."
                : "Dictation mode - type your speech into the focused app"
            }
            aria-label="Toggle dictation mode"
            aria-pressed={dictation}
            disabled={voiceBlocked}
            onClick={() => setDictation((d) => !d)}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="1" y="4" width="14" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path
                d="M3.5 6.5h.01M6 6.5h.01M8.5 6.5h.01M11 6.5h.01M3.5 9h.01M13 9h.01M5.5 9.5h5"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
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
            <Status phase={phase} approval={approval} dictation={dictation} />
            {voiceBlocked && (
              <p className="err">Voice is off in your privacy mode. Change it in the full app settings.</p>
            )}
            {approval && <ApprovalCard approval={approval} onDecide={decide} />}
            {phase.s === "review" && (
              <ReviewCard
                transcript={phase.transcript}
                autoAccept={handsFree.autoAccept}
                onAccept={accept}
                onCancel={cancel}
                onRedo={() => void startListening()}
              />
            )}
            {phase.s === "dictated" && (
              <div className="reply-block">
                <span className="who">Sent to your app</span>
                <p className="reply">{phase.text}</p>
              </div>
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
        // Disabled in dictation mode: injection must come only from a held PTT
        // press (never a click, which would focus June and mis-target the text).
        disabled={phase.s === "need-key" || dictation}
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

// A compact read-only mission indicator for the widget (Phase 19.1). The full
// board lives in the app window; here it's just "Mission N/M · current task" so the
// second face reflects the same state without owning the orchestration.
function MissionChip({ mission }: { mission: NonNullable<ReturnType<typeof useMission>> }) {
  const { done, failed, total } = missionProgress(mission);
  const current = mission.tasks.find((t) => t.status === "active");
  return (
    <div className={`mission-chip ${mission.status}`} title={mission.outcome}>
      <span className="mission-chip-count">
        {done + failed}/{total}
      </span>
      <span className="mission-chip-text">
        {mission.status === "active" ? (current?.title ?? mission.outcome) : `Mission ${mission.status}`}
      </span>
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

function Status({ phase, approval, dictation }: { phase: Phase; approval: Approval | null; dictation: boolean }) {
  if (approval) return <p className="status">June needs your OK before it can continue.</p>;
  // Dictation mode (15.4) rewords the resting/listening prompts: the target is the
  // user's focused app, and the orb is disabled, so the hint points at the hotkey.
  const text: Record<Phase["s"], string> = {
    "need-key": "",
    idle: dictation
      ? "Dictation on - hold Ctrl + Shift + Space and speak; text goes to your focused app."
      : "Hold Ctrl + Shift + Space, or click the orb, and speak.",
    listening: dictation ? "Dictating…" : "Listening…",
    transcribing: dictation ? "Writing it out…" : "Transcribing… press the orb to cancel.",
    review: "Is this right?",
    thinking: "Working on it…",
    speaking: "Speaking… talk or press to interrupt.",
    reply: "",
    dictated: "",
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
  autoAccept,
  onAccept,
  onCancel,
  onRedo,
}: {
  transcript: string;
  autoAccept: boolean;
  onAccept: (t: string, original: string) => void;
  onCancel: () => void;
  onRedo: () => void;
}) {
  const [text, setText] = useState(transcript);
  // `transcript` is the cleaned text as first shown; it is passed back on send so an
  // edit can teach the personal dictionary (15.2, diffed in learnCorrections).
  // Auto-accept countdown (Phase 14.1): only when opted in, and paused by any
  // interaction (edit, focus, Re-record, Cancel) so the user is always in control.
  const [paused, setPaused] = useState(!autoAccept);
  const [remaining, setRemaining] = useState(AUTO_ACCEPT_SECONDS);
  const pause = () => setPaused(true);
  useEffect(() => {
    if (paused) return;
    if (!text.trim()) {
      setPaused(true); // nothing to send - don't fire an empty command
      return;
    }
    if (remaining <= 0) {
      onAccept(text.trim(), transcript);
      return;
    }
    const id = window.setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => window.clearTimeout(id);
  }, [paused, remaining, text, onAccept, transcript]);
  return (
    <div className="review">
      <span className="who">You said</span>
      <textarea
        value={text}
        onChange={(e) => {
          pause();
          setText(e.target.value);
        }}
        onFocus={pause}
        rows={3}
      />
      <div className="row">
        <button className="primary" disabled={!text.trim()} onClick={() => onAccept(text.trim(), transcript)}>
          {paused ? "Send to June" : `Sending in ${remaining}…`}
        </button>
        <button
          onClick={() => {
            pause();
            onRedo();
          }}
        >
          Re-record
        </button>
        <button
          onClick={() => {
            pause();
            onCancel();
          }}
        >
          Cancel
        </button>
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
