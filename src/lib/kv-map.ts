// `KEY=value` line <-> `{ key: value }` map, the shape Claude Desktop's mcp.json
// uses for env/headers and June's dictionary/snippets. Split out from the editor
// component (app/MapTextarea.tsx) so the pure parse/format can be reused and unit
// tested on their own.

/** `{ key: value }` -> `KEY=value` lines, one per entry. */
export function mapToText(map: Record<string, string>): string {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** `KEY=value` lines -> `{ key: value }`. Blank lines and lines with no `=` (or an
 *  empty key) are skipped, so a half-typed line simply contributes nothing yet. */
export function textToMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k) out[k] = line.slice(i + 1).trim();
  }
  return out;
}
