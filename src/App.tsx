import { useEffect, useState } from "react";
import { loadSettings, saveSettings } from "./lib/settings.ts";

// Phase 0: empty foundation window. Round-trips a launch count through the
// settings store so the persistence wiring is exercised, not just wired up.
export function App() {
  const [launchCount, setLaunchCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadSettings().then((settings) => {
      if (cancelled) return;
      const count = typeof settings.launchCount === "number" ? settings.launchCount + 1 : 1;
      setLaunchCount(count);
      void saveSettings({ ...settings, launchCount: count });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app">
      <div className="dot" />
      <h1>June</h1>
      <p>{launchCount === null ? "Loading settings…" : `Opened ${launchCount} time(s)`}</p>
    </div>
  );
}
