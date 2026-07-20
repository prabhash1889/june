import { invoke } from "@tauri-apps/api/core";

import { CONTRACT_VERSION } from "../contract/types.ts";
import { type LatencySample, percentile } from "./latency.ts";

// Diagnostics surface for the webview (PLAN.md §4, Phase 7). Thin typed wrappers
// over the Rust probes; the actual network calls (and any secrets) stay in Rust.

export interface BridgeHealth {
  found: boolean;
  healthy: boolean;
  version: string;
  endpoint: string;
  detail: string;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
  ms: number;
}

export function bridgeHealth(): Promise<BridgeHealth> {
  return invoke<BridgeHealth>("bridge_health");
}

/** Probe the selected brain endpoint (Rust reads the key from the keychain). */
export function testBrain(provider: string, baseUrl: string): Promise<ProbeResult> {
  return invoke<ProbeResult>("test_brain", { provider, baseUrl });
}

/** A redacted diagnostics bundle for support (16.5). Structured, and stripped of
 *  anything private: no discovery endpoint/token, no bridge `detail` (it can name
 *  a local path/pid), no transcript content - only booleans, versions, and the
 *  latency percentiles. Numbers/percentiles are safe to share. */
export interface DiagnosticsReport {
  generatedAt: string;
  contractVersion: number;
  bridge: { found: boolean; healthy: boolean; version: string };
  latency: {
    samples: number;
    p50: number;
    p95: number;
    stagesP50: { stt: number; brain: number; tts: number };
  };
}

export function buildDiagnosticsReport(
  health: BridgeHealth | null,
  samples: LatencySample[],
  generatedAt: string,
): DiagnosticsReport {
  const totals = samples.map((s) => s.total);
  const stageP50 = (pick: (s: LatencySample) => number) => percentile(samples.map(pick), 50);
  return {
    generatedAt,
    contractVersion: CONTRACT_VERSION,
    bridge: {
      found: health?.found ?? false,
      healthy: health?.healthy ?? false,
      version: health?.version ?? "",
    },
    latency: {
      samples: samples.length,
      p50: percentile(totals, 50),
      p95: percentile(totals, 95),
      stagesP50: { stt: stageP50((s) => s.stt), brain: stageP50((s) => s.brain), tts: stageP50((s) => s.tts) },
    },
  };
}
