import { describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

import { ClaudeBrain, MessageQueue } from "./claude-brain.ts";
import { type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type ToolGate } from "./brain.ts";

// The streaming-input session (Phase 11.1/11.2) feeds user turns into a held
// query() through this queue. Its correctness hinges on the push/pull ordering:
// a message pushed while `next()` waits must resolve that waiter; messages
// pushed ahead of demand must buffer in order; and `end()` must terminate.
function userMsg(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

describe("MessageQueue", () => {
  it("delivers a message pushed while next() is waiting", async () => {
    const q = new MessageQueue();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next(); // waits - nothing buffered yet
    q.push(userMsg("hello"));
    const r = await pending;
    expect(r.done).toBe(false);
    expect((r.value.message.content as string)).toBe("hello");
  });

  it("buffers messages pushed ahead of demand, in order", async () => {
    const q = new MessageQueue();
    q.push(userMsg("one"));
    q.push(userMsg("two"));
    const it = q[Symbol.asyncIterator]();
    expect((await it.next()).value.message.content).toBe("one");
    expect((await it.next()).value.message.content).toBe("two");
  });

  it("ends the stream, and drops pushes after end", async () => {
    const q = new MessageQueue();
    const it = q[Symbol.asyncIterator]();
    q.end();
    expect((await it.next()).done).toBe(true);
    q.push(userMsg("ignored"));
    expect((await it.next()).done).toBe(true);
  });

  it("wakes a waiting next() on end()", async () => {
    const q = new MessageQueue();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    q.end();
    expect((await pending).done).toBe(true);
  });
});

// 3.6: with includePartialMessages the SDK streams text as `stream_event` deltas so
// the first sentence reaches TTS early; the full `assistant` block that follows must
// be a dedupe fallback, never spoken on top of the deltas.
describe("streamed text deltas + dedupe (3.6)", () => {
  const allowAll: ToolGate = async () => ({ allow: true });
  const brain = () => new ClaudeBrain({ systemPrompt: "sys", mcpServers: {} });
  const delta = (text: string) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });
  const fakeQuery = (msgs: unknown[]) => {
    let i = 0;
    return {
      next: async () => (i < msgs.length ? { value: msgs[i++], done: false } : { value: undefined, done: true }),
      interrupt: async () => {},
      return: async () => ({ value: undefined, done: true }),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
  const result = (text: string) => ({ type: "result", subtype: "success", result: text, usage: {} });

  it("emits deltas as they arrive and does NOT re-emit the whole block", async () => {
    queryMock.mockReturnValue(
      fakeQuery([
        delta("Hello "),
        delta("there."),
        { type: "assistant", message: { content: [{ type: "text", text: "Hello there." }] } },
        result("Hello there."),
      ]),
    );
    const said: string[] = [];
    const out = await brain().run("hi", { gate: allowAll, onText: (t) => said.push(t) });
    expect(said).toEqual(["Hello ", "there."]); // deltas only - block deduped
    expect(out.text).toBe("Hello there.");
  });

  it("falls back to the whole block when no deltas streamed it", async () => {
    queryMock.mockReturnValue(
      fakeQuery([
        { type: "assistant", message: { content: [{ type: "text", text: "No deltas here." }] } },
        result("No deltas here."),
      ]),
    );
    const said: string[] = [];
    await brain().run("hi", { gate: allowAll, onText: (t) => said.push(t) });
    expect(said).toEqual(["No deltas here."]);
  });

  it("resets per assistant message: a later block with no deltas still speaks", async () => {
    queryMock.mockReturnValue(
      fakeQuery([
        delta("First."),
        { type: "assistant", message: { content: [{ type: "text", text: "First." }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Second." }] } },
        result("Second."),
      ]),
    );
    const said: string[] = [];
    await brain().run("hi", { gate: allowAll, onText: (t) => said.push(t) });
    expect(said).toEqual(["First.", "Second."]); // delta for #1, fallback for #2
  });
});
