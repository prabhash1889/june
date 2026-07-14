import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { App } from "./App.tsx";

it("loads settings, bumps the launch count, and persists it back", async () => {
  invoke.mockImplementation((cmd: string, args?: { settings?: Record<string, unknown> }) => {
    if (cmd === "load_settings") return Promise.resolve({ launchCount: 2 });
    if (cmd === "save_settings") return Promise.resolve(args?.settings);
    throw new Error(`unexpected command ${cmd}`);
  });

  render(<App />);

  expect(await screen.findByText("Opened 3 time(s)")).toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith("save_settings", { settings: { launchCount: 3 } });
});
