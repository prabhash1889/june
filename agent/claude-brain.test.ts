import { describe, expect, it } from "vitest";

import { MessageQueue } from "./claude-brain.ts";
import { type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

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
