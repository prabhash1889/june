import type { Phase } from "./voice-phase.ts";

// Who may hold the mic right now. The ambient listeners (wake word, follow-up)
// used to each re-derive the same 5-condition predicate inline in their effect
// bodies; that duplication was the root of the "re-arms the mic on every
// keystroke" class (B2.3), because a settings save that touched none of these
// still re-ran every copy. One pure definition, tested, is the fix - the same
// extract-and-test move already proven on voice-phase.ts, one level up.

export interface MicGuards {
  micMuted: boolean; // tray mic mute (1.4)
  voiceBlocked: boolean; // no usable STT under the current privacy mode
  hasApproval: boolean; // an approval gate owns the mic (spoken-approval flow)
  dictation: boolean; // dictation mode routes PTT to the injector, not the agent
}

/** True when any owner-blocker means no ambient mic listener should arm. */
export function ambientMicBlocked(g: MicGuards): boolean {
  return g.micMuted || g.voiceBlocked || g.hasApproval || g.dictation;
}

/** The wake-word listener arms only at rest (idle), enabled, and unblocked. */
export function wakeMayArm(enabled: boolean, phase: Phase["s"], g: MicGuards): boolean {
  return enabled && phase === "idle" && !ambientMicBlocked(g);
}

/** The follow-up monitor arms only in the window just after a reply. */
export function followUpMayArm(enabled: boolean, phase: Phase["s"], g: MicGuards): boolean {
  return enabled && phase === "reply" && !ambientMicBlocked(g);
}
