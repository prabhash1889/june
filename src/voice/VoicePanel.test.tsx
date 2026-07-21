import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

// A controllable stand-in for the Tauri event bus: the pipeline subscribes with
// listen(); tests drive the flow by emit()-ing the same events the Rust shell
// would (ptt://down, ptt://up, …). Lives in vi.hoisted so the module mock can
// reach it (vi.mock factories are hoisted above the imports).
const bus = vi.hoisted(() => {
  const handlers = new Map<string, Set<(e: { payload: unknown }) => void>>();
  return {
    listen: (event: string, cb: (e: { payload: unknown }) => void) => {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      set.add(cb);
      return Promise.resolve(() => set.delete(cb));
    },
    emit: (event: string, payload?: unknown) => handlers.get(event)?.forEach((h) => h({ payload })),
    reset: () => handlers.clear(),
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: bus.listen }));

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

// The IO edges the pipeline sequences - stubbed so a test can round-trip a turn
// without a real mic, network STT, or brain.
const stt = vi.hoisted(() => ({
  transcribe: vi.fn(),
  runAgent: vi.fn(),
  hasOpenAiKey: vi.fn(),
  injectText: vi.fn(),
  appendInbox: vi.fn(),
  setOpenAiKey: vi.fn(),
}));
vi.mock("../lib/stt.ts", () => stt);

const captureMock = vi.hoisted(() => ({
  startCapture: vi.fn(),
  startBargeMonitor: vi.fn(() => Promise.resolve(() => {})),
  LEVEL_GAIN: 8,
}));
vi.mock("../lib/voice-capture.ts", () => captureMock);

vi.mock("../lib/wake.ts", () => ({
  startWakeListener: vi.fn(() => Promise.resolve({ stop: () => {} })),
}));

// Keep the real SentenceBuffer/CANNED_PHRASES (pure) but replace SpeechQueue with
// a no-op that reports idle immediately - so accept() finishes the turn instead
// of hanging on real synthesis in jsdom.
vi.mock("../lib/tts.ts", async (orig) => {
  const actual = await orig<typeof import("../lib/tts.ts")>();
  class FakeQueue {
    constructor(_onDrain?: () => void) {}
    get idle() {
      return true;
    }
    enqueue() {}
    stop() {}
  }
  return { ...actual, SpeechQueue: FakeQueue };
});

const settingsMock = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(() => Promise.resolve()),
}));
vi.mock("../lib/settings.ts", async (orig) => {
  const actual = await orig<typeof import("../lib/settings.ts")>();
  return { ...actual, loadSettings: settingsMock.loadSettings, saveSettings: settingsMock.saveSettings };
});

import { VoicePanel } from "./VoicePanel.tsx";
import { DEFAULT_SETTINGS } from "../lib/settings.ts";

function fakeHandle() {
  return {
    stop: vi.fn().mockResolvedValue({ audio: new Uint8Array([1, 2, 3]), mime: "audio/webm" }),
    cancel: vi.fn(),
    heardSpeech: () => true,
    level: () => 0,
  };
}

beforeEach(() => {
  bus.reset();
  vi.clearAllMocks();
  invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "read_mission" ? "" : null));
  settingsMock.loadSettings.mockResolvedValue(DEFAULT_SETTINGS);
  settingsMock.saveSettings.mockResolvedValue(undefined);
  stt.hasOpenAiKey.mockResolvedValue(true);
  stt.transcribe.mockResolvedValue("turn on the lights");
  stt.runAgent.mockResolvedValue({ text: "Lights on.", isError: false });
  captureMock.startCapture.mockResolvedValue(fakeHandle());
});

it("shows the push-to-talk prompt once a key is present", async () => {
  render(<VoicePanel />);
  expect(await screen.findByText(/Hold Ctrl \+ Shift \+ Space/)).toBeInTheDocument();
});

it("prompts for an OpenAI key when none is set", async () => {
  stt.hasOpenAiKey.mockResolvedValue(false);
  render(<VoicePanel />);
  expect(await screen.findByText(/Add an OpenAI API key/)).toBeInTheDocument();
});

it("PTT down/up round-trips a transcript and accept dispatches exactly one turn", async () => {
  render(<VoicePanel />);
  await screen.findByText(/Hold Ctrl \+ Shift \+ Space/);

  await act(async () => bus.emit("ptt://down"));
  await screen.findByText("Listening…");
  expect(captureMock.startCapture).toHaveBeenCalledTimes(1);

  await act(async () => bus.emit("ptt://up"));
  const send = await screen.findByRole("button", { name: /Send to June/ });
  fireEvent.click(send);

  await waitFor(() => expect(stt.runAgent).toHaveBeenCalledTimes(1));
  expect(stt.runAgent).toHaveBeenCalledWith(expect.stringContaining("lights"), expect.any(Number));
});

it("ignores push-to-talk while the mic is muted", async () => {
  settingsMock.loadSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, micMuted: true });
  render(<VoicePanel />);
  await screen.findByText(/Hold Ctrl \+ Shift \+ Space/);
  await waitFor(() => expect(settingsMock.loadSettings).toHaveBeenCalled());
  await act(async () => {}); // flush the refreshSettings continuation that sets micMutedRef

  await act(async () => bus.emit("ptt://down"));
  expect(captureMock.startCapture).not.toHaveBeenCalled();
});

it("recovers from a mic-open failure on the next press", async () => {
  captureMock.startCapture.mockRejectedValueOnce({ message: "Could not start the microphone." });
  render(<VoicePanel />);
  await screen.findByText(/Hold Ctrl \+ Shift \+ Space/);

  await act(async () => bus.emit("ptt://down"));
  await screen.findByText(/Could not start the microphone/);

  captureMock.startCapture.mockResolvedValue(fakeHandle());
  await act(async () => bus.emit("ptt://down"));
  expect(await screen.findByText("Listening…")).toBeInTheDocument();
});
