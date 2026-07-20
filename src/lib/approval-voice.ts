// Strict local yes/no matcher for spoken approvals (PLAN.md Phase 14.2).
//
// This runs ONLY over the user's own transcribed speech during an approval gate,
// and it is a fixed word list - never the LLM, never any tool output. That is the
// whole safety point: an approval can only ever be granted by a human saying a
// clear "yes", so no model response and no tool result can talk June into acting.
// Anything ambiguous or unrecognized returns null, which the caller treats as a
// denial (fail-closed) - the same default as the ~8s timeout.

/** Whole-word yes / no vocabularies. Kept small and unambiguous on purpose: a
 *  fuzzy or generous match here would be a security hole, not a convenience. */
// "ok"/"okay" are deliberately NOT sole affirmatives (B1.4): cloud Whisper
// hallucinates "Okay." on silence, so a bare "okay" must never approve a paid
// action. A real yes is one of the words below (an "okay go ahead" still matches
// "go ahead"). NO carries `not`/`do not` so "sure, do not do it" reads as a
// contradiction (both) -> null -> fail-closed deny, not a yes.
const YES = /\b(yes|yeah|yep|yup|sure|confirm|confirmed|approve|approved|affirmative|go\s+ahead|do\s+it)\b/;
const NO = /\b(no|not|nope|nah|cancel|cancelled|stop|deny|denied|negative|don'?t|do\s+not|never\s*mind)\b/;

/** Map transcribed speech to an approval decision, or null when it is neither a
 *  clear yes nor a clear no (and when it is somehow both). Case-insensitive,
 *  punctuation-tolerant. Null -> the caller denies (fail-closed). */
export function matchApproval(transcript: string): "allow" | "deny" | null {
  const t = transcript.toLowerCase();
  const yes = YES.test(t);
  const no = NO.test(t);
  if (yes && !no) return "allow";
  if (no && !yes) return "deny";
  return null; // silence, gibberish, or a contradictory "yes but no" -> fail closed
}
