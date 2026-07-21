import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const runAgent = vi.hoisted(() => vi.fn(() => Promise.resolve({ text: "", isError: false })));
vi.mock("../lib/stt.ts", () => ({ runAgent }));

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

it("routes views with Ctrl+1..4 and focuses the composer with '/' (6.6)", async () => {
  // Benign nulls for every panel command - the panels coerce defensively.
  invoke.mockImplementation((cmd: string) =>
    Promise.resolve(cmd === "session_events" ? [] : null),
  );
  render(<AppWindow />);
  await screen.findByText("June");

  fireEvent.keyDown(window, { key: "3", ctrlKey: true });
  expect(screen.getByRole("button", { name: /Runs/ })).toHaveAttribute("aria-current", "page");

  fireEvent.keyDown(window, { key: "1", ctrlKey: true });
  expect(screen.getByRole("button", { name: "Conversation" })).toHaveAttribute("aria-current", "page");

  const composer = screen.getByLabelText("Type a command for June");
  fireEvent.keyDown(window, { key: "/" });
  await vi.waitFor(() => expect(composer).toHaveFocus());

  // "/" while already typing in the field must not be hijacked.
  fireEvent.keyDown(composer, { key: "/" });
  expect(composer).toHaveFocus();
});

it("dispatches exactly one turn when a typed command is sent with Enter", async () => {
  runAgent.mockClear();
  mockCommands([]);
  render(<AppWindow />);
  const composer = await screen.findByLabelText("Type a command for June");
  fireEvent.change(composer, { target: { value: "open two agents" } });
  fireEvent.keyDown(composer, { key: "Enter" });

  await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
  expect(runAgent).toHaveBeenCalledWith("open two agents", expect.any(Number));
  expect(composer).toHaveValue(""); // cleared after send
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
