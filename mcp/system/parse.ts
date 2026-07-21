// Pure helpers for the system observe pack (improvement-6 4.3). Kept side-effect-
// free and separate from server.ts so the parsing/matching/formatting can be
// unit-tested without shelling out to `tasklist` or touching the real OS. The
// server does the shell-out; this module does the string/number math.

/** One running process, as parsed from `tasklist /FO CSV /NH`. */
export interface ProcessInfo {
  name: string;
  pid: number;
  /** Working-set size in bytes, or null when the column is "N/A"/unparseable. */
  memBytes: number | null;
}

/** Parse one CSV line from `tasklist /FO CSV /NH`, honoring quoted fields (a
 *  field may itself contain a comma, e.g. the "123,456 K" memory column). Returns
 *  the raw field strings. A minimal parser - tasklist never emits escaped quotes,
 *  so `""` handling is unnecessary. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/** Parse a `tasklist` memory cell like `"123,456 K"` into bytes. Returns null for
 *  "N/A" (system processes) or anything unparseable, so a weird cell never throws. */
export function parseMemCell(cell: string): number | null {
  const digits = cell.replace(/[^0-9]/g, "");
  if (!digits) return null;
  // The value is in KB (the trailing " K"); convert to bytes.
  return Number(digits) * 1024;
}

/** Parse the full stdout of `tasklist /FO CSV /NH` into a process list. Blank
 *  lines and rows without a numeric PID are skipped rather than throwing, so a
 *  partial/garbled tail never poisons the whole list. */
export function parseTasklistCsv(stdout: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (f.length < 5) continue;
    const pid = Number(f[1]);
    if (!Number.isInteger(pid)) continue;
    out.push({ name: f[0], pid, memBytes: parseMemCell(f[4]) });
  }
  return out;
}

/** Normalize a process name for matching: lowercase, strip a trailing ".exe" so
 *  "chrome", "Chrome", and "chrome.exe" all compare equal. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.exe$/, "");
}

/** How many processes in the list match the query name (case-insensitive,
 *  ".exe"-insensitive). 0 means not running. Used by process_running. */
export function countProcesses(query: string, processes: ProcessInfo[]): number {
  const q = normalizeName(query);
  if (!q) return 0;
  return processes.filter((p) => normalizeName(p.name) === q).length;
}

/** Whether any process in the list matches the query name. */
export function isProcessRunning(query: string, processes: ProcessInfo[]): boolean {
  return countProcesses(query, processes) > 0;
}

/** The foreground window's metadata (improvement-6 4.4) - what the user is looking
 *  at, without any display capture. */
export interface ActiveContext {
  /** Window title, e.g. a document name or a browser tab title. "" if untitled. */
  title: string;
  /** Owning process name (no ".exe"), e.g. "chrome"; null if it couldn't resolve. */
  processName: string | null;
  /** Owning process id; null if it couldn't resolve. */
  pid: number | null;
}

/** Parse the JSON the foreground-window PowerShell helper emits into an
 *  ActiveContext, defensively: a blank/garbled payload (no foreground window, or a
 *  PowerShell error on stdout) yields an empty context rather than throwing, so the
 *  tool degrades to "nothing focused" instead of a crash. */
export function parseActiveContext(stdout: string): ActiveContext {
  const empty: ActiveContext = { title: "", processName: null, pid: null };
  const text = stdout.trim();
  if (!text) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  if (typeof raw !== "object" || raw === null) return empty;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title : "";
  const processName = typeof r.processName === "string" && r.processName ? r.processName : null;
  const pid = typeof r.pid === "number" && Number.isInteger(r.pid) && r.pid > 0 ? r.pid : null;
  return { title, processName, pid };
}

/** A validated open_path target (improvement-6 4.6): either an http(s) URL or a
 *  local filesystem path. The `kind` lets the server decide whether to existence-
 *  check (paths) or not (URLs). */
export interface OpenTarget {
  kind: "url" | "path";
  value: string;
}

/** Validate an open_path target before it is handed to the OS default handler.
 *  Accepts an http(s) URL or a filesystem path (absolute, relative, or UNC), and
 *  REJECTS anything else - control characters (injection/spoofing) and, crucially,
 *  any `scheme:` prefix that is not http(s) or a `C:`-style drive letter. That last
 *  rule blocks custom protocol handlers (`javascript:`, `file:`, a registered
 *  app-launcher scheme) that could run code or launch an arbitrary app, while still
 *  allowing normal Windows drive paths. Throws with a human-readable reason on a
 *  bad target. Pure, so the whole allow/deny table is unit-tested without shelling
 *  out. Note the caller opens the target via a spawned args array (no shell), so a
 *  URL's `&` or a path's spaces cannot inject a command regardless. */
export function validateOpenTarget(raw: string): OpenTarget {
  const t = raw.trim();
  if (!t) throw new Error("No path or URL to open.");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(t)) throw new Error("The target contains control characters.");
  if (/^https?:\/\//i.test(t)) return { kind: "url", value: t };
  const colon = t.indexOf(":");
  if (colon >= 0) {
    // A Windows drive path ("C:\...") has its only colon at index 1 after a letter.
    const isDriveLetter = colon === 1 && /^[a-zA-Z]$/.test(t[0]!);
    if (!isDriveLetter) {
      throw new Error("Only http(s) links and file paths can be opened, not custom URL schemes.");
    }
  }
  return { kind: "path", value: t };
}

/** Format a raw `Get-Clipboard -Raw` payload for a voice reply (4.7): strip the
 *  trailing newline PowerShell appends and cap the length so a giant paste can't
 *  flood the JSON-RPC pipe or a spoken reply. Pure so the cap is unit-tested. */
export function formatClipboard(raw: string, max = 10000): string {
  const t = raw.replace(/\s+$/, "");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Raw OS snapshot, so summarizeStats stays pure (the server passes node's `os`
 *  readings in; the test passes fixed numbers). */
export interface StatsSnapshot {
  platform: string;
  cpuCount: number;
  totalMemBytes: number;
  freeMemBytes: number;
  uptimeSeconds: number;
  /** 1-minute load average; 0 on Windows (node reports [0,0,0]), so omitted there. */
  loadAvg1: number;
}

/** A compact, human-readable system summary for system_stats. Percentages are
 *  rounded ints; memory in GiB to one decimal. loadAvg is included only when
 *  meaningful (>0), since Windows always reports 0. */
export function summarizeStats(s: StatsSnapshot): Record<string, unknown> {
  const usedMem = s.totalMemBytes - s.freeMemBytes;
  const memPct = s.totalMemBytes > 0 ? Math.round((usedMem / s.totalMemBytes) * 100) : 0;
  const gib = (b: number): number => Math.round((b / 1024 ** 3) * 10) / 10;
  return {
    platform: s.platform,
    cpuCount: s.cpuCount,
    memoryUsedGiB: gib(usedMem),
    memoryTotalGiB: gib(s.totalMemBytes),
    memoryUsedPercent: memPct,
    uptimeHours: Math.round((s.uptimeSeconds / 3600) * 10) / 10,
    ...(s.loadAvg1 > 0 ? { loadAverage1min: Math.round(s.loadAvg1 * 100) / 100 } : {}),
  };
}
