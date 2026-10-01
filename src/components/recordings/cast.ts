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

export function parseCast(text: string, idleCap = 2): Cast {
  const lines = text.split("\n");
  let header: { width?: number; height?: number; title?: string } = {};
  try {
    header = JSON.parse(lines[0] ?? "{}");
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
    width: header.width && header.width > 0 ? header.width : 80,
    height: header.height && header.height > 0 ? header.height : 24,
    title: header.title ?? "",
    events,
    duration: events.length ? events[events.length - 1].at : 0,
  };
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
