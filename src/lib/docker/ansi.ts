// Minimal SGR (colour) renderer for container logs. Pure; unit tested in tests/unit/dockerAnsi.test.ts.

export interface AnsiSeg {
  t: string;
  /** Tailwind classes for the segment; "" = default. */
  cls: string;
}

const FG: Record<number, string> = {
  30: "text-muted-foreground",
  31: "text-red-500",
  32: "text-green-500",
  33: "text-yellow-500",
  34: "text-blue-400",
  35: "text-fuchsia-400",
  36: "text-cyan-400",
  37: "text-foreground",
  90: "text-muted-foreground",
  91: "text-red-400",
  92: "text-green-400",
  93: "text-yellow-400",
  94: "text-blue-300",
  95: "text-fuchsia-300",
  96: "text-cyan-300",
  97: "text-foreground",
};

/** Splits a line into coloured segments. Non-SGR escape sequences are dropped. */
export function ansiSegments(line: string): AnsiSeg[] {
  if (!line.includes("\x1b")) return [{ t: line, cls: "" }];
  const out: AnsiSeg[] = [];
  let fg = "";
  let bold = false;
  let dim = false;
  let underline = false;
  const re = /\x1b\[([0-9;?]*)([ -/]*[@-~])|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;
  let last = 0;
  const push = (t: string) => {
    if (!t) return;
    const cls = [fg, bold ? "font-bold" : "", dim ? "opacity-70" : "", underline ? "underline" : ""].filter(Boolean).join(" ");
    out.push({ t, cls });
  };
  for (let m = re.exec(line); m; m = re.exec(line)) {
    push(line.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] !== "m") continue;
    const codes = (m[1] || "0").split(";").map((x) => Number(x) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        fg = "";
        bold = dim = underline = false;
      } else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 4) underline = true;
      else if (c === 22) bold = dim = false;
      else if (c === 24) underline = false;
      else if (c === 39) fg = "";
      else if (FG[c] !== undefined) fg = FG[c];
      else if (c === 38 || c === 48) {
        // 38;5;n or 38;2;r;g;b -> skip the extra parameters (colour kept as default)
        i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
      }
    }
  }
  push(line.slice(last));
  return out.length ? out : [{ t: "", cls: "" }];
}
