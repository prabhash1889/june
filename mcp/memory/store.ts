// Pure memory-file helpers for the memory capability (PLAN.md Phase 11.4). Kept
// side-effect-free and separate from server.ts so the append/trim logic is
// unit-tested without a real file (mirrors mcp/files/paths.ts).

/** Append `fact` as a markdown bullet to the existing memory text, then trim the
 *  result to the newest `maxBytes` worth of whole lines so the file - and the
 *  system prompt it feeds - can't grow without bound. */
export function appendFact(existing: string, fact: string, maxBytes: number): string {
  const line = `- ${fact.trim().replace(/\s+/g, " ")}`;
  const body = existing.trim();
  const next = body ? `${body}\n${line}` : line;
  return trimToBytes(next, maxBytes);
}

/** Keep only the trailing whole lines of `text` that fit in `maxBytes` (UTF-8);
 *  the newest memories win and the oldest lines fall off the top. At least one
 *  line is always kept, even if it alone exceeds the cap, so a single long fact
 *  is never silently dropped. */
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
