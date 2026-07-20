// Transcript quality (PLAN.md Phase 15.1-15.3): clean a raw STT transcript before
// it reaches the review gate (or the dictation injector). Pure and deterministic -
// no LLM round-trip - so it is instant, works offline in every privacy mode, and
// never adds to the voice-to-voice latency budget (Phase 11.5).
//
// Deliberate deviation from the doc's "cheap LLM pass" (15.1): a rule-based cleaner
// covers the filler/punctuation/dictionary/snippet loop the exit criterion tests
// without a per-turn model call. The LLM pass (and 15.5's app-aware tone, which
// needs it) is the opt-in upgrade path, not this cut.
//
// Three transforms, applied in order so an expansion is never re-mangled:
//   1. snippets   - a spoken cue expands to saved text ("insert my intro")   (15.3)
//   2. dictionary - a misheard term is corrected to the user's spelling      (15.2)
//   3. autoEdit   - strip fillers, fix spacing/punctuation, capitalize       (15.1)

/** A user term map: a lowercased key (what was heard / the cue) -> its
 *  replacement (the correction / the expansion). Shared by the dictionary and the
 *  snippet expander; they differ only in intent, not in shape. */
export type TermMap = Record<string, string>;

export interface CleanOptions {
  /** 15.1 cosmetic pass: strip fillers, tidy spacing/punctuation, capitalize. */
  autoEdit?: boolean;
  /** 15.2 personal dictionary: heard-term -> correction, applied whole-word. */
  dictionary?: TermMap;
  /** 15.3 voice snippets: spoken cue -> saved expansion, applied whole-phrase. */
  snippets?: TermMap;
}

/** Conservative filler vocabulary. Only unambiguous disfluencies - deliberately
 *  excludes "like"/"actually"/"basically", which carry meaning as often as not, so
 *  cleaning never changes what the user actually said. */
const FILLERS = ["um", "umm", "uh", "uhh", "erm", "er", "hmm", "you know", "i mean"];

/** Escape a user-supplied string for literal use inside a RegExp. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace every whole-word/phrase occurrence of each map key with its value,
 *  case-insensitively. `\b` boundaries keep "june" from matching inside "junebug"
 *  and let multi-word cues ("insert my intro") match as a unit. */
function applyMap(text: string, map: TermMap | undefined): string {
  if (!map) return text;
  let out = text;
  for (const [rawKey, value] of Object.entries(map)) {
    const key = rawKey.trim();
    if (!key) continue;
    out = out.replace(new RegExp(`\\b${esc(key)}\\b`, "gi"), value);
  }
  return out;
}

/** Strip fillers and tidy spacing/punctuation/capitalization (the 15.1 pass). */
function cosmetic(text: string): string {
  let out = text;
  for (const f of FILLERS) {
    out = out.replace(new RegExp(`\\b${esc(f)}\\b`, "gi"), " ");
  }
  out = out
    .replace(/\s+([.,!?;:])/g, "$1") // no space before punctuation
    .replace(/([.,!?;:])(?=[^\s])/g, "$1 ") // one space after it
    .replace(/\s+/g, " ") // collapse runs of whitespace
    .trim();
  if (!out) return out;
  out = out.replace(/^([\p{L}])/u, (_m, c: string) => c.toUpperCase()); // capitalize first letter
  if (!/[.!?]$/.test(out)) out += "."; // ensure a terminal mark
  return out;
}

/** Clean a raw transcript. Snippets and the dictionary always apply (they are
 *  explicit user config); the cosmetic filler/punctuation pass is gated by
 *  `autoEdit`. Returns the transcript ready for the review gate or injection. */
export function cleanTranscript(text: string, opts: CleanOptions = {}): string {
  let out = applyMap(text, opts.snippets);
  out = applyMap(out, opts.dictionary);
  if (opts.autoEdit) out = cosmetic(out);
  else out = out.replace(/\s+/g, " ").trim();
  return out;
}

/** Trim surrounding punctuation from a token for comparison ("June." -> "June"). */
function stripPunct(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** A single clean word (letters/digits/'-), the only thing worth storing as a
 *  correction - never a whole phrase or a punctuation blob. */
function isWord(s: string): boolean {
  return /^[\p{L}\p{N}'-]+$/u.test(s);
}

/** Learn corrections from a review-gate edit (15.2): when the user changes words
 *  in the transcript and sends, capture each 1:1 word substitution as a dictionary
 *  entry so the same mishearing self-corrects next time. Only pure substitutions
 *  are learned - if the edit added or removed words the alignment is ambiguous, so
 *  nothing is captured (fail-safe over a wrong guess). Returns the SAME map when
 *  there is nothing new, so callers can skip a persist. Newest wins under `cap`. */
export function captureCorrections(before: string, after: string, dict: TermMap, cap = 200): TermMap {
  const a = before.trim().split(/\s+/).filter(Boolean);
  const b = after.trim().split(/\s+/).filter(Boolean);
  if (a.length === 0 || a.length !== b.length) return dict;
  let next: TermMap | null = null;
  for (let i = 0; i < a.length; i++) {
    const from = stripPunct(a[i]);
    const to = stripPunct(b[i]);
    if (!from || !to || from === to) continue;
    if (!isWord(from) || !isWord(to)) continue;
    // Capitalizing the first word is grammar, not a term correction - don't learn
    // it (else every "open ..." command would teach "open" -> "Open"). A case-only
    // fix mid-sentence IS a real correction (a name like "june" -> "June"), so it
    // is kept.
    if (i === 0 && from.toLowerCase() === to.toLowerCase()) continue;
    const key = from.toLowerCase();
    if (dict[key] === to) continue;
    (next ??= { ...dict })[key] = to;
  }
  if (!next) return dict;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - cap))) delete next[k];
  return next;
}
