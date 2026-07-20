import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

import { VoicePanel } from "./VoicePanel.tsx";

function mockCommands(has: boolean) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "has_api_key") return Promise.resolve(has);
    if (cmd === "pending_approval") return Promise.resolve(null);
    if (cmd === "read_mission") return Promise.resolve(""); // no active mission (Phase 19.1)
    throw new Error(`unexpected command ${cmd}`);
  });
}

it("shows the push-to-talk prompt once a key is present", async () => {
  mockCommands(true);
  render(<VoicePanel />);
  expect(await screen.findByText(/Hold Ctrl \+ Shift \+ Space/)).toBeInTheDocument();
});

it("prompts for an OpenAI key when none is set", async () => {
  mockCommands(false);
  render(<VoicePanel />);
  expect(await screen.findByText(/Add an OpenAI API key/)).toBeInTheDocument();
});
