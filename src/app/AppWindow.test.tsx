import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

import { AppWindow } from "./AppWindow.tsx";

function mockCommands(history: Array<{ name: string; payload: Record<string, unknown> }>) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "pending_approval") return Promise.resolve(null);
    if (cmd === "session_events") return Promise.resolve(history);
    throw new Error(`unexpected command ${cmd}`);
  });
}

it("renders the conversation shell with an empty state", async () => {
  mockCommands([]);
  render(<AppWindow />);
  expect(await screen.findByText("June")).toBeInTheDocument();
  expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
});

it("replays the recorded session when opened mid-session", async () => {
  mockCommands([
    { name: "agent://user", payload: { seq: 1, turn: 1, text: "open two claude agents" } },
    { name: "agent://tool", payload: { seq: 2, turn: 1, action: "spawn_agents" } },
    {
      name: "agent://result",
      payload: { seq: 3, turn: 1, action: "spawn_agents", res: { counts: { requested: 2, started: 2 } }, isError: false },
    },
    { name: "agent://final", payload: { seq: 4, turn: 1, text: "Started two agents.", isError: false } },
  ]);
  render(<AppWindow />);
  expect(await screen.findByText("open two claude agents")).toBeInTheDocument();
  expect(screen.getByText("Started two agents.")).toBeInTheDocument();
  expect(screen.getByText(/started 2 of 2/)).toBeInTheDocument();
  expect(screen.queryByText(/Nothing yet/)).not.toBeInTheDocument();
});
