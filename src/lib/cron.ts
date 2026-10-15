// Pure crontab logic (no Svelte, no I/O): parse/serialize a user crontab while
// preserving every non-job line verbatim, validate/describe a schedule and
// compute the next run times. See docs/GUIDE.md §13.4.C.

export type CronLine =
  | { kind: "job"; id: number; schedule: string; command: string; enabled: boolean; raw: string | null }
  | { kind: "env" | "comment" | "blank" | "unknown"; raw: string };

export type CronJob = Extract<CronLine, { kind: "job" }>;

// --- schedule parsing --------------------------------------------------------------

export const SPECIALS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOWS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  nameBase?: number;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: "day of week", min: 0, max: 7, names: DOWS, nameBase: 0 },
];

export interface ParsedField {
  raw: string;
  /** Sorted allowed values (dow 7 is folded to 0). */
  values: number[];
  /** True if the field is `*` or starts with `*` (Vixie: restricted otherwise). */
  star: boolean;
}

export interface ParsedSchedule {
  /** Normalized 5-field text, or the `@name`. */
  text: string;
  special: string | null;
  reboot: boolean;
  minute: ParsedField;
  hour: ParsedField;
  dom: ParsedField;
  month: ParsedField;
  dow: ParsedField;
}

function parseValue(tok: string, f: FieldSpec): number {
  if (/^\d+$/.test(tok)) return Number(tok);
  const idx = f.names ? f.names.indexOf(tok.toLowerCase()) : -1;
  if (idx >= 0) return idx + (f.nameBase ?? 0);
  throw new Error(`invalid ${f.name} value "${tok}"`);
}

function parseField(raw: string, f: FieldSpec): ParsedField {
  if (raw === "") throw new Error(`empty ${f.name}`);
  const set = new Set<number>();
  for (const item of raw.split(",")) {
    if (item === "") throw new Error(`empty item in ${f.name}`);
    const [range, stepStr, extra] = item.split("/");
    if (extra !== undefined) throw new Error(`invalid ${f.name} "${item}"`);
    let step = 1;
    if (stepStr !== undefined) {
      if (!/^\d+$/.test(stepStr) || Number(stepStr) < 1) throw new Error(`invalid step "${stepStr}" in ${f.name}`);
      step = Number(stepStr);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = f.min;
      hi = f.name === "day of week" ? 6 : f.max;
    } else if (range.includes("-")) {
      const [a, b, more] = range.split("-");
      if (more !== undefined || a === "" || b === "") throw new Error(`invalid range "${range}" in ${f.name}`);
      lo = parseValue(a, f);
      hi = parseValue(b, f);
    } else {
      lo = parseValue(range, f);
      hi = stepStr !== undefined ? (f.name === "day of week" ? 6 : f.max) : lo;
    }
    if (lo < f.min || lo > f.max || hi < f.min || hi > f.max) {
      throw new Error(`${f.name} out of range (${f.min}-${f.max}): "${item}"`);
    }
    if (lo > hi) throw new Error(`range start is after end in ${f.name}: "${item}"`);
    for (let v = lo; v <= hi; v += step) set.add(f.name === "day of week" && v === 7 ? 0 : v);
  }
  return { raw, values: [...set].sort((a, b) => a - b), star: raw.startsWith("*") };
}

export function parseSchedule(text: string): ParsedSchedule {
  const t = text.trim();
  if (!t) throw new Error("schedule is empty");
  if (t.startsWith("@")) {
    const key = t.toLowerCase();
    if (key === "@reboot") {
      const empty: ParsedField = { raw: "", values: [], star: false };
      return { text: "@reboot", special: "@reboot", reboot: true, minute: empty, hour: empty, dom: empty, month: empty, dow: empty };
    }
    const exp = SPECIALS[key];
    if (!exp) throw new Error(`unknown special "${t}" (use @reboot, @hourly, @daily, @weekly, @monthly, @yearly)`);
    const p = parseSchedule(exp);
    return { ...p, text: key, special: key };
  }
  const parts = t.split(/\s+/);
  if (parts.length !== 5) throw new Error(`expected 5 fields (minute hour day month weekday), got ${parts.length}`);
  const [m, h, d, mo, w] = parts.map((p, i) => parseField(p, FIELDS[i]));
  return { text: parts.join(" "), special: null, reboot: false, minute: m, hour: h, dom: d, month: mo, dow: w };
}

