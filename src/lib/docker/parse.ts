// Pure parsers and helpers for Docker / Podman CLI output (docs/GUIDE.md §15.3.D).
// No Svelte, no I/O: everything here is unit tested (tests/unit/docker*.test.ts).
// Inputs come from `--format '{{json .}}'` (one object per line) or `--format json`
// (a JSON array: newer compose, podman). Unknown fields and malformed lines are skipped.

export type Json = Record<string, unknown>;

// --- generic helpers --------------------------------------------------------------

/** Parses JSON lines, a JSON array, or a mix. Malformed lines are skipped. */
export function parseJsonLines(text: string): Json[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v)) return v.filter(isObj);
    } catch {
      /* fall through to line mode */
    }
  }
  const out: Json[] = [];
  for (const raw of t.split(/\r?\n/)) {
    const line = stripAnsi(raw).trim();
    if (!line) continue;
    if (line.startsWith("{")) {
      try {
        const v = JSON.parse(line);
        if (isObj(v)) out.push(v);
      } catch {
        /* malformed line */
      }
    } else if (line.startsWith("[")) {
      try {
        const v = JSON.parse(line);
        if (Array.isArray(v)) out.push(...v.filter(isObj));
      } catch {
        /* malformed */
      }
    }
  }
  return out;
}

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;
export function stripAnsi(s: string): string {
  return s.includes("\x1b") ? s.replace(ANSI_RE, "") : s;
}

function str(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(str).join(" ");
  return "";
}

function pick(o: Json, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

function pickStr(o: Json, ...keys: string[]): string {
  return str(pick(o, ...keys));
}

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v.replace(/[,%]/g, "").trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  pb: 1000 ** 5,
  k: 1000,
  m: 1000 ** 2,
  g: 1000 ** 3,
  t: 1000 ** 4,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  pib: 1024 ** 5,
};

/** "1.5GB", "300MiB", "12.3 kB", "0B", "--", 1024 -> bytes. Unknown -> 0. */
export function parseSize(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : 0;
  const s = str(v).trim();
  if (!s || s === "--" || s === "N/A") return 0;
  const m = /^([0-9]*\.?[0-9]+)\s*([a-zA-Z]*)$/.exec(s);
  if (!m) return 0;
  const unit = UNITS[m[2].toLowerCase()] ?? (m[2] === "" ? 1 : 0);
  return Math.round(parseFloat(m[1]) * unit);
}

/** Human size with 1024 steps ("1.5 GiB"). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

/** Parses "k=v,k2=v2" label strings (docker ps) or label objects (inspect/podman). */
export function parseLabels(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) out[k] = str(val);
    return out;
  }
  const s = str(v);
  if (!s) return out;
  // Values may contain commas (rare); split on commas that start a new `key=`.
  for (const part of s.split(/,(?=[A-Za-z0-9_.\-/]+=)/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
    else if (part.trim()) out[part.trim()] = "";
  }
  return out;
}

