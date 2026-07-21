// Shared predicate for "is this a link target we may surface as clickable" (3.3).
// Mirrors mcp/system's validateOpenTarget - an http(s) URL or a filesystem path is
// fine; anything with a non-http(s) `scheme:` prefix (javascript:, file:, an app
// launcher) is rejected - kept frontend-local so the app tsconfig needn't reach
// across into the MCP package.

/** True for a link target safe to present as a clickable affordance: an http(s)
 *  URL or a filesystem path (absolute, relative, drive-letter, or UNC). */
export function isSafeLinkTarget(raw: string): boolean {
  const t = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!t || /[\x00-\x1f]/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return true;
  const colon = t.indexOf(":");
  if (colon < 0) return true; // no scheme -> a plain relative path
  return colon === 1 && /^[a-zA-Z]$/.test(t[0]!); // only a C:\ drive letter
}
