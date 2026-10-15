// asciinema v2 parser + timeline for the built-in player (§13.4.T2).

export interface CastEvent {
  /** Original seconds since start. */
  t: number;
  /** Seconds on the player timeline (idle gaps capped). */
  at: number;
  code: string;
  data: string;
}

export interface Cast {
  width: number;
  height: number;
  title: string;
  events: CastEvent[];
  /** Timeline length in seconds (after the idle cap). */
  duration: number;
}

export const MAX_COLS = 500;
export const MAX_ROWS = 300;

/** A terminal size from a file: an integer in 1..max, else `fallback`. A hostile header must not make xterm allocate gigabytes. */
export function clampDim(v: unknown, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.min(max, Math.floor(v)) : fallback;
}

export function parseCast(text: string, idleCap = 2): Cast {
  const lines = text.split("\n");
  let header: { width?: unknown; height?: unknown; title?: unknown };
  try {
    const h: unknown = JSON.parse(lines[0] ?? "{}");
    if (h === null || typeof h !== "object" || Array.isArray(h)) throw new Error("not an object");
    header = h;
  } catch {
    throw new Error("Not an asciinema recording (bad header)");
  }
  const events: CastEvent[] = [];
  let prevT = 0;
  let at = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue; // a truncated last line (crash) is skipped
    }
    if (!Array.isArray(v) || typeof v[0] !== "number" || typeof v[1] !== "string") continue;
    const t = v[0];
    at += Math.min(Math.max(t - prevT, 0), idleCap);
    prevT = t;
    events.push({ t, at, code: v[1], data: String(v[2] ?? "") });
  }
  return {
    width: clampDim(header.width, MAX_COLS, 80),
    height: clampDim(header.height, MAX_ROWS, 24),
    title: typeof header.title === "string" ? header.title : "",
    events,
    duration: events.length ? events[events.length - 1].at : 0,
  };
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
