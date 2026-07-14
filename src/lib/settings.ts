import { invoke } from "@tauri-apps/api/core";

// Generic JSON bag persisted to `<app_data_dir>/settings.json` by the Rust side
// (src-tauri/src/settings.rs). Later phases add typed fields (STT/brain/TTS
// provider choices, activation mode, etc.) on top of this same store.
export type Settings = Record<string, unknown>;

export function loadSettings(): Promise<Settings> {
  return invoke<Settings>("load_settings");
}

export function saveSettings(settings: Settings): Promise<void> {
  return invoke("save_settings", { settings });
}
