// Shared helpers for the settings sections (improvement-8 2.2: SettingsPanel was
// one 2200-line file; sections now live under src/app/settings/ and lean on this
// for the bits they all need).

/** Narrow an unknown thrown value to a display string. */
export function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
