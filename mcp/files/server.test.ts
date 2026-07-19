// Path containment is the one security-critical bit of the files capability
// (§5): a voice command must never reach a file outside the allowed root. These
// exercise the resolver directly - no filesystem, no server needed. The server
// itself sets ROOT at import time from JUNE_FILES_ROOT, so we test the exported
// pure function rather than the module.

import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveWithin } from "./paths.ts";

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
