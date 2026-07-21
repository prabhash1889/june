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
