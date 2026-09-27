// Parses a pasted `ssh` command line into forward rules (§13.4.P). Pure logic,
// no imports from the app, so it can be exercised from any test.
//
//   ssh -L 6443:127.0.0.1:6443 -R 9000:localhost:3000 -D 1080 -N -f -J bastion user@host
//   ssh -fN -L 127.0.0.1:8080:web:80 -o ProxyJump=a,b -p 2222 host
//
// Supported: -L / -R `[bind:]port:host:hostport` (IPv6 in brackets), -D `[bind:]port`,
// -N, -f (flags may be combined: -fN, -NL spec), -J, -p, -l, -i, and
// `-o LocalForward|RemoteForward|DynamicForward|ProxyJump|Port|User|IdentityFile`.
// Everything else is ignored; the first non-option word is the host.

export type ParsedKind = "L" | "R" | "D";

export interface ParsedForward {
  kind: ParsedKind;
  bindAddress: string; // "" = default
  bindPort: number;
  targetHost: string; // "" for D
  targetPort: number; // 0 for D
}

export interface ParsedSshCommand {
  /** The host word as typed (`user@host` or an alias), or null if absent. */
  host: string | null;
  user: string | null;
  hostname: string | null;
  port: number | null;
  identityFile: string | null;
  proxyJump: string | null;
  /** `-N` was given. */
  tunnelOnly: boolean;
  /** `-f` was given (informational: every OverSSH tunnel is a background one). */
  background: boolean;
  forwards: ParsedForward[];
  errors: string[];
}

/** Shell-ish tokenizer: whitespace separated, honours '…' and "…" and backslash escapes. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < input.length) cur += input[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < input.length && input[i + 1] !== "\n") {
      cur += input[++i];
      has = true;
    } else if (/\s/.test(c) || c === "\\") {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Splits on ':' but keeps `[...]` groups (IPv6 literals) intact; brackets are stripped. */
function splitColon(spec: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  for (const c of spec) {
    if (c === "[") depth++;
    else if (c === "]") depth = Math.max(0, depth - 1);
    else if (c === ":" && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.replace(/^\[|\]$/g, ""));
}

function toPort(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= 65535 ? n : null;
}

/** `[bind:]port:host:hostport` (for -L / -R). */
export function parseForwardSpec(kind: "L" | "R", spec: string): ParsedForward | string {
  const p = splitColon(spec.trim());
  let bind = "";
  let rest = p;
  if (p.length === 4) {
    bind = p[0] === "*" ? "0.0.0.0" : p[0];
    rest = p.slice(1);
  }
  if (rest.length !== 3) return `Cannot parse -${kind} "${spec}" (expected [bind:]port:host:hostport)`;
  const bindPort = toPort(rest[0]);
  const targetPort = toPort(rest[2]);
  if (bindPort === null || targetPort === null || targetPort === 0 || !rest[1]) {
    return `Invalid ports or host in -${kind} "${spec}"`;
  }
  return { kind, bindAddress: bind, bindPort, targetHost: rest[1], targetPort };
}

/** `[bind:]port` (for -D). */
export function parseDynamicSpec(spec: string): ParsedForward | string {
  const p = splitColon(spec.trim());
  if (p.length < 1 || p.length > 2) return `Cannot parse -D "${spec}" (expected [bind:]port)`;
  const port = toPort(p[p.length - 1]);
  if (port === null) return `Invalid port in -D "${spec}"`;
  const bind = p.length === 2 ? (p[0] === "*" ? "0.0.0.0" : p[0]) : "";
  return { kind: "D", bindAddress: bind, bindPort: port, targetHost: "", targetPort: 0 };
}

const ARG_OPTS = new Set("BbcDEeFIiJLlmOopQRSWw".split(""));

export function parseSshCommand(input: string): ParsedSshCommand {
  const res: ParsedSshCommand = {
    host: null,
    user: null,
    hostname: null,
    port: null,
    identityFile: null,
    proxyJump: null,
    tunnelOnly: false,
    background: false,
    forwards: [],
    errors: [],
  };
  const tokens = tokenize(input.trim());
  let i = 0;
  if (tokens[0] === "ssh" || tokens[0] === "ssh.exe") i = 1;

  const addForward = (f: ParsedForward | string): void => {
    if (typeof f === "string") res.errors.push(f);
    else res.forwards.push(f);
  };

  const applyOption = (opt: string, val: string): void => {
    switch (opt) {
      case "L":
        addForward(parseForwardSpec("L", val));
        break;
      case "R":
        addForward(parseForwardSpec("R", val));
        break;
      case "D":
        addForward(parseDynamicSpec(val));
        break;
      case "J":
        res.proxyJump = val;
        break;
      case "p": {
        const n = toPort(val);
        if (n) res.port = n;
        else res.errors.push(`Invalid port "${val}"`);
        break;
      }
      case "l":
        res.user = val;
        break;
      case "i":
        res.identityFile = val;
        break;
      case "o": {
        const m = /^\s*([A-Za-z]+)\s*[=\s]\s*(.*)$/.exec(val);
        if (!m) break;
        const key = m[1].toLowerCase();
        const v = m[2].replace(/^"|"$/g, "");
        // `-o LocalForward="6443 127.0.0.1:6443"` uses a space after the first port.
        const fwd = v.replace(/^(\S+)\s+/, "$1:");
        if (key === "localforward") addForward(parseForwardSpec("L", fwd));
        else if (key === "remoteforward") addForward(parseForwardSpec("R", fwd));
        else if (key === "dynamicforward") addForward(parseDynamicSpec(v));
        else if (key === "proxyjump") res.proxyJump = v;
        else if (key === "port") applyOption("p", v);
        else if (key === "user") res.user = v;
        else if (key === "identityfile") res.identityFile = v;
        else if (key === "hostname") res.hostname = v;
        break;
      }
      default:
        break;
    }
  };

  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") {
      if (res.host === null && tokens[i + 1]) res.host = tokens[i + 1];
      break;
    }
    if (t.startsWith("-") && t.length > 1) {
      for (let k = 1; k < t.length; k++) {
        const ch = t[k];
        if (ARG_OPTS.has(ch)) {
          const attached = t.slice(k + 1);
          const val = attached || tokens[++i] || "";
          applyOption(ch, val);
          break;
        }
        if (ch === "N") res.tunnelOnly = true;
        else if (ch === "f") res.background = true;
      }
      continue;
    }
    if (res.host === null) {
      res.host = t;
      continue;
    }
    break; // the rest is the remote command
  }

  if (res.host) {
    const at = res.host.lastIndexOf("@");
    if (at > 0) {
      res.user = res.user ?? res.host.slice(0, at);
      res.hostname = res.host.slice(at + 1);
    } else {
      res.hostname = res.hostname ?? res.host;
    }
    // `ssh://user@host:port` style
    const uri = /^ssh:\/\/(?:([^@]+)@)?([^:/]+)(?::(\d+))?/.exec(res.host);
    if (uri) {
      res.user = res.user ?? uri[1] ?? null;
      res.hostname = uri[2];
      if (uri[3]) res.port = Number(uri[3]);
    }
  } else {
    res.errors.push("No host found in the command");
  }
  if (res.forwards.length === 0 && res.errors.length === 0) {
    res.errors.push("No -L, -R or -D forwards found");
  }
  return res;
}
