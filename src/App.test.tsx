import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

import { App } from "./App.tsx";

it("shows the push-to-talk prompt once a key is present", async () => {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "has_api_key") return Promise.resolve(true);
    throw new Error(`unexpected command ${cmd}`);
  });

  render(<App />);

  expect(await screen.findByText(/Hold Ctrl \+ Shift \+ Space/)).toBeInTheDocument();
});

it("prompts for an OpenAI key when none is set", async () => {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "has_api_key") return Promise.resolve(false);
    throw new Error(`unexpected command ${cmd}`);
  });

  render(<App />);

  expect(await screen.findByText(/Add an OpenAI API key/)).toBeInTheDocument();
});
