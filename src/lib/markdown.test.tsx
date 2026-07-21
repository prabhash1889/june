import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Markdown } from "./markdown.tsx";
import { isSafeLinkTarget } from "./safe-link.ts";

// 3.3: the reply md subset renderer. It must structure the felt cases (code,
// bold, lists, links) into real elements, never a raw-HTML path, and never
// present a dangerous link scheme as clickable.
describe("Markdown", () => {
  it("renders inline code, bold, and a fenced block with a copy button", () => {
    render(<Markdown text={"Run `npm test` and be **sure**.\n```bash\nnpm run build\n```"} />);
    expect(screen.getByText("npm test").tagName).toBe("CODE");
    expect(screen.getByText("sure").tagName).toBe("STRONG");
    // The fenced block dropped its `bash` language line and kept the code.
    expect(screen.getByText("npm run build").tagName).toBe("CODE");
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
  });

  it("groups -/1. runs into ul/ol lists", () => {
    const { container } = render(<Markdown text={"- one\n- two\n\n1. first\n2. second"} />);
    expect(container.querySelectorAll("ul li").length).toBe(2);
    expect(container.querySelectorAll("ol li").length).toBe(2);
  });

  it("renders a safe link as a clickable affordance and an unsafe one as plain text", () => {
    const { container } = render(
      <Markdown text="See [docs](https://example.com) but not [x](javascript:alert(1))" />,
    );
    const link = screen.getByRole("button", { name: "docs" });
    expect(link.getAttribute("title")).toContain("https://example.com");
    // The javascript: target never becomes a button - it's inert text.
    expect(screen.queryByRole("button", { name: "x" })).toBeNull();
    expect(container.textContent).toContain("x");
  });

  it("never emits raw HTML from the reply text", () => {
    const { container } = render(<Markdown text="<script>alert(1)</script>" />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});

describe("isSafeLinkTarget", () => {
  it("accepts http(s) and filesystem paths, rejects other schemes", () => {
    expect(isSafeLinkTarget("https://x.com")).toBe(true);
    expect(isSafeLinkTarget("C:\\Users\\me\\file.txt")).toBe(true);
    expect(isSafeLinkTarget("./relative/path")).toBe(true);
    expect(isSafeLinkTarget("javascript:alert(1)")).toBe(false);
    expect(isSafeLinkTarget("file:///etc/passwd")).toBe(false);
    expect(isSafeLinkTarget("")).toBe(false);
  });
});
