// Path containment for the files capability (§5 "Path containment & canonical
// file whitelist"). Kept side-effect-free and separate from server.ts so it can
// be unit-tested without JUNE_FILES_ROOT set - the server resolves its root at
// import time, this module only does pure path math.

import * as path from "node:path";

/** Whether `abs` is the root itself or lives inside it. The separator guard is
 *  what stops `/allowed/root-evil` from passing as inside `/allowed/root`. */
export function isWithin(root: string, abs: string): boolean {
  const normRoot = path.resolve(root);
  return abs === normRoot || abs.startsWith(normRoot + path.sep);
}

/**
 * Resolve `rel` against `root` and reject anything that escapes it. `path.resolve`
 * normalizes away `..`, and an absolute `rel` outside the root fails the prefix
 * check - so both traversal (`../../etc`) and absolute-path escapes (`C:\Windows`)
 * are caught. `root` must already be canonical (realpath'd).
 *
 * ponytail: prefix containment on the canonical root. A symlink *inside* the root
 * pointing out is not followed here; the server realpaths existing targets as a
 * second guard. Upgrade to realpath-every-segment only if untrusted symlinks in
 * the root become a real threat.
 */
export function resolveWithin(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (!isWithin(root, abs)) {
    throw new Error(`Path "${rel}" is outside the allowed folder.`);
  }
  return abs;
}
