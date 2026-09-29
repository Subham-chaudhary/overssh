// Pure helpers for the file Info (Properties) dialog (docs/GUIDE.md §14.4.X).

/** `-rwxr-xr-x` style string from raw mode bits (type char from the S_IFMT bits). */
export function modeString(mode: number): string {
  const fmt = mode & 0o170000;
  const type =
    fmt === 0o040000
      ? "d"
      : fmt === 0o120000
        ? "l"
        : fmt === 0o020000
          ? "c"
          : fmt === 0o060000
            ? "b"
            : fmt === 0o010000
              ? "p"
              : fmt === 0o140000
                ? "s"
                : "-";
  const bit = (mask: number, ch: string): string => (mode & mask ? ch : "-");
  const exec = (x: number, special: number, on: string, off: string): string => {
    const hasX = (mode & x) !== 0;
    if (mode & special) return hasX ? on : off;
    return hasX ? "x" : "-";
  };
  return (
    type +
    bit(0o400, "r") +
    bit(0o200, "w") +
    exec(0o100, 0o4000, "s", "S") +
    bit(0o040, "r") +
    bit(0o020, "w") +
    exec(0o010, 0o2000, "s", "S") +
    bit(0o004, "r") +
    bit(0o002, "w") +
    exec(0o001, 0o1000, "t", "T")
  );
}

/** Octal permission string, e.g. `0644` (`4755` when a special bit is set). */
export function modeOctal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/** `1.5 MB`-style size (binary units, matching the rest of the app). */
export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** `1.5 MB (1,572,864 bytes)`. */
export function sizeWithBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${humanSize(n)} (${n.toLocaleString("en-US")} bytes)`;
}

/** Local-time `2026-01-31 14:05:09` from unix seconds, or an em dash. */
export function formatTime(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || secs <= 0) return "—";
  const d = new Date(secs * 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** `root (0)`, `root`, `0` or an em dash, depending on what is known. */
export function ownerLabel(name: string | null, id: number | null): string {
  if (name && id !== null) return `${name} (${id})`;
  if (name) return name;
  if (id !== null) return String(id);
  return "—";
}
