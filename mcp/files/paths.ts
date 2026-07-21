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
 * A symlink *inside* the root pointing out is not followed here (string math
 * only); `assertRealWithin` is the second guard that resolves real paths before
 * a list/read/write touches the target.
 */
export function resolveWithin(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (!isWithin(root, abs)) {
    throw new Error(`Path "${rel}" is outside the allowed folder.`);
  }
  return abs;
}

/**
 * After a path has passed `resolveWithin` (string containment), confirm its REAL
 * path - symlinks followed - is still inside `root`. This is the second guard the
 * `resolveWithin` note refers to: a symlink *inside* the root pointing out passes
 * the string check but must be caught here before its target is read or written.
 *
 * `realpath` is injected (the server passes `fs.realpath`) so the containment
 * decision is testable without creating real symlinks, which need elevated
 * privilege on Windows.
 *
 * ponytail: realpath-then-use has a TOCTOU window (the link could be swapped
 * between the check and the open). Node exposes no portable O_NOFOLLOW, and
 * Windows symlink creation is privileged, so this is proportionate. Upgrade to an
 * open-with-nofollow strategy only if untrusted local symlinks become a real threat.
 */
export async function assertRealWithin(
  root: string,
  abs: string,
  realpath: (p: string) => Promise<string>,
): Promise<void> {
  const real = await realpath(abs);
  if (!isWithin(root, real)) {
    throw new Error("That path resolves outside the allowed folder.");
  }
}

/** Largest number of bytes at or before `limit` that end on a UTF-8 character
 *  boundary, so truncating a large file never splits a multi-byte char into a
 *  `` replacement char (10.8). A byte `0b10xxxxxx` is a continuation byte; if the
 *  first dropped byte would be one, we're mid-character, so walk back to the
 *  char's start. Returns `min(buf.length, limit)` when no split occurs. */
export function utf8SafeEnd(buf: Uint8Array, limit: number): number {
  let end = Math.min(buf.length, limit);
  while (end > 0 && end < buf.length && (buf[end] & 0xc0) === 0x80) end--;
  return end;
}
