// The voice pipeline's phase state machine, lifted out of VoicePanel so the
// transitions are explicit and testable. VoicePanel is the most regression-prone
// file in the app (most of the bugs1.md B2 regressions lived in these phase
// mutations), and the machine was previously implicit - scattered across ~30
// setPhase sites with no single place to see which transitions are legal.
//
// The transition table is deliberately PERMISSIVE and the reducer is fail-open:
// `idle` and `error` are reachable from nearly everywhere (cancel / open-app /
// agent-reset can fire from any phase), and an unexpected transition only warns
// in dev - it is never blocked. There is no E2E harness for the voice pipeline,
// so a hard reject could silently strand the UI in a race the table didn't
// anticipate; a warning surfaces the surprise without risking a stuck widget.

export type Phase =
  | { s: "need-key" }
  | { s: "idle" }
  | { s: "listening" }
  | { s: "transcribing" }
  | { s: "review"; transcript: string }
  | { s: "thinking" }
  | { s: "speaking"; text: string }
  | { s: "reply"; text: string }
  | { s: "dictated"; text: string } // Phase 15.4: text was injected into the focused app
  | { s: "captured"; text: string } // improvement-6 4.5: text was jotted to june-inbox.md
  | { s: "error"; message: string };

export type PhaseName = Phase["s"];

// How long a terminal-ish phase lingers before auto-returning to idle. These
// exist because the wake listener only arms while idle and the card only
// collapses at rest, so a phase that never expires kills hands-free after the
// first answer and pins the widget open (B2.5 for error, improvement-5 P0.2 for
// reply - the same bug class). A press clears them sooner.
const DICTATED_CONFIRM_MS = 2_500; // 15.4: how long the "sent to your app" / "Jotted" note lingers
const ERROR_EXPIRE_MS = 4_000; // B2.5: how long an error lingers before returning to idle
// improvement-5 P0.2: must be longer than FOLLOWUP_WINDOW_MS (in VoicePanel) so
// follow-up mode gets its full window before the reply expires.
const REPLY_EXPIRE_MS = 12_000;

// Legal transitions per source phase (self-transitions are always allowed and
// omitted). Encoded to match VoicePanel's current behavior, not to tighten it -
// see the file header on why this is permissive rather than strict.
export const LEGAL_TRANSITIONS: Record<PhaseName, readonly PhaseName[]> = {
  // Key gate: satisfied -> idle, or open-app / new-conversation can error out.
  "need-key": ["idle", "error"],
  // Rest: a press/wake -> listening; a settings save can gate to need-key.
  idle: ["listening", "need-key", "error"],
  // Capturing: endpoint/release -> transcribing; cancel -> idle.
  listening: ["transcribing", "idle", "error"],
  // Post-STT fan-out: command -> review, dictation -> dictated, capture ->
  // captured, empty/failed -> idle|error, re-record press -> listening.
  transcribing: ["review", "dictated", "captured", "listening", "idle", "error"],
  // Review gate: accept -> thinking; re-record -> listening; cancel -> idle.
  review: ["thinking", "listening", "idle", "error"],
  // Working: first token -> speaking, empty/drained -> reply, barge -> listening.
  thinking: ["speaking", "reply", "listening", "idle", "error"],
  // Talking: more deltas keep it in speaking; drain/stop -> reply; barge -> listening.
  speaking: ["reply", "listening", "idle", "error"],
  // Answered: follow-up/press -> listening; expire -> idle.
  reply: ["listening", "idle", "error"],
  // Confirmation notes: expire -> idle; a press starts a new capture.
  dictated: ["idle", "listening", "error"],
  captured: ["idle", "listening", "error"],
  // Error: expire -> idle; a press retries; a settings save can gate to need-key.
  error: ["idle", "listening", "need-key"],
};

export function isLegalTransition(from: PhaseName, to: PhaseName): boolean {
  if (from === to) return true; // an idempotent re-set is always fine
  return LEGAL_TRANSITIONS[from].includes(to);
}

// A phase update: either the next phase directly, or a function of the previous
// phase (VoicePanel's refreshSettings needs the previous phase to decide whether
// to gate to need-key without discarding a live turn).
export type PhaseAction = Phase | ((prev: Phase) => Phase);

// The reducer behind VoicePanel's useReducer. Resolves a functional update,
// warns in dev on an unexpected transition, and ALWAYS applies it (fail-open).
export function phaseReducer(prev: Phase, action: PhaseAction): Phase {
  const next = typeof action === "function" ? action(prev) : action;
  if (import.meta.env.DEV && !isLegalTransition(prev.s, next.s)) {
    console.warn(`[voice-phase] unexpected transition: ${prev.s} -> ${next.s}`);
  }
  return next;
}

// ---- Pure phase-derived view selectors (previously inline in VoicePanel) ----

// The status-line hint for a phase. Dictation mode rewords the resting/listening
// prompts: the target is the user's focused app and the orb is disabled, so the
// hint points at the hotkey. Empty string means "no status line for this phase".
export function statusHint(
  phase: PhaseName,
  opts: { dictation: boolean; pttLabel: string },
): string {
  const { dictation, pttLabel } = opts;
  const text: Record<PhaseName, string> = {
    "need-key": "",
    idle: dictation
      ? `Dictation on - hold ${pttLabel} and speak; text goes to your focused app.`
      : `Hold ${pttLabel}, or click the orb, and speak.`,
    listening: dictation ? "Dictating…" : "Listening…",
    transcribing: dictation ? "Writing it out…" : "Transcribing… press the orb to start over.",
    review: "Is this right?",
    thinking: "Working on it…",
    speaking: "Speaking… talk or press to interrupt.",
    reply: "",
    dictated: "",
    captured: "",
    error: "",
  };
  return text[phase];
}

// Whether the status line shows the pulsing "busy" dot.
export function isBusy(phase: PhaseName): boolean {
  return (
    phase === "listening" ||
    phase === "transcribing" ||
    phase === "thinking" ||
    phase === "speaking"
  );
}

// The reply text to render: the live stream while speaking, the final text at
// rest. Empty for every other phase.
export function speakingText(phase: Phase): string {
  return phase.s === "speaking" || phase.s === "reply" ? phase.text : "";
}

// Whether the shell should expand into a card (vs. collapse to the bare orb).
// June is "active" while doing anything, awaiting an approval, running a
// mission, or latched in dictation mode (B2.6: the card must stay reachable so
// the dictation toggle and status are visible even when idle).
export function isActivePhase(
  phase: PhaseName,
  opts: { hasApproval: boolean; missionActive: boolean; dictation: boolean },
): boolean {
  return phase !== "idle" || opts.hasApproval || opts.missionActive || opts.dictation;
}

// How long this phase lingers before auto-returning to idle, or null if it
// doesn't auto-expire. One table replaces three near-identical expire effects.
export function autoExpireMs(phase: PhaseName): number | null {
  if (phase === "dictated" || phase === "captured") return DICTATED_CONFIRM_MS;
  if (phase === "error") return ERROR_EXPIRE_MS;
  if (phase === "reply") return REPLY_EXPIRE_MS;
  return null;
}
