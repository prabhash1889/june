// Path containment is the one security-critical bit of the files capability
// (§5): a voice command must never reach a file outside the allowed root. These
// exercise the resolver directly - no filesystem, no server needed. The server
// itself sets ROOT at import time from JUNE_FILES_ROOT, so we test the exported
// pure function rather than the module.

import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { assertRealWithin, resolveWithin, utf8SafeEnd } from "./paths.ts";

const ROOT = path.resolve("/allowed/root");

describe("resolveWithin", () => {
  it("resolves a plain relative path inside the root", () => {
    expect(resolveWithin(ROOT, "notes.txt")).toBe(path.join(ROOT, "notes.txt"));
    expect(resolveWithin(ROOT, "sub/deep/file.md")).toBe(path.join(ROOT, "sub", "deep", "file.md"));
  });

  it("allows the root itself", () => {
    expect(resolveWithin(ROOT, ".")).toBe(ROOT);
  });

  it("rejects `..` traversal that escapes the root", () => {
    expect(() => resolveWithin(ROOT, "../secret")).toThrow(/outside/);
    expect(() => resolveWithin(ROOT, "sub/../../secret")).toThrow(/outside/);
  });

  it("rejects an absolute path outside the root", () => {
    const outside = path.resolve("/etc/passwd");
    expect(() => resolveWithin(ROOT, outside)).toThrow(/outside/);
  });

  it("does not treat a sibling folder with the root as a prefix as inside", () => {
    // `/allowed/root-evil` shares the string prefix `/allowed/root` but is NOT
    // inside it - the separator check is what catches this.
    expect(() => resolveWithin(ROOT, path.resolve("/allowed/root-evil/x"))).toThrow(/outside/);
  });
});

describe("assertRealWithin", () => {
  // The realpath resolver is injected, so we simulate a symlink by returning a
  // real path that differs from the input - no filesystem, no privilege needed.
  const link = path.join(ROOT, "link");

  it("allows a target whose real path stays inside the root", async () => {
    const realpath = async () => path.join(ROOT, "sub", "actual.txt");
    await expect(assertRealWithin(ROOT, link, realpath)).resolves.toBeUndefined();
  });

  it("rejects a symlink whose real path escapes the root", async () => {
    const realpath = async () => path.resolve("/etc/passwd");
    await expect(assertRealWithin(ROOT, link, realpath)).rejects.toThrow(/outside/);
  });

  it("rejects a symlink to a sibling that only shares the root's string prefix", async () => {
    const realpath = async () => path.resolve("/allowed/root-evil/secret");
    await expect(assertRealWithin(ROOT, link, realpath)).rejects.toThrow(/outside/);
  });
});

describe("utf8SafeEnd", () => {
  // "a€b": '€' is 3 bytes (E2 82 AC), so the buffer is [61, E2, 82, AC, 62].
  const buf = new TextEncoder().encode("a€b");

  it("returns the limit when it lands on a boundary (or past the end)", () => {
    expect(utf8SafeEnd(buf, buf.length)).toBe(5); // whole buffer
    expect(utf8SafeEnd(buf, 100)).toBe(5); // limit beyond the end
    expect(utf8SafeEnd(buf, 1)).toBe(1); // right after 'a'
    expect(utf8SafeEnd(buf, 4)).toBe(4); // right after the full '€'
  });

  it("walks back off a continuation byte so a multi-byte char is never split", () => {
    // A cut at 2 or 3 is mid-'€'; back off to 1 (just after 'a').
    expect(utf8SafeEnd(buf, 2)).toBe(1);
    expect(utf8SafeEnd(buf, 3)).toBe(1);
    // Decoding to that boundary yields no  replacement char.
    expect(new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, utf8SafeEnd(buf, 3)))).toBe("a");
  });
});
