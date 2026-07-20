// Pure lesson-file helpers for the task-memory capability (improvement-4 Phase
// 17.1/17.2 - BridgeAgent's playbook trick). Kept side-effect-free and separate
// from server.ts so the append/cap and the recall ranker are unit-tested without
// a real file (mirrors mcp/memory/store.ts).
//
// A "lesson" is a short markdown bullet the agent writes after a run ("when
// spawning codex agents, always pass the model id"). Unlike memory (durable user
// facts, all injected), lessons are a growing corpus recalled top-k *by relevance
// to the current task* (17.2) so the per-turn prompt stays lean - which the voice
// latency budget needs.

/** Append `lesson` as a markdown bullet to the existing lessons text, then cap the
 *  result to the newest `maxCount` lessons AND `maxBytes` of whole lines so the
 *  file (and the recall it feeds) can't grow without bound. Newest wins; the
 *  oldest lessons fall off the top. */
export function appendLesson(existing: string, lesson: string, maxCount: number, maxBytes: number): string {
  const line = `- ${lesson.trim().replace(/\s+/g, " ")}`;
  const lines = existing
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  lines.push(line);
  const capped = lines.slice(Math.max(0, lines.length - maxCount));
  return trimToBytes(capped.join("\n"), maxBytes);
}

/** Keep only the trailing whole lines of `text` that fit in `maxBytes` (UTF-8);
 *  the newest lessons win. At least one line is always kept, even if it alone
 *  exceeds the cap, so a single long lesson is never silently dropped. */
export function trimToBytes(text: string, maxBytes: number): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + 1; // + the joining newline
    if (bytes + size > maxBytes && out.length > 0) break;
    out.unshift(lines[i]);
    bytes += size;
  }
  return out.join("\n");
}

/** Split a lessons file into its bare lesson texts (bullet stripped, oldest
 *  first), dropping blanks. The stored form is always `- <lesson>`. */
export function parseLessons(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim().replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "it", "this", "that", "my", "me", "you",
  "your", "please", "june", "can", "do", "did", "how", "what", "when",
]);

/** Content words of a phrase: lowercased tokens >= 3 chars, stopwords dropped. */
function keywords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Recall the top-`k` lessons relevant to `query` (17.2: keyword + recency, no
 *  vectors). Scored by how many of the query's content words appear as whole
 *  tokens in the lesson; recency breaks ties (a newer lesson wins). Lessons that
 *  share NO keyword with the task are dropped, so an irrelevant turn injects
 *  nothing and the prompt stays lean. Pure - the ranker is unit-tested. */
export function recallLessons(lessonsText: string, query: string, k: number): string[] {
  const qwords = new Set(keywords(query));
  if (qwords.size === 0) return [];
  const lessons = parseLessons(lessonsText);
  const scored = lessons.map((lesson, index) => {
    const words = new Set(keywords(lesson));
    let score = 0;
    for (const w of qwords) if (words.has(w)) score++;
    return { lesson, score, index };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index) // more matches, then newer
    .slice(0, k)
    .map((s) => s.lesson);
}
