import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import { mapToText, textToMap } from "../lib/kv-map.ts";
import { MapTextarea } from "./MapTextarea.tsx";

it("keeps a half-typed line instead of eating its first character (B2.4)", () => {
  const onCommit = vi.fn();
  render(<MapTextarea map={{}} onCommit={onCommit} />);
  const area = screen.getByRole("textbox") as HTMLTextAreaElement;

  // A new line still being typed - "june" before its "=" - has no key/value yet.
  // The pre-fix control re-derived value from the parsed (empty) map, so this
  // character vanished. It must survive in the editor.
  fireEvent.change(area, { target: { value: "june" } });
  expect(area.value).toBe("june");
  expect(onCommit).not.toHaveBeenCalled(); // nothing committed mid-typing

  // Finish the line and blur: now it parses to a map.
  fireEvent.change(area, { target: { value: "june = June" } });
  fireEvent.blur(area);
  expect(onCommit).toHaveBeenCalledWith({ june: "June" });
});

it("re-syncs when the incoming map changes externally", () => {
  const onCommit = vi.fn();
  const { rerender } = render(<MapTextarea map={{ a: "1" }} onCommit={onCommit} />);
  const area = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(area.value).toBe("a=1");

  rerender(<MapTextarea map={{ a: "1", b: "2" }} onCommit={onCommit} />);
  expect(area.value).toBe("a=1\nb=2");
});

it("round-trips complete lines and drops incomplete ones", () => {
  expect(textToMap("a=1\nb=2")).toEqual({ a: "1", b: "2" });
  expect(textToMap("a=1\njune")).toEqual({ a: "1" }); // incomplete line dropped
  expect(mapToText({ a: "1", b: "2" })).toBe("a=1\nb=2");
});
