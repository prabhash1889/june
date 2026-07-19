import { invoke } from "@tauri-apps/api/core";

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