/** Unix seconds from a number, numeric string, or "2024-05-01 10:00:00 +0000 UTC". 0 = unknown. */
export function parseTime(v: unknown): number {
  if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  const s = str(v).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return parseTime(Number(s));
  // "2024-05-01 10:00:00 +0000 UTC" -> ISO-ish
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/.exec(s);
  if (!m) return 0;
  let tz = m[3] ?? "Z";
  if (/^[+-]\d{4}$/.test(tz)) tz = `${tz.slice(0, 3)}:${tz.slice(3)}`;
  const t = Date.parse(`${m[1]}T${m[2]}${tz}`);
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

// --- ports ------------------------------------------------------------------------------

export interface PortMapping {
  hostIp: string;
  /** null = not published (EXPOSE only). */
  hostPort: number | null;
  containerPort: number;
  proto: string;
}

/**
 * "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 443/tcp, 127.0.0.1:9000-9002->9000-9002/tcp".
 * Ranges expand (max 32 ports each). IPv6 duplicates of an IPv4 mapping are kept.
 */
export function parsePortsString(s: string): PortMapping[] {
  const out: PortMapping[] = [];
  for (const part of s.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(?:(.*):)?(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?(?:\/(\w+))?$/.exec(part);
    if (m) {
      const hostIp = (m[1] ?? "").replace(/^\[|\]$/g, "");
      const hs = Number(m[2]);
      const he = m[3] ? Number(m[3]) : hs;
      const cs = Number(m[4]);
      const proto = m[6] ?? "tcp";
      for (let i = 0; i <= Math.min(he - hs, 31); i++) {
        out.push({ hostIp, hostPort: hs + i, containerPort: cs + i, proto });
      }
      continue;
    }
    const e = /^(\d+)(?:-(\d+))?(?:\/(\w+))?$/.exec(part);
    if (e) {
      const cs = Number(e[1]);
      const ce = e[2] ? Number(e[2]) : cs;
      for (let i = 0; i <= Math.min(ce - cs, 31); i++) {
        out.push({ hostIp: "", hostPort: null, containerPort: cs + i, proto: e[3] ?? "tcp" });
      }
    }
  }
  return out;
}

/** Podman: [{host_ip, container_port, host_port, range, protocol}] */
function parsePortsArray(arr: unknown[]): PortMapping[] {
  const out: PortMapping[] = [];
  for (const p of arr) {
    if (!isObj(p)) continue;
    const cp = num(pick(p, "container_port", "containerPort", "PrivatePort"));
    const hp = num(pick(p, "host_port", "hostPort", "PublicPort"));
    const range = Math.max(1, num(p.range) || 1);
    const proto = str(pick(p, "protocol", "Type")) || "tcp";
    for (let i = 0; i < Math.min(range, 32); i++) {
      if (cp) out.push({ hostIp: str(pick(p, "host_ip", "hostIp", "IP")), hostPort: hp ? hp + i : null, containerPort: cp + i, proto });
    }
  }
  return out;
}

/** Inspect form: {"80/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"}], "443/tcp": null} */
export function parsePortMap(v: unknown): PortMapping[] {
  if (!isObj(v)) return [];
  const out: PortMapping[] = [];
  for (const [k, binds] of Object.entries(v)) {
    const m = /^(\d+)(?:\/(\w+))?$/.exec(k);
    if (!m) continue;
    const cp = Number(m[1]);
    const proto = m[2] ?? "tcp";
    if (Array.isArray(binds) && binds.length > 0) {
      for (const b of binds) {
        if (!isObj(b)) continue;
        const hp = num(b.HostPort);
        out.push({ hostIp: str(b.HostIp), hostPort: hp || null, containerPort: cp, proto });
      }
    } else out.push({ hostIp: "", hostPort: null, containerPort: cp, proto });
  }
  return out;
}

/** Short "8080->80" style label. */
export function portLabel(p: PortMapping): string {
  return p.hostPort ? `${p.hostPort}->${p.containerPort}/${p.proto}` : `${p.containerPort}/${p.proto}`;
}

/** Drops IPv6 twins ("::" / ":::") of the same host/container/proto mapping. */
export function dedupePorts(ports: PortMapping[]): PortMapping[] {
  const seen = new Set<string>();
  const out: PortMapping[] = [];
  for (const p of ports) {
    const key = `${p.hostPort}|${p.containerPort}|${p.proto}`;
    if (p.hostPort !== null && seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// --- containers -------------------------------------------------------------------------

export type ContainerState = "running" | "paused" | "restarting" | "exited" | "created" | "removing" | "dead" | "other";
export type Health = "healthy" | "unhealthy" | "starting" | null;

export interface Container {
  id: string;
  name: string;
  image: string;
  command: string;
  state: ContainerState;
  status: string;
  health: Health;
  ports: PortMapping[];
  createdAt: number;
  runningFor: string;
  labels: Record<string, string>;
  /** Compose project / service from labels (docker compose or podman-compose). */
  project: string | null;
  service: string | null;
  networks: string[];
  mounts: string[];
  size: string;
}

const STATES: ContainerState[] = ["running", "paused", "restarting", "exited", "created", "removing", "dead"];

export function normalizeState(raw: string, status = ""): ContainerState {
  const s = raw.toLowerCase().trim();
  if ((STATES as string[]).includes(s)) return s as ContainerState;
  if (s === "stopped") return "exited";
  if (s === "configured" || s === "initialized") return "created";
  if (s === "up") return "running";
  // Older docker `ps` without State: derive from Status ("Up 3 hours", "Exited (0) ...", "Created").
  const st = status.toLowerCase();
  if (st.startsWith("up")) return st.includes("(paused)") ? "paused" : "running";
  if (st.startsWith("exited")) return "exited";
  if (st.startsWith("created")) return "created";
  if (st.startsWith("restarting")) return "restarting";
  if (st.startsWith("paused")) return "paused";
  if (st.startsWith("dead")) return "dead";
  return "other";
}

export function parseHealth(status: string): Health {
  const s = status.toLowerCase();
  if (s.includes("(unhealthy)")) return "unhealthy";
  if (s.includes("(healthy)")) return "healthy";
  if (s.includes("health: starting") || s.includes("(starting)")) return "starting";
  return null;
}

export function composeInfo(labels: Record<string, string>): { project: string | null; service: string | null } {
  const project = labels["com.docker.compose.project"] ?? labels["io.podman.compose.project"] ?? null;
  const service = labels["com.docker.compose.service"] ?? labels["io.podman.compose.service"] ?? null;
  return { project: project || null, service: service || null };
}

export function parseContainers(text: string): Container[] {
  const out: Container[] = [];
  for (const o of parseJsonLines(text)) {
    const id = pickStr(o, "ID", "Id", "id");
    if (!id) continue;
    const names = pick(o, "Names", "Name", "names");
    const name = (Array.isArray(names) ? str(names[0]) : str(names).split(",")[0]).replace(/^\//, "");
    const status = pickStr(o, "Status", "status");
    const portsRaw = pick(o, "Ports", "ports");
    const labels = parseLabels(pick(o, "Labels", "labels"));
    const { project, service } = composeInfo(labels);
    const nets = pick(o, "Networks", "networks");
    const mounts = pick(o, "Mounts", "mounts");
    const listify = (v: unknown): string[] =>
      Array.isArray(v) ? v.map(str).filter(Boolean) : str(v).split(",").map((x) => x.trim()).filter(Boolean);
    out.push({
      id,
      name: name || id.slice(0, 12),
      image: pickStr(o, "Image", "image"),
      command: pickStr(o, "Command", "command").replace(/^"|"$/g, ""),
      state: normalizeState(pickStr(o, "State", "state"), status),
      status,
      health: parseHealth(status),
      ports: dedupePorts(Array.isArray(portsRaw) ? parsePortsArray(portsRaw) : parsePortsString(str(portsRaw))),
      createdAt: parseTime(pick(o, "CreatedAt", "Created", "created")),
      runningFor: pickStr(o, "RunningFor", "CreatedHuman"),
      labels,
      project,
      service,
      networks: listify(nets),
      mounts: listify(mounts),
      size: pickStr(o, "Size"),
    });
  }
  return out;
}

export function isRunning(c: Container): boolean {
  return c.state === "running" || c.state === "restarting" || c.state === "paused";
}

// --- images ------------------------------------------------------------------------------

export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  /** "repo:tag" or the short id when untagged. */
  ref: string;
  dangling: boolean;
  size: number;
  sizeText: string;
  createdAt: number;
  createdSince: string;
  containers: number;
  digest: string;
}

function splitRef(ref: string): { repo: string; tag: string } {
  // Last ":" after the last "/" is the tag separator ("host:5000/img" has none).
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon > slash) return { repo: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { repo: ref, tag: "latest" };
}

export function parseImages(text: string): DockerImage[] {
  const out: DockerImage[] = [];
  for (const o of parseJsonLines(text)) {
    const id = pickStr(o, "ID", "Id", "id").replace(/^sha256:/, "");
    if (!id) continue;
    let repo = pickStr(o, "Repository");
    let tag = pickStr(o, "Tag");
    if (!repo) {
      // podman: Names / RepoTags arrays
      const names = pick(o, "Names", "RepoTags", "names");
      const first = Array.isArray(names) ? str(names[0]) : str(names);
      if (first && first !== "<none>:<none>") ({ repo, tag } = splitRef(first));
    }
    const dangling = !repo || repo === "<none>";
    const sizeRaw = pick(o, "Size", "VirtualSize", "size");
    out.push({
      id: id.slice(0, 12),
      repository: dangling ? "<none>" : repo,
      tag: dangling ? "<none>" : tag || "latest",
      ref: dangling ? id.slice(0, 12) : `${repo}:${tag || "latest"}`,
      dangling,
      size: parseSize(sizeRaw),
      sizeText: typeof sizeRaw === "string" ? sizeRaw : formatBytes(parseSize(sizeRaw)),
      createdAt: parseTime(pick(o, "CreatedAt", "Created")),
      createdSince: pickStr(o, "CreatedSince"),
      containers: Math.max(0, num(pick(o, "Containers"))),
      digest: pickStr(o, "Digest"),
    });
  }
  return out;
}

// --- volumes / networks ------------------------------------------------------------------

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
  labels: Record<string, string>;
  size: string;
  /** Compose project from labels, if any. */
  project: string | null;
}

export function parseVolumes(text: string): DockerVolume[] {
  const out: DockerVolume[] = [];
  for (const o of parseJsonLines(text)) {
    const name = pickStr(o, "Name", "name");
    if (!name) continue;
    const labels = parseLabels(pick(o, "Labels", "labels"));
    out.push({
      name,
      driver: pickStr(o, "Driver") || "local",
      mountpoint: pickStr(o, "Mountpoint"),
      scope: pickStr(o, "Scope") || "local",
      labels,
      size: pickStr(o, "Size"),
      project: composeInfo(labels).project,
    });
  }
  return out;
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  ipv6: boolean;
  createdAt: number;
  labels: Record<string, string>;
  project: string | null;
}

/** Built-in networks cannot be removed. */
export function isBuiltinNetwork(n: Pick<DockerNetwork, "name">): boolean {
  return n.name === "bridge" || n.name === "host" || n.name === "none" || n.name === "podman";
}

export function parseNetworks(text: string): DockerNetwork[] {
  const out: DockerNetwork[] = [];
  for (const o of parseJsonLines(text)) {
    const name = pickStr(o, "Name", "name");
    if (!name) continue;
    const labels = parseLabels(pick(o, "Labels", "labels"));
    const flag = (v: unknown) => v === true || str(v).toLowerCase() === "true";
    out.push({
      id: pickStr(o, "ID", "Id", "id").slice(0, 12),
      name,
      driver: pickStr(o, "Driver"),
      scope: pickStr(o, "Scope") || "local",
      internal: flag(pick(o, "Internal", "internal")),
      ipv6: flag(pick(o, "IPv6", "ipv6_enabled")),
      createdAt: parseTime(pick(o, "CreatedAt", "Created")),
      labels,
      project: composeInfo(labels).project,
    });
  }
  return out;
}

// --- compose -------------------------------------------------------------------------------

export interface ComposeProject {
  name: string;
  /** Raw status as in `compose ls` ("running(2), exited(1)") or derived. */
  status: string;
  configFiles: string[];
  workingDir: string | null;
  running: number;
  total: number;
}

export function parseComposeLs(text: string): ComposeProject[] {
  const out: ComposeProject[] = [];
  for (const o of parseJsonLines(text)) {
    const name = pickStr(o, "Name", "name");
    if (!name) continue;
    const status = pickStr(o, "Status", "status");
    const files = pickStr(o, "ConfigFiles", "configFiles").split(",").map((f) => f.trim()).filter(Boolean);
    const running = [...status.matchAll(/running\((\d+)\)/gi)].reduce((a, m) => a + Number(m[1]), 0);
    const total = [...status.matchAll(/\w+\((\d+)\)/g)].reduce((a, m) => a + Number(m[1]), 0);
    out.push({ name, status, configFiles: files, workingDir: null, running, total });
  }
  return out;
}

/**
 * Merges `compose ls` with projects found in container labels (works without the
 * compose plugin, and for podman-compose). Label data fills config files and counts.
 */
export function buildProjects(ls: ComposeProject[], containers: Container[]): ComposeProject[] {
  const byName = new Map<string, ComposeProject>();
  for (const p of ls) byName.set(p.name, { ...p });
  const groups = new Map<string, Container[]>();
  for (const c of containers) if (c.project) (groups.get(c.project) ?? groups.set(c.project, []).get(c.project)!).push(c);
  for (const [name, cs] of groups) {
    const running = cs.filter((c) => c.state === "running").length;
    const files = (cs[0].labels["com.docker.compose.project.config_files"] ?? "").split(",").map((f) => f.trim()).filter(Boolean);
    const wd = cs[0].labels["com.docker.compose.project.working_dir"] ?? null;
    const existing = byName.get(name);
    if (existing) {
      if (!existing.configFiles.length) existing.configFiles = files;
      existing.workingDir = wd;
      existing.running = running;
      existing.total = cs.length;
    } else {
      byName.set(name, {
        name,
        status: running > 0 ? `running(${running})` : `exited(${cs.length})`,
        configFiles: files,
        workingDir: wd,
        running,
        total: cs.length,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function projectServices(project: string, containers: Container[]): { service: string; containers: Container[] }[] {
  const m = new Map<string, Container[]>();
  for (const c of containers) {
    if (c.project !== project) continue;
    const key = c.service ?? c.name;
    (m.get(key) ?? m.set(key, []).get(key)!).push(c);
  }
  return [...m.entries()].map(([service, cs]) => ({ service, containers: cs })).sort((a, b) => a.service.localeCompare(b.service));
}

// --- system df -----------------------------------------------------------------------------

export interface DfRow {
  type: string;
  total: number;
  active: number;
  size: number;
  sizeText: string;
  reclaimable: number;
  reclaimableText: string;
  percent: number;
}

export function parseDf(text: string): DfRow[] {
  const rows: DfRow[] = [];
  for (const o of parseJsonLines(text)) {
    const type = pickStr(o, "Type", "type");
    if (!type) continue;
    const rec = pickStr(o, "Reclaimable", "reclaimable");
    const pm = /\((\d+)%\)/.exec(rec);
    const sizeText = pickStr(o, "Size", "size");
    rows.push({
      type,
      total: num(pick(o, "TotalCount", "Total")),
      active: num(pick(o, "Active")),
      size: parseSize(sizeText),
      sizeText,
      reclaimable: parseSize(rec.replace(/\(.*\)/, "").trim()),
      reclaimableText: rec.replace(/\s*\(\d+%\)/, "").trim() || "0B",
      percent: pm ? Number(pm[1]) : 0,
    });
  }
  return rows;
}

// --- stats ------------------------------------------------------------------------------------

export interface StatSample {
  id: string;
  name: string;
  cpu: number; // percent (may exceed 100 on multi-core)
  memPerc: number;
  memUsed: number;
  memLimit: number;
  netRx: number;
  netTx: number;
  blockRead: number;
  blockWrite: number;
  pids: number;
  t: number;
}

function pair(v: unknown): [number, number] {
  const parts = str(v).split("/");
  return [parseSize(parts[0]), parseSize(parts[1])];
}

export function parseStatLine(line: string, t = Date.now()): StatSample | null {
  const objs = parseJsonLines(line);
  const o = objs[0];
  if (!o) return null;
  const name = pickStr(o, "Name", "name", "Container");
  const id = pickStr(o, "ID", "Id", "id", "ContainerID");
  if (!name && !id) return null;
  const [memUsed, memLimit] = pair(pick(o, "MemUsage", "mem_usage"));
  const [netRx, netTx] = pair(pick(o, "NetIO", "net_io"));
  const [blockRead, blockWrite] = pair(pick(o, "BlockIO", "block_io"));
  return {
    id: id.slice(0, 12),
    name: name || id.slice(0, 12),
    cpu: num(pick(o, "CPUPerc", "CPU", "cpu_percent")),
    memPerc: num(pick(o, "MemPerc", "mem_percent")),
    memUsed,
    memLimit,
    netRx,
    netTx,
    blockRead,
    blockWrite,
    pids: num(pick(o, "PIDs", "pids")),
    t,
  };
}

// --- events ------------------------------------------------------------------------------------

export interface DockerEvent {
  type: string;
  action: string;
  id: string;
  name: string;
  time: number;
}

export function parseEventLine(line: string): DockerEvent | null {
  const o = parseJsonLines(line)[0];
  if (!o) return null;
  const type = pickStr(o, "Type", "type");
  const actor = isObj(o.Actor) ? o.Actor : {};
  const attrs = isObj(actor.Attributes) ? actor.Attributes : {};
  const action = (pickStr(o, "Action", "action", "status", "Status") || "").split(":")[0];
  if (!type && !action) return null;
  return {
    type: type.toLowerCase(),
    action,
    id: pickStr(actor, "ID") || pickStr(o, "id", "ID", "Name"),
    name: str(attrs.name) || pickStr(o, "Name"),
    time: num(pick(o, "time", "Time")),
  };
}

export type EventKind = "containers" | "images" | "volumes" | "networks";

/** Which list an event invalidates; null = ignore (exec_*, health_status noise is still used for containers). */
export function eventKind(e: DockerEvent): EventKind | null {
  switch (e.type) {
    case "container":
      // Healthchecks and `docker exec` send exec_create/start/die every few seconds per
      // container; none changes a list. (health_status is sent only when health changes.)
      if (e.action.startsWith("exec_")) return null;
      return "containers";
    case "image":
      return "images";
    case "volume":
      return "volumes";
    case "network":
      return "networks";
    default:
      return null;
  }
}

// --- inspect ------------------------------------------------------------------------------------

export interface EnvVar {
  key: string;
  value: string;
}

export interface MountInfo {
  type: string;
  name: string;
  source: string;
  destination: string;
  mode: string;
  rw: boolean;
}

export interface ContainerInspect {
  id: string;
  name: string;
  image: string;
  created: string;
  state: { status: string; running: boolean; paused: boolean; exitCode: number; startedAt: string; finishedAt: string; error: string; oomKilled: boolean; pid: number };
  restartPolicy: string;
  restartCount: number;
  cmd: string[];
  entrypoint: string[];
  workingDir: string;
  user: string;
  hostname: string;
  tty: boolean;
  privileged: boolean;
  env: EnvVar[];
  labels: Record<string, string>;
  mounts: MountInfo[];
  ports: PortMapping[];
  networks: { name: string; ip: string; gateway: string; mac: string }[];
  raw: unknown;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str) : typeof v === "string" && v ? [v] : [];
}

/** Takes the `docker inspect` text (array of one) or an already parsed object. */
export function parseInspect(text: string): ContainerInspect | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const o = Array.isArray(v) ? v[0] : v;
  if (!isObj(o)) return null;
  const cfg = isObj(o.Config) ? o.Config : {};
  const host = isObj(o.HostConfig) ? o.HostConfig : {};
  const st = isObj(o.State) ? o.State : {};
  const net = isObj(o.NetworkSettings) ? o.NetworkSettings : {};
  const rp = isObj(host.RestartPolicy) ? host.RestartPolicy : {};
  const env: EnvVar[] = strArr(cfg.Env).map((e) => {
    const i = e.indexOf("=");
    return i < 0 ? { key: e, value: "" } : { key: e.slice(0, i), value: e.slice(i + 1) };
  });
  const mounts: MountInfo[] = (Array.isArray(o.Mounts) ? o.Mounts : []).filter(isObj).map((m) => ({
    type: str(m.Type),
    name: str(m.Name),
    source: str(m.Source),
    destination: str(m.Destination),
    mode: str(m.Mode),
    rw: m.RW !== false,
  }));
  const networks = isObj(net.Networks)
    ? Object.entries(net.Networks).map(([name, n]) => {
        const nn = isObj(n) ? n : {};
        return { name, ip: str(nn.IPAddress), gateway: str(nn.Gateway), mac: str(nn.MacAddress) };
      })
    : [];
  return {
    id: str(o.Id).slice(0, 12),
    name: str(o.Name).replace(/^\//, ""),
    image: str(cfg.Image),
    created: str(o.Created),
    state: {
      status: str(st.Status),
      running: st.Running === true,
      paused: st.Paused === true,
      exitCode: num(st.ExitCode),
      startedAt: str(st.StartedAt),
      finishedAt: str(st.FinishedAt),
      error: str(st.Error),
      oomKilled: st.OOMKilled === true,
      pid: num(st.Pid),
    },
    restartPolicy: str(rp.Name) ? `${str(rp.Name)}${num(rp.MaximumRetryCount) ? `:${num(rp.MaximumRetryCount)}` : ""}` : "no",
    restartCount: num(o.RestartCount),
    cmd: strArr(cfg.Cmd),
    entrypoint: strArr(cfg.Entrypoint),
    workingDir: str(cfg.WorkingDir),
    user: str(cfg.User),
    hostname: str(cfg.Hostname),
    tty: cfg.Tty === true,
    privileged: host.Privileged === true,
    env,
    labels: parseLabels(cfg.Labels),
    mounts,
    ports: dedupePorts(parsePortMap(net.Ports)),
    networks,
    raw: o,
  };
}

/** Looks like a secret: mask its value by default. Every env value is masked by the UI; this marks the risky ones. */
export function isSecretKey(key: string): boolean {
  return /(pass(word|wd)?|secret|token|api[_-]?key|private|credential|auth|cert|key)$/i.test(key) || /(password|secret|token)/i.test(key);
}

// --- history / top / tables ----------------------------------------------------------------------

export interface HistoryLayer {
  id: string;
  createdBy: string;
  createdSince: string;
  size: number;
  sizeText: string;
  comment: string;
}

export function parseHistory(text: string): HistoryLayer[] {
  return parseJsonLines(text).map((o) => ({
    id: pickStr(o, "ID", "Id").replace(/^sha256:/, "").slice(0, 12),
    createdBy: pickStr(o, "CreatedBy").replace(/^\/bin\/sh -c #\(nop\)\s*/, "").replace(/^\/bin\/sh -c /, "RUN "),
    createdSince: pickStr(o, "CreatedSince"),
    size: parseSize(pick(o, "Size")),
    sizeText: typeof o.Size === "string" ? o.Size : formatBytes(num(o.Size)),
    comment: pickStr(o, "Comment"),
  }));
}

export interface Table {
  columns: string[];
  rows: string[][];
}

/** Whitespace table (`docker top`): the last column takes the rest of the line. */
export function parseTable(text: string): Table {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { columns: [], rows: [] };
  const columns = lines[0].trim().split(/\s+/);
  const rows = lines.slice(1).map((l) => {
    const parts = l.trim().split(/\s+/);
    if (parts.length <= columns.length) return parts;
    const head = parts.slice(0, columns.length - 1);
    // re-join the tail preserving original spacing as far as possible
    let rest = l.trim();
    for (const h of head) rest = rest.slice(rest.indexOf(h) + h.length).trimStart();
    return [...head, rest];
  });
  return { columns, rows };
}

// --- detection ------------------------------------------------------------------------------------

export type DetectFailure = "missing" | "daemon-down" | "denied" | "sudo-password" | "error";

export function classifyDockerError(code: number | null, stdout: string, stderr: string): DetectFailure {
  const e = `${stderr}\n${stdout}`.toLowerCase();
  if (e.includes("a password is required") || e.includes("sudo: a terminal is required") || e.includes("no tty present")) return "sudo-password";
  if (/permission denied/.test(e) && /(docker\.sock|docker api|podman|\/run\/|socket)/.test(e)) return "denied";
  if (/got permission denied while trying to connect/.test(e)) return "denied";
  if (
    /cannot connect to the docker daemon|is the docker daemon running|error during connect|unable to connect to podman|cannot connect to podman|connection refused|no such file or directory.*(docker|podman)\.sock|failed to connect to the docker api/.test(
      e,
    )
  )
    return "daemon-down";
  if (code === 127 || /command not found|not found|no such file or directory|executable file not found|cannot find/.test(e)) return "missing";
  return "error";
}

export interface DockerInfo {
  engine: "docker" | "podman";
  version: string;
  rootless: boolean;
  os: string;
  name: string;
  containers: number;
  running: number;
  images: number;
  composeVersion: string | null;
}

export function parseInfo(text: string, command = "docker"): DockerInfo | null {
  const o = parseJsonLines(text)[0] ?? (() => {
    try {
      const v = JSON.parse(text);
      return isObj(v) ? v : undefined;
    } catch {
      return undefined;
    }
  })();
  if (!o) return null;
  const host = isObj(o.host) ? o.host : {};
  const security = isObj(host.security) ? host.security : {};
  const ver = isObj(o.version) ? o.version : {};
  const podman = command.includes("podman") || (!o.ServerVersion && !!ver.Version);
  const secOpts = strArr(o.SecurityOptions);
  const clientInfo = isObj(o.ClientInfo) ? o.ClientInfo : {};
  const plugins = Array.isArray(clientInfo.Plugins) ? clientInfo.Plugins.filter(isObj) : [];
  const compose = plugins.find((p) => p.Name === "compose");
  return {
    engine: podman ? "podman" : "docker",
    version: str(o.ServerVersion) || str(ver.Version),
    rootless: secOpts.some((s) => s.includes("rootless")) || security.rootless === true,
    os: str(o.OperatingSystem) || str(isObj(host.distribution) ? host.distribution.distribution : ""),
    name: str(o.Name) || str(host.hostname),
    containers: num(o.Containers),
    running: num(o.ContainersRunning),
    images: num(o.Images),
    composeVersion: compose ? str(compose.Version).replace(/^v/, "") : null,
  };
}

/** Friendly one-liner for toasts: first non-empty stderr line(s), no "Error response from daemon:" prefix. */
export function friendlyDockerError(stderr: string, fallback = "docker command failed"): string {
  const lines = stripAnsi(stderr)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^usage:|^run '.*--help'/i.test(l));
  if (lines.length === 0) return fallback;
  return lines.slice(0, 3).join(" ").replace(/^error response from daemon:\s*/i, "").replace(/^error:\s*/i, "").slice(0, 400);
}

// --- argument builders (pure, tested) ----------------------------------------------------------------

export interface RunOptions {
  image: string;
  name?: string;
  ports?: string[]; // "8080:80"
  env?: string[]; // "KEY=value"
  volumes?: string[]; // "/host:/ctr[:ro]" or "named:/ctr"
  detach?: boolean;
  restart?: string; // "no" | "always" | "unless-stopped" | "on-failure"
  rm?: boolean;
  network?: string;
  command?: string; // free text, split by shell-ish words
}

/** Splits like a shell would for simple cases: quotes group words, no expansion. */
export function splitWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

export function buildRunArgs(o: RunOptions): string[] {
  const a = ["run"];
  if (o.detach !== false) a.push("-d");
  if (o.rm) a.push("--rm");
  if (o.name?.trim()) a.push("--name", o.name.trim());
  if (o.restart && o.restart !== "no") a.push("--restart", o.restart);
  if (o.network?.trim()) a.push("--network", o.network.trim());
  for (const p of o.ports ?? []) if (p.trim()) a.push("-p", p.trim());
  for (const e of o.env ?? []) if (e.trim()) a.push("-e", e.trim());
  for (const v of o.volumes ?? []) if (v.trim()) a.push("-v", v.trim());
  a.push(o.image.trim());
  if (o.command?.trim()) a.push(...splitWords(o.command));
  return a;
}

export function buildRmArgs(id: string, o: { force?: boolean; volumes?: boolean } = {}): string[] {
  const a = ["rm"];
  if (o.force) a.push("-f");
  if (o.volumes) a.push("-v");
  a.push(id);
  return a;
}

/** The command typed into a new terminal for "Exec shell". */
export function execShellCommand(cli: string, id: string): string {
  const prefix = cli === "sudo docker" ? "sudo docker" : cli === "podman" ? "podman" : "docker";
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `${prefix} exec -it ${q(id)} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`;
}

export function attachCommand(cli: string, id: string): string {
  const prefix = cli === "sudo docker" ? "sudo docker" : cli === "podman" ? "podman" : "docker";
  return `${prefix} attach ${`'${id.replace(/'/g, `'\\''`)}'`}`;
}

export interface PruneChoice {
  containers: boolean;
  images: boolean; // dangling only unless allImages
  allImages: boolean;
  volumes: boolean;
  networks: boolean;
  buildCache: boolean;
}

/** The ordered list of prune commands (argument arrays) for a dialog choice. */
export function buildPruneCommands(c: PruneChoice): string[][] {
  const out: string[][] = [];
  if (c.containers) out.push(["container", "prune", "-f"]);
  if (c.images) out.push(c.allImages ? ["image", "prune", "-a", "-f"] : ["image", "prune", "-f"]);
  if (c.volumes) out.push(["volume", "prune", "-f"]);
  if (c.networks) out.push(["network", "prune", "-f"]);
  if (c.buildCache) out.push(["builder", "prune", "-f"]);
  return out;
}

/** Last "Total reclaimed space: 1.2GB" in prune output -> bytes. */
export function parseReclaimed(out: string): number {
  const m = [...out.matchAll(/reclaimed space:\s*([0-9.]+\s*[a-zA-Z]*)/gi)].pop();
  return m ? parseSize(m[1]) : 0;
}

// --- log buffer ------------------------------------------------------------------------------------------

export interface LogLine {
  id: number;
  text: string;
  stream: "stdout" | "stderr";
}

/** Ring buffer of log lines. Chunks may split lines; a partial tail is held until its newline. */
export class LogBuffer {
  lines: LogLine[] = [];
  /** Lines dropped from the front because of the cap. */
  dropped = 0;
  maxLen = 0;
  private nextId = 1;
  private carry: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };

  constructor(readonly cap = 10_000) {}

  /** Returns how many complete lines were added. */
  push(chunk: string, stream: "stdout" | "stderr" = "stdout"): number {
    const text = this.carry[stream] + chunk;
    const parts = text.split("\n");
    this.carry[stream] = parts.pop() ?? "";
    for (const p of parts) this.add(p.endsWith("\r") ? p.slice(0, -1) : p, stream);
    return parts.length;
  }

  /** Flushes held partial lines (stream ended). */
  finish(): number {
    let n = 0;
    for (const s of ["stdout", "stderr"] as const) {
      if (this.carry[s]) {
        this.add(this.carry[s], s);
        this.carry[s] = "";
        n++;
      }
    }
    return n;
  }

  /** Partial (unterminated) text currently held, shown live while following. */
  pending(): string {
    return this.carry.stdout || this.carry.stderr;
  }

  clear(): void {
    this.dropped += this.lines.length;
    this.lines = [];
    this.maxLen = 0;
  }

  private add(text: string, stream: "stdout" | "stderr"): void {
    this.lines.push({ id: this.nextId++, text, stream });
    if (text.length > this.maxLen) this.maxLen = text.length;
    if (this.lines.length > this.cap + this.cap / 10) {
      const drop = this.lines.length - this.cap;
      this.lines.splice(0, drop);
      this.dropped += drop;
    }
  }
}

/** Simple level hint for colouring a plain log line. */
export function lineLevel(text: string): "error" | "warn" | "debug" | null {
  if (/\b(error|err|fatal|panic|exception|critical)\b/i.test(text)) return "error";
  if (/\b(warn|warning)\b/i.test(text)) return "warn";
  if (/\b(debug|trace)\b/i.test(text)) return "debug";
  return null;
}

/** Compact "3h ago" from unix seconds. */
export function ago(unix: number, now = Date.now() / 1000): string {
  if (!unix) return "";
  const d = Math.max(0, Math.floor(now - unix));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 60) return `${Math.floor(d / 86400)}d ago`;
  return `${Math.floor(d / 86400 / 30)}mo ago`;
}

/**
 * `compose [-p name] [-f file…] [--project-directory dir] <sub…>`. Files and directory are
 * included when known so `up`/`pull`/`config` find the project even from another folder.
 */
export function composeArgs(project: string, sub: string[], opts: { files?: string[]; workdir?: string | null } = {}): string[] {
  const a = ["compose", "-p", project];
  for (const f of opts.files ?? []) if (f) a.push("-f", f);
  if (opts.workdir) a.push("--project-directory", opts.workdir);
  return [...a, ...sub];
}

/** `compose -f a -f b config -q`: validates the file(s); stderr holds the error text. */
export function composeValidateArgs(files: string[], workdir?: string | null): string[] {
  const a = ["compose"];
  for (const f of files) a.push("-f", f);
  if (workdir) a.push("--project-directory", workdir);
  return [...a, "config", "-q"];
}

/** Extracts "line N" / "file:line:col" hints from a compose validation message, if any. */
export function composeErrorLine(msg: string): number | null {
  const m = /line (\d+)/i.exec(msg) ?? /\.ya?ml:(\d+)(?::\d+)?/i.exec(msg);
  return m ? Number(m[1]) : null;
}

// --- container filesystem (ls -la inside a container) ------------------------------------

export interface FsEntry {
  name: string;
  kind: "dir" | "file" | "link" | "other";
  size: number;
  /** Unix seconds; 0 when the date format was not the epoch form (busybox / default ls). */
  mtime: number;
  /** Date text as printed, for the non-epoch form ("Jan  1 12:00"). */
  mtimeText: string;
  mode: string;
  owner: string;
  group: string;
  target: string;
}

const LS_RE =
  /^([\-dlcbpsD][rwxsStTl\-.+@]{8,10}[.+@]?)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+(?:,\s*\d+)?)\s+(?:(\d{9,11})|([A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4})|\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?))\s+(.*)$/;

/** Parses `ls -la [--time-style=+%s]` output (GNU or busybox). `.` and `..` are dropped; dirs first. */
export function parseLsLa(text: string): FsEntry[] {
  const out: FsEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LS_RE.exec(raw);
    if (!m) continue;
    let name = m[8];
    let target = "";
    const kindCh = m[1][0];
    if (kindCh === "l") {
      const i = name.indexOf(" -> ");
      if (i >= 0) {
        target = name.slice(i + 4);
        name = name.slice(0, i);
      }
    }
    if (name === "." || name === "..") continue;
    out.push({
      name,
      kind: kindCh === "d" ? "dir" : kindCh === "-" ? "file" : kindCh === "l" ? "link" : "other",
      size: parseInt(m[5], 10) || 0,
      mtime: m[6] ? Number(m[6]) : 0,
      mtimeText: m[7] ?? "",
      mode: m[1],
      owner: m[3],
      group: m[4],
      target,
    });
  }
  return out.sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name));
}

/** True when `ls --time-style` was rejected (busybox / alpine): retry with plain `ls -la`. */
export function lsNeedsFallback(code: number | null, stderr: string): boolean {
  return code !== 0 && /unrecognized option|invalid option|unknown option|usage:|time-style/i.test(stderr);
}

/** Joins container (POSIX) paths; `..` is resolved, the result is absolute. */
export function cjoin(dir: string, name: string): string {
  const parts = (name.startsWith("/") ? name : `${dir}/${name}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return "/" + out.join("/");
}

export function cparent(path: string): string {
  return cjoin(path, "..");
}

/** NUL byte in the first 8 KiB: treat as binary (same rule as the editor). */
export function looksBinary(text: string): boolean {
  return text.slice(0, 8192).includes("\0");
}
