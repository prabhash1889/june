import { vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

import { recoverInterruptedMission, runnerState, startMission } from "./mission-runner.ts";

// The improvement-5 P0.3 regressions this locks in: the runner used to live in the
// tab-mounted MissionBoard, so a remount reset `running` (allowing a second
// concurrent mission) and a closed window left the persisted board stuck "active".

/** Mock the backend: decompose returns one task, task runs succeed, and every
 *  write_mission is recorded so assertions can see the board's lifecycle. */
function mockBackend(written: string[]) {
  invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "new_conversation") return Promise.resolve();
    if (cmd === "run_agent") {
      const transcript = String(args?.transcript ?? "");
      const text = transcript.startsWith("Break this outcome") ? "1. Only task" : "did it";
      return Promise.resolve({ text, isError: false });
    }
    if (cmd === "write_mission") {
      written.push(String(args?.content ?? ""));
      return Promise.resolve();
    }
    throw new Error(`unexpected command ${cmd}`);
  });
}

it("guards against a double start: the second call is a no-op", async () => {
  const written: string[] = [];
  mockBackend(written);
  const first = startMission("ship the release");
  expect(runnerState().running).toBe(true);
  const second = startMission("ship the release"); // remounted board re-clicks Start
  await Promise.all([first, second]);
  expect(runnerState().running).toBe(false);
  // Exactly one mission ran: one run_agent decompose + one task, not two of each.
  const runs = invoke.mock.calls.filter(([cmd]) => cmd === "run_agent");
  expect(runs).toHaveLength(2);
  const finalBoard = JSON.parse(written[written.length - 1]);
  expect(finalBoard.status).toBe("done");
});

it("recovers a board left active by a dead runner, and leaves live ones alone", async () => {
  const written: string[] = [];
  const stuck = {
    id: "m",
    outcome: "left behind",
    tasks: [{ id: "t0", title: "half done", status: "active" }],
    status: "active",
    toolsetIds: [],
  };
  invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "read_mission") return Promise.resolve(JSON.stringify(stuck));
    if (cmd === "write_mission") {
      written.push(String(args?.content ?? ""));
      return Promise.resolve();
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  await recoverInterruptedMission();
  const closed = JSON.parse(written[0]);
  expect(closed.status).toBe("failed");
  expect(closed.tasks[0].status).toBe("failed");

  // A finished board needs no recovery: nothing further is written.
  written.length = 0;
  stuck.status = "done";
  stuck.tasks[0].status = "done";
  await recoverInterruptedMission();
  expect(written).toHaveLength(0);
});