export type Validation = { ok: true; parsed: ParsedSchedule } | { ok: false; error: string };

export function validateSchedule(text: string): Validation {
  try {
    return { ok: true, parsed: parseSchedule(text) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// --- line parsing / serialization ----------------------------------------------------

let nextId = 1;

const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*\s*=/;

/** Splits "<schedule> <command>" (5 fields or @special). Returns null if it is not a job. */
export function splitJobLine(line: string): { schedule: string; command: string } | null {
  const t = line.trim();
  if (!t) return null;
  let schedule: string;
  let rest: string;
  if (t.startsWith("@")) {
    const m = /^(\S+)\s+([\s\S]+)$/.exec(t);
    if (!m) return null;
    schedule = m[1];
    rest = m[2];
  } else {
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(t);
    if (!m) return null;
    schedule = m.slice(1, 6).join(" ");
    rest = m[6];
  }
  if (!validateSchedule(schedule).ok) return null;
  const command = rest.trim();
  return command ? { schedule, command } : null;
}

export function parseCrontab(text: string): CronLine[] {
  const norm = text.replace(/\r\n/g, "\n");
  const rows = norm.split("\n");
  if (rows.length && rows[rows.length - 1] === "") rows.pop();
  return rows.map((raw): CronLine => {
    const t = raw.trim();
    if (t === "") return { kind: "blank", raw };
    if (t.startsWith("#")) {
      // A commented-out job: "#<schedule> <cmd>" or "# <schedule> <cmd>"
      const body = t.replace(/^#\s?/, "");
      const job = body.startsWith("#") ? null : splitJobLine(body);
      if (job) return { kind: "job", id: nextId++, ...job, enabled: false, raw };
      return { kind: "comment", raw };
    }
    if (ENV_RE.test(t)) return { kind: "env", raw };
    const job = splitJobLine(raw);
    if (job) return { kind: "job", id: nextId++, ...job, enabled: true, raw };
    return { kind: "unknown", raw };
  });
}

export function jobLine(j: Pick<CronJob, "schedule" | "command" | "enabled">): string {
  const body = `${j.schedule.trim()} ${j.command.trim()}`;
  return j.enabled ? body : `#${body}`;
}

/** Jobs keep their original text until edited (`raw = null` regenerates it). */
export function serializeCrontab(lines: CronLine[]): string {
  if (lines.length === 0) return "";
  return lines.map((l) => (l.kind === "job" ? (l.raw ?? jobLine(l)) : l.raw)).join("\n") + "\n";
}

export function newJob(schedule: string, command: string, enabled = true): CronJob {
  return { kind: "job", id: nextId++, schedule, command, enabled, raw: null };
}

/** Plain comment right above the job at `index` (shown as the job's note). */
export function commentAbove(lines: CronLine[], index: number): string {
  const prev = lines[index - 1];
  return prev && prev.kind === "comment" ? prev.raw.replace(/^\s*#+\s?/, "") : "";
}

/** Sets/clears the note comment above the job at `index`; returns the new job index. */
export function setCommentAbove(lines: CronLine[], index: number, text: string): number {
  const prev = lines[index - 1];
  const has = prev && prev.kind === "comment";
  const t = text.trim();
  if (has && t) {
    lines[index - 1] = { kind: "comment", raw: `# ${t}` };
    return index;
  }
  if (has && !t) {
    lines.splice(index - 1, 1);
    return index - 1;
  }
  if (t) {
    lines.splice(index, 0, { kind: "comment", raw: `# ${t}` });
    return index + 1;
  }
  return index;
}

/** Cron treats an unescaped `%` as newline; "Run now" wants the shell form. */
export function commandForShell(command: string): string {
  return command.replace(/\\%/g, "%");
}

// --- description -----------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, "0");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

function listText(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

/**
 * Step of a "star slash n" field when the values form a sequence starting at `min`.
 * With `span` (the size of the range: 60 minutes, 24 hours, 12 months) the step must divide it:
 * "star slash 45" in the minute field runs at :00 and :45 of every hour, not every 45 minutes.
 */
function stepOf(f: ParsedField, min: number, span?: number): number | null {
  const m = /^(\*|\d+-\d+|\d+)\/(\d+)$/.exec(f.raw);
  if (!m || m[1] !== "*") return null;
  const step = Number(m[2]);
  if (span !== undefined && span % step !== 0) return null;
  return f.values[0] === min ? step : null;
}

function describeRuns(values: number[], min: number, max: number): string[] {
  // collapses consecutive runs: [1,2,3,5] -> ["1-3", "5"]
  const out: string[] = [];
  let i = 0;
  while (i < values.length) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
    out.push(j - i >= 2 ? `${values[i]}-${values[j]}` : values.slice(i, j + 1).join(", "));
    i = j + 1;
  }
  void min;
  void max;
  return out;
}

function dowText(f: ParsedField): string {
  const v = f.values;
  if (v.length === 7) return "every day";
  const wk = [1, 2, 3, 4, 5];
  if (v.length === 5 && wk.every((d, i) => v[i] === d)) return "on weekdays (Mon-Fri)";
  if (v.length === 2 && v[0] === 0 && v[1] === 6) return "on weekends";
  // runs like Mon-Wed
  const parts: string[] = [];
  let i = 0;
  while (i < v.length) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    parts.push(j - i >= 2 ? `${DOW_NAMES[v[i]]}-${DOW_NAMES[v[j]]}` : v.slice(i, j + 1).map((d) => DOW_NAMES[d]).join(", "));
    i = j + 1;
  }
  return "on " + parts.join(", ");
}

function monthText(f: ParsedField): string {
  const v = f.values;
  if (v.length === 12) return "";
  const step = stepOf({ ...f, values: v.map((x) => x - 1) }, 0, 12);
  if (step && /\*\/\d+/.test(f.raw)) return `every ${step === 1 ? "" : ordinal(step) + " "}month`.replace("  ", " ");
  return "in " + v.map((m) => MONTH_NAMES[m - 1]).join(", ");
}

function domText(f: ParsedField): string {
  const v = f.values;
  if (v.length === 31) return "";
  const step = stepOf(f, 1);
  if (step) return `every ${ordinal(step)} day of the month`;
  return `on day ${listText(describeRuns(v, 1, 31).map((x) => x))} of the month`;
}

function timeText(p: ParsedSchedule): string {
  const m = p.minute;
  const h = p.hour;
  const mStar = m.values.length === 60;
  const hStar = h.values.length === 24;
  const mStep = stepOf(m, 0, 60);
  const hStep = stepOf(h, 0, 24);

  if (mStar && hStar) return "every minute";
  if (mStep && hStar) return `every ${plural(mStep, "minute")}`;
  if (!mStar && m.values.length === 1 && hStar) {
    return m.values[0] === 0 ? "every hour" : `every hour at minute ${m.values[0]}`;
  }
  if (!mStar && !mStep && hStar) return `every hour at minutes ${m.values.join(", ")}`;
  if (!mStar && !hStar && !hStep && m.values.length * h.values.length <= 4) {
    const times: string[] = [];
    for (const hh of h.values) for (const mm of m.values) times.push(`${pad2(hh)}:${pad2(mm)}`);
    return `at ${listText(times)}`;
  }
  if (!mStar && !hStar && !hStep) {
    const hs = h.values.length <= 6 ? `hours ${h.values.join(", ")}` : `${plural(h.values.length, "hour")} a day`;
    return `at minute ${m.values.join(", ")} of ${hs}`;
  }
  if (!mStar && hStep) {
    const at = m.values.length === 1 ? `at minute ${m.values[0]}` : `at minutes ${m.values.join(", ")}`;
    return `${at} of every ${plural(hStep, "hour")}`;
  }
  if (mStar && !hStar) {
    return h.values.length === 1
      ? `every minute during ${pad2(h.values[0])}:00-${pad2(h.values[0])}:59`
      : `every minute during hours ${h.values.join(", ")}`;
  }
  if (mStep && !hStar) {
    return `every ${plural(mStep, "minute")} during hour${h.values.length === 1 ? "" : "s"} ${h.values.join(", ")}`;
  }
  return `at minute ${m.values.join(", ")} of hour ${h.values.join(", ")}`;
}

export function describeParsed(p: ParsedSchedule): string {
  if (p.reboot) return "at system startup";
  const time = timeText(p);
  const parts: string[] = [time];
  const domR = p.dom.values.length < 31;
  const dowR = p.dow.values.length < 7;
  const mo = monthText(p.month);
  if (domR && dowR) {
    // cron semantics: runs when EITHER day-of-month OR day-of-week matches
    parts.push(`${domText(p.dom)} or ${dowText(p.dow)}`);
  } else if (domR) parts.push(domText(p.dom));
  else if (dowR) parts.push(dowText(p.dow));
  else if (!mo && !time.startsWith("every minute") && !/^every \d+ minutes?$/.test(time) && !time.startsWith("every hour")) {
    parts.push("every day");
  }
  if (mo) parts.push(mo);
  let s = parts.join(" ");
  // "every day at 02:30" reads better than "at 02:30 every day"
  s = s.replace(/^(at [^]*?) every day$/, "every day $1");
  return s;
}

/** Human description, or the validation error prefixed with "Invalid: ". */
export function describeSchedule(text: string): string {
  const v = validateSchedule(text);
  return v.ok ? describeParsed(v.parsed) : `Invalid: ${v.error}`;
}

// --- next runs ---------------------------------------------------------------------------

/** Next `count` run times strictly after `from`, in the local time zone. [] for @reboot or if none within 8 years. */
export function nextRuns(schedule: string | ParsedSchedule, from: Date, count = 3): Date[] {
  const p = typeof schedule === "string" ? validateSchedule(schedule) : { ok: true as const, parsed: schedule };
  if (!p.ok || p.parsed.reboot) return [];
  const s = p.parsed;
  const out: Date[] = [];
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const monthSet = new Set(s.month.values);
  const domSet = new Set(s.dom.values);
  const dowSet = new Set(s.dow.values);
  for (let i = 0; i < 366 * 8 && out.length < count; i++, day.setDate(day.getDate() + 1)) {
    if (!monthSet.has(day.getMonth() + 1)) continue;
    const domOk = domSet.has(day.getDate());
    const dowOk = dowSet.has(day.getDay());
    const dayOk = !s.dom.star && !s.dow.star ? domOk || dowOk : domOk && dowOk;
    if (!dayOk) continue;
    for (const h of s.hour.values) {
      for (const m of s.minute.values) {
        const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
        // skip nonexistent local times (DST gap): hour must round-trip
        if (t.getHours() !== h || t <= from) continue;
        out.push(t);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

export function formatRun(d: Date, now: Date = new Date()): string {
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toDateString() === d.toDateString();
  if (sameDay) return `today ${time}`;
  if (tomorrow) return `tomorrow ${time}`;
  const date = `${DOW_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? `${date} ${time}` : `${date} ${d.getFullYear()} ${time}`;
}

// --- presets -------------------------------------------------------------------------------

export const PRESETS: { label: string; schedule: string }[] = [
  { label: "Every minute", schedule: "* * * * *" },
  { label: "Every 5 min", schedule: "*/5 * * * *" },
  { label: "Every 15 min", schedule: "*/15 * * * *" },
  { label: "Hourly", schedule: "0 * * * *" },
  { label: "Daily 02:30", schedule: "30 2 * * *" },
  { label: "Weekdays 09:00", schedule: "0 9 * * 1-5" },
  { label: "Weekly (Sun 00:00)", schedule: "0 0 * * 0" },
  { label: "Monthly (1st)", schedule: "0 0 1 * *" },
  { label: "At reboot", schedule: "@reboot" },
];

// --- line diff (for the save confirmation) ---------------------------------------------------

export interface DiffLine {
  op: " " | "+" | "-";
  text: string;
}

/** Minimal LCS line diff; fine for crontab-sized inputs. */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a === "" ? [] : a.replace(/\n$/, "").split("\n");
  const y = b === "" ? [] : b.replace(/\n$/, "").split("\n");
  const n = x.length;
  const m = y.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: " ", text: x[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: "-", text: x[i++] });
    else out.push({ op: "+", text: y[j++] });
  }
  while (i < n) out.push({ op: "-", text: x[i++] });
  while (j < m) out.push({ op: "+", text: y[j++] });
  return out;
}
