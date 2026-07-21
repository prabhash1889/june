import { type ReactNode } from "react";

import { isSafeLinkTarget } from "./safe-link.ts";

// Tiny markdown subset for June's reply bubbles (3.3). Replies carry file paths,
// shell commands, and lists; rendered as flat text they lose every structural cue.
// This covers the felt subset - fenced/inline code (with a copy button on blocks),
// **bold**, [links], and -/* /1. lists - with NO raw-HTML path (every node is a
// React element, so an injected `<script>` is inert text) and NO dependency.
//
// ponytail: links are click-to-copy, not open-in-browser. The webview has no opener
// seam and adding a Tauri opener plugin is a whole dependency for one affordance;
// copying the URL is safe (no webview navigation) and useful. Only http(s) and
// filesystem-path targets render as a link at all (isSafeLinkTarget) - a
// `javascript:`/custom-scheme target stays plain text, so markdown can never smuggle
// a dangerous target in. Upgrade to open-in-default-handler if a validated opener
// command ever lands.

// One combined matcher for the inline spans, tried left-to-right: inline code
// first so `**` inside a code span isn't mistaken for bold.
const INLINE = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\[[^\]]+\]\([^)]+\))/g;
const LINK = /^\[([^\]]+)\]\(([^)]+)\)$/;

/** Render one line of inline markdown to React nodes. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  let i = 0;
  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (tok.startsWith("`")) {
      out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    } else {
      const lm = LINK.exec(tok)!;
      out.push(<MdLink key={k} label={lm[1]} href={lm[2]} />);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A click-to-copy link (see the ponytail note above). Falls back to plain text
 *  for an unsafe target so a bad scheme is never presented as actionable. */
function MdLink({ label, href }: { label: string; href: string }) {
  if (!isSafeLinkTarget(href)) return <>{label}</>;
  return (
    <button
      type="button"
      className="md-link"
      title={`Copy link: ${href}`}
      onClick={() => void navigator.clipboard?.writeText(href).catch(() => {})}
    >
      {label}
    </button>
  );
}

/** A fenced code block with a copy button (3.3). */
function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="md-pre">
      <button
        type="button"
        className="md-copy"
        title="Copy code"
        aria-label="Copy code"
        onClick={() => void navigator.clipboard?.writeText(code).catch(() => {})}
      >
        Copy
      </button>
      <code>{code}</code>
    </pre>
  );
}

const UL = /^[-*]\s+(.*)$/;
const OL = /^\d+\.\s+(.*)$/;

/** Render a markdown-subset string. Splits on fenced ``` blocks first (so nothing
 *  inside a block is reformatted), then groups list runs and renders remaining
 *  lines as paragraphs with inline formatting. */
export function Markdown({ text }: { text: string }): ReactNode {
  // Odd-indexed segments are the insides of ``` fences (the language line, if any,
  // is stripped); even-indexed are normal prose.
  const segments = text.split(/```/);
  const blocks: ReactNode[] = [];
  segments.forEach((seg, si) => {
    if (si % 2 === 1) {
      let body = seg;
      const nl = body.indexOf("\n");
      if (nl >= 0) {
        // Drop a bare language line (a single token, e.g. "bash"/"ts", or empty);
        // keep it if the first line already looks like code.
        const first = body.slice(0, nl).trim();
        if (first === "" || /^[\w+-]+$/.test(first)) body = body.slice(nl + 1);
      }
      blocks.push(<CodeBlock key={`c${si}`} code={body.replace(/\n$/, "")} />);
      return;
    }
    if (!seg) return;
    // Group consecutive lines into paragraphs / list runs.
    const lines = seg.split("\n");
    let list: { ordered: boolean; items: string[] } | null = null;
    const flushList = (key: string) => {
      if (!list) return;
      const items = list.items.map((it, i) => <li key={i}>{inline(it, `${key}-${i}`)}</li>);
      blocks.push(list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
      list = null;
    };
    lines.forEach((line, li) => {
      const key = `${si}-${li}`;
      const ul = UL.exec(line);
      const ol = OL.exec(line);
      if (ul || ol) {
        const ordered = !!ol;
        if (!list || list.ordered !== ordered) flushList(`l${key}`);
        list ??= { ordered, items: [] };
        list.items.push((ul ?? ol)![1]);
        return;
      }
      flushList(`l${key}`);
      if (line.trim())
        blocks.push(
          <p key={`p${key}`} className="md-p">
            {inline(line, key)}
          </p>,
        );
    });
    flushList(`l${si}-end`);
  });
  return <>{blocks}</>;
}
