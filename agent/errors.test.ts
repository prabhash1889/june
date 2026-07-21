import { describe, expect, it } from "vitest";

import { friendlyApiError, statusFromMessage } from "./errors.ts";

describe("friendlyApiError (2.5)", () => {
  it("maps auth/rate-limit/not-found and 5xx to short spoken lines", () => {
    expect(friendlyApiError(401)).toMatch(/key/i);
    expect(friendlyApiError(403)).toMatch(/key/i);
    expect(friendlyApiError(429)).toMatch(/rate-limited/i);
    expect(friendlyApiError(404)).toMatch(/model or endpoint/i);
    expect(friendlyApiError(503)).toMatch(/trouble/i);
  });

  it("never returns a raw body and falls back to null for unmapped codes", () => {
    expect(friendlyApiError(418)).toBeNull();
    expect(friendlyApiError(200)).toBeNull();
    // The mapped lines are one short sentence - no JSON, no braces.
    for (const code of [401, 429, 404, 500]) expect(friendlyApiError(code)).not.toMatch(/[{}]/);
  });
});

describe("statusFromMessage (2.5)", () => {
  it("pulls a recognizable HTTP status out of an SDK error string", () => {
    expect(statusFromMessage('API error 401: {"error":"bad key"}')).toBe(401);
    expect(statusFromMessage("Request failed with status 429")).toBe(429);
    expect(statusFromMessage("upstream returned 503")).toBe(503);
    expect(statusFromMessage("connection reset")).toBeNull();
  });
});
