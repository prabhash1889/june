import { useEffect, useRef, useState } from "react";

import { mapToText, textToMap } from "../lib/kv-map.ts";

// A textarea over a `KEY=value` map (the shape Claude Desktop's mcp.json uses for
// env/headers, and June's dictionary/snippets). Binding the value straight to
// `mapToText(map)` and parsing on every keystroke (the pre-B2.4 code) ate the
// first character of any new line: "june" typed before its "=" parsed to nothing,
// so the map didn't change and the re-render dropped the character. Here the RAW
// text lives in local state so an in-progress line can exist; the map is committed
// (parsed) only when focus leaves. It re-syncs when the incoming map changes to
// something other than what we last committed - e.g. the dictionary grew itself
// from a review-gate correction - so an external update isn't lost either.

export function MapTextarea({
  map,
  onCommit,
  className,
  rows,
  placeholder,
}: {
  map: Record<string, string>;
  onCommit: (m: Record<string, string>) => void;
  className?: string;
  rows?: number;
  placeholder?: string;
}) {
  const [raw, setRaw] = useState(() => mapToText(map));
  const committed = useRef(map);
  useEffect(() => {
    // Only an EXTERNAL change (a map we didn't just commit) resets the editor; our
    // own commits set `committed` to the same object, so typing is never clobbered.
    if (map !== committed.current) {
      committed.current = map;
      setRaw(mapToText(map));
    }
  }, [map]);

  const commit = () => {
    const next = textToMap(raw);
    committed.current = next;
    onCommit(next);
  };

  return (
    <textarea
      className={className}
      rows={rows}
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={commit}
      placeholder={placeholder}
    />
  );
}
