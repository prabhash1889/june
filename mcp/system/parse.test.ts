// The parsing/matching/formatting is the only non-trivial logic in the system
// observe pack (4.3): `tasklist` CSV quirks, ".exe"-insensitive matching, and the
// stats rounding. Exercised directly - no shell-out, no live OS needed.

import { describe, expect, it } from "vitest";

import {
  countProcesses,
  isProcessRunning,
  parseCsvLine,
  parseMemCell,
  parseTasklistCsv,
  summarizeStats,
  type ProcessInfo,
} from "./parse.ts";

describe("parseCsvLine", () => {
  it("splits a plain quoted tasklist row", () => {
    expect(parseCsvLine('"chrome.exe","1234","Console","1","123,456 K"')).toEqual([
      "chrome.exe",
      "1234",
      "Console",
      "1",
      "123,456 K",
    ]);
  });

  it("keeps a comma that lives inside a quoted field", () => {
    // The memory column "123,456 K" must stay one field, not split on its comma.
    const f = parseCsvLine('"a.exe","5","Console","1","1,234 K"');
    expect(f).toHaveLength(5);
    expect(f[4]).toBe("1,234 K");
  });
});

describe("parseMemCell", () => {
  it("parses a KB cell into bytes", () => {
    expect(parseMemCell("123,456 K")).toBe(123456 * 1024);
    expect(parseMemCell("8 K")).toBe(8 * 1024);
  });

  it("returns null for N/A or empty cells", () => {
    expect(parseMemCell("N/A")).toBeNull();
    expect(parseMemCell("")).toBeNull();
  });
});

describe("parseTasklistCsv", () => {
  const stdout = ['"System Idle Process","0","Services","0","8 K"', '"node.exe","4321","Console","1","98,304 K"', ""].join(
    "\r\n",
  );

  it("parses rows and skips blank lines", () => {
    const procs = parseTasklistCsv(stdout);
    expect(procs).toEqual([
      { name: "System Idle Process", pid: 0, memBytes: 8 * 1024 },
      { name: "node.exe", pid: 4321, memBytes: 98304 * 1024 },
    ]);
  });

  it("skips a row without a numeric PID rather than throwing", () => {
    const procs = parseTasklistCsv('"broken.exe","not-a-pid","Console","1","1 K"');
    expect(procs).toEqual([]);
  });
});

describe("countProcesses / isProcessRunning", () => {
  const procs: ProcessInfo[] = [
    { name: "chrome.exe", pid: 1, memBytes: null },
    { name: "chrome.exe", pid: 2, memBytes: null },
    { name: "node.exe", pid: 3, memBytes: null },
  ];

  it("matches case-insensitively and ignores the .exe suffix", () => {
    expect(countProcesses("Chrome", procs)).toBe(2);
    expect(countProcesses("chrome.exe", procs)).toBe(2);
    expect(countProcesses("NODE", procs)).toBe(1);
    expect(isProcessRunning("chrome", procs)).toBe(true);
  });

  it("returns 0/false for a missing process and an empty query", () => {
    expect(countProcesses("firefox", procs)).toBe(0);
    expect(isProcessRunning("firefox", procs)).toBe(false);
    expect(countProcesses("  ", procs)).toBe(0);
  });
});

describe("summarizeStats", () => {
  it("computes memory usage, percent, and uptime", () => {
    const s = summarizeStats({
      platform: "win32",
      cpuCount: 8,
      totalMemBytes: 16 * 1024 ** 3,
      freeMemBytes: 4 * 1024 ** 3,
      uptimeSeconds: 7200,
      loadAvg1: 0, // Windows
    });
    expect(s).toEqual({
      platform: "win32",
      cpuCount: 8,
      memoryUsedGiB: 12,
      memoryTotalGiB: 16,
      memoryUsedPercent: 75,
      uptimeHours: 2,
    });
    // loadAverage is omitted when 0 (Windows always reports 0).
    expect(s).not.toHaveProperty("loadAverage1min");
  });

  it("includes load average when meaningful (non-Windows)", () => {
    const s = summarizeStats({
      platform: "linux",
      cpuCount: 4,
      totalMemBytes: 8 * 1024 ** 3,
      freeMemBytes: 8 * 1024 ** 3,
      uptimeSeconds: 3600,
      loadAvg1: 1.234,
    });
    expect(s.loadAverage1min).toBe(1.23);
    expect(s.memoryUsedPercent).toBe(0);
  });
});
