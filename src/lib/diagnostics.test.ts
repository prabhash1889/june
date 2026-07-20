import { describe, expect, it } from "vitest";

import { buildDiagnosticsReport } from "./diagnostics.ts";
import { type LatencySample } from "./latency.ts";

// The diagnostics export is a support bundle, so its one job is to stay REDACTED:
// versions and latency percentiles only, never the discovery endpoint/token, the
// bridge `detail` string (it can name a local path/pid), or any transcript (16.5).

const sample = (total: number): LatencySample => ({ stt: 100, brain: total - 300, tts: 200, total });

describe("buildDiagnosticsReport", () => {
  it("summarizes health + latency without leaking endpoint/token/detail", () => {
    const health = {
      found: true,
      healthy: true,
      version: "1.2.3",
      endpoint: "http://127.0.0.1:54321",
      detail: "reachable at C:\\Users\\me\\bridge (pid 999)",
    };
    const report = buildDiagnosticsReport(health, [sample(700), sample(1500)], "2026-07-20T00:00:00.000Z");

    expect(report).toEqual({
      generatedAt: "2026-07-20T00:00:00.000Z",
      contractVersion: 1,
      bridge: { found: true, healthy: true, version: "1.2.3" },
      latency: { samples: 2, p50: 700, p95: 1500, stagesP50: { stt: 100, brain: 400, tts: 200 } },
    });
    // The redaction guarantee: nothing sensitive rode along.
    const json = JSON.stringify(report);
    expect(json).not.toContain("127.0.0.1");
    expect(json).not.toContain("pid 999");
    expect(json).not.toContain("Users");
  });

  it("degrades safely with no bridge and no samples", () => {
    const report = buildDiagnosticsReport(null, [], "2026-07-20T00:00:00.000Z");
    expect(report.bridge).toEqual({ found: false, healthy: false, version: "" });
    expect(report.latency).toEqual({ samples: 0, p50: 0, p95: 0, stagesP50: { stt: 0, brain: 0, tts: 0 } });
  });
});
