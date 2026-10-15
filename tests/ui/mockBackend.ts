// In-browser fake backend for the UI test harness (docs/GUIDE.md §5.2/§11.1).
// Loaded by harness.ts *before* src/main.ts, via @tauri-apps/api/mocks.
// Every command OverSSH's frontend can call is faked here so the whole app
// (hosts, connect, explorer, editor, terminal, settings/profiles/history/
// paused persistence) runs in a real browser with zero Rust/Tauri runtime.
//
// Test code drives/observes this through `window.__harness` (see bottom):
// scenarios never poke @tauri-apps/api directly, they call the small surface
// exposed here (emit a term event, inspect what got saved to a store, etc.).

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit, listen } from "@tauri-apps/api/event";
import type {
  ConnectRequest,
  FileEntry,
  ForwardInfo,
  ForwardSpec,
  HostEntry,
  SessionInfo,
} from "../../src/lib/types";

mockWindows("main");

// --- fake git (§14): handler chain, one entry per agent -------------------------------
import { gitFake, gitHandlerG2, type GitHandler } from "./fakeGitG2";
import { syncCommand } from "./mockSync"; // §15.3.Y settings sync (window.__sync)
import { systemdCommand } from "./mockSystemd"; // §15.3.V systemd services (window.__systemd)
import { dockerFake, dockerRun, eventsStart as dockerEventsStart, logsStart as dockerLogsStart, pushLog as dockerPushLog, resetDocker, statsStart as dockerStatsStart, streamStop as dockerStreamStop, emitEvent as dockerEmitEvent } from "./mockDocker"; // §15.3.D docker
import { g1GitDirList, g1GitRun, g1Patch, g1Snapshot, gitCalls as g1GitCalls, setGitMissing as g1SetGitMissing } from "./mockGit";
// G2's handler answers only while `gitFake.active`; G1's (tests/ui/mockGit.ts) is the Source Control fake.
const gitHandlers: GitHandler[] = [gitHandlerG2, (req) => g1GitRun(req.repo, req.args, req.stdin ?? undefined)];

// --- fake data -------------------------------------------------------------

export const FAKE_HOSTS: HostEntry[] = [
  { alias: "alpha", hostname: "alpha.example.com", user: "root", port: 22, identityFiles: [], proxyJump: null },
  { alias: "beta", hostname: "beta.example.com", user: "deploy", port: 2222, identityFiles: [], proxyJump: null },
  { alias: "gamma", hostname: "gamma.example.com", user: null, port: 22, identityFiles: [], proxyJump: null },
];

const HOME = "/home/testuser";

function entry(
  name: string,
  dir: string,
  kind: FileEntry["kind"] = "file",
  size = 128,
): FileEntry {
  return {
    name,
    path: `${dir === "/" ? "" : dir}/${name}`,
    kind,
    size,
    mtime: 1_700_000_000,
    permissions: kind === "dir" ? 0o40755 : 0o100644,
    isHidden: name.startsWith("."),
  };
}

const tree: Record<string, FileEntry[]> = {
  "/": [entry("home", "/", "dir", 0)],
  "/home": [entry("testuser", "/home", "dir", 0)],
  [HOME]: [
    entry("projects", HOME, "dir", 0),
    entry(".config", HOME, "dir", 0),
    entry("readme.txt", HOME),
    entry("notes.md", HOME),
  ],
  [`${HOME}/projects`]: [entry("app.js", `${HOME}/projects`), entry("index.html", `${HOME}/projects`)],
  [`${HOME}/.config`]: [entry("settings.ini", `${HOME}/.config`)],
};

const fileContents: Record<string, string> = {
  [`${HOME}/readme.txt`]: "Hello from the fake remote filesystem.\n",
  [`${HOME}/notes.md`]: "# Notes\n\nThis is fake file content served by the UI test harness.\n",
  [`${HOME}/projects/app.js`]: "console.log('hi');\n",
  [`${HOME}/projects/index.html`]: "<!doctype html>\n<title>fake</title>\n",
  [`${HOME}/.config/settings.ini`]: "[core]\nfake=true\n",
};

// --- fake persistence (in-memory "disk") -----------------------------------

const stores = new Map<string, unknown>();

// A scenario's `beforeLoad` hook (tests/ui/scenario.ts) runs *before*
// run.ts's own `page.goto`, via `page.addInitScript`, which executes before
// any of this page's own scripts — including this module. That's the only
// window in which a scenario can seed a store the app must see on its very
// first load (e.g. `hosts.svelte.ts`'s self-triggered `initHosts()`, which
// has already run by the time a scenario's `run()` is called). A scenario
// sets `window.__HARNESS_SEED_STORES__` from its `beforeLoad`; anything in it
// is pre-loaded into `stores` before `mockIPC` starts serving `load_store`.
declare global {
  interface Window {
    __HARNESS_SEED_STORES__?: Record<string, unknown>;
    /** Scenario 23: extra `~/.ssh/config` hosts (e.g. one with a proxyJump). */
    __HARNESS_EXTRA_HOSTS__?: HostEntry[];
  }
}
if (window.__HARNESS_SEED_STORES__) {
  for (const [name, value] of Object.entries(window.__HARNESS_SEED_STORES__)) {
    stores.set(name, value);
  }
}

// --- fake sessions -----------------------------------------------------------

let sessionCounter = 0;
let forwardCounter = 0;
const forwards = new Map<string, ForwardInfo>();
const connectRequests: ConnectRequest[] = [];
const failNextConnect: unknown[] = [];
let termCounter = 0;
let searchCounter = 0;
const cancelledSearches = new Set<string>();
let logCounter = 0;
const logStreams: { id: string; sessionId: string; source: unknown }[] = [];
const sessions = new Map<string, SessionInfo>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long `read_file` takes before resolving — overridable per-test via
 * `window.__harness.setReadFileDelay(ms)` (default matches the task's "1.5s
 * delay" so the loader scenario has something to observe). */
let readFileDelayMs = 1500;

// --- fake filesystem helpers (rename / remove / copy_path) -------------------

function splitPath(path: string): [string, string] {
  const i = path.lastIndexOf("/");
  return [path.slice(0, i) || "/", path.slice(i + 1)];
}

function findEntry(path: string): FileEntry | null {
  const [dir, name] = splitPath(path);
  return tree[dir]?.find((e) => e.name === name) ?? null;
}

function inside(dir: string, path: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function conflict(message: string): never {
  throw { kind: "Conflict", message };
}

/** Moves (or, with `copy`, duplicates) a file/dir subtree. Fails if `to` exists. */
function transferSubtree(from: string, to: string, copy: boolean): void {
  const src = findEntry(from);
  if (!src) notFound(from);
  if (findEntry(to)) conflict(`${to} already exists`);
  if (inside(from, to)) conflict(`cannot move ${from} into itself`);
  const [toDir, toName] = splitPath(to);
  if (!tree[toDir]) notFound(toDir);
  const rewrite = (p: string) => to + p.slice(from.length);
  for (const key of Object.keys(tree).filter((k) => inside(from, k))) {
    const newKey = rewrite(key);
    tree[newKey] = tree[key].map((e) => ({ ...e, path: `${newKey}/${e.name}` }));
    if (!copy) delete tree[key];
  }
  for (const key of Object.keys(fileContents).filter((k) => inside(from, k))) {
    fileContents[rewrite(key)] = fileContents[key];
    if (!copy) delete fileContents[key];
  }
  if (!copy) {
    const [fromDir] = splitPath(from);
    tree[fromDir] = tree[fromDir].filter((e) => e.path !== from);
  }
  tree[toDir].push({ ...src, name: toName, path: to });
}

function removeSubtree(path: string): void {
  if (!findEntry(path)) notFound(path);
  for (const key of Object.keys(tree).filter((k) => inside(path, k))) delete tree[key];
  for (const key of Object.keys(fileContents).filter((k) => inside(path, k))) delete fileContents[key];
  const [dir] = splitPath(path);
  tree[dir] = tree[dir].filter((e) => e.path !== path);
}

/** Every `write_file` call, in order — lets a scenario assert *which path* a save wrote. */
const writeLog: { path: string; content: string; expectedMtime?: number }[] = [];
/** Per-path mtimes for paths touched via `__harness.touchRemote` or written since (§13.4.D). */
const mtimes: Record<string, number> = {};
const touchedPaths = new Set<string>();
const mtimeOf = (path: string): number => mtimes[path] ?? 1_700_000_000;

function notFound(path: string): never {
  throw { kind: "NotFound", message: `No such file or directory: ${path}` };
}

// --- fake cron + disk usage (cron.rs / diskusage.rs, §13.4.C) ----------------------

let cronText = ["MAILTO=ops@example.com", "# nightly backup", "30 2 * * 1 /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1", "#*/10 * * * * /opt/old-job.sh", ""].join(String.fromCharCode(10));
const cronWrites: string[] = [];
const termWriteLog: { termId: string; data: string }[] = [];
const termResizeLog: { termId: string; cols: number; rows: number }[] = [];
let duCounter = 0;
const duRequests: { path: string; depth: number }[] = [];
const cancelledDu = new Set<string>();
// KiB per directory (du -k); "/" scans also report some permission-denied dirs.
const FAKE_DU: Record<string, number> = {
  "/": 1_000_000,
  "/home": 600_000,
  [HOME]: 580_000,
  [`${HOME}/projects`]: 400_000,
  [`${HOME}/projects/app`]: 250_000,
  [`${HOME}/projects/data`]: 140_000,
  [`${HOME}/.config`]: 30_000,
  [`${HOME}/.cache`]: 90_000,
  "/var": 300_000,
  "/var/log": 200_000,
  "/var/lib": 90_000,
  "/usr": 80_000,
};
const duDepth = (p: string) => (p === "/" ? 0 : p.split("/").length - 1);

// --- fake dashboard (monitor.rs) ---------------------------------------------

const monitorTimers = new Map<string, { timer: ReturnType<typeof setInterval>; intervalMs: number; threads: boolean }>();
const killLog: { pid: number; signal: string }[] = [];
const reniceLog: { pid: number; nice: number }[] = [];
const detailLog: number[] = [];
let monitorTick = 0;

function fakeSnapshot(threads = false) {
  monitorTick += 1;
  const wob = (monitorTick % 7) * 3;
  const core = (i: number) => {
    const user = 10 + ((i * 17 + wob) % 40);
    return { user, nice: 1, system: 5 + i, iowait: 1, steal: 0, total: user + 7 + i };
  };
  const proc = (pid: number, ppid: number, user: string, cpu: number, res: number, args: string) => ({
    pid, ppid, user, pri: 20, ni: 0, virt: res * 3, res, state: cpu > 20 ? "R" : "S", cpu, mem: res / 83886080,
    time: pid * 1.5, threads: 2, command: args.split(" ")[0].split("/").pop() ?? args, args, kernel: false,
    shr: res / 4, start: Date.now() / 1000 - 7200, tgid: pid, thread: false,
  });
  const thread = (tid: number, tgid: number, user: string, cpu: number, res: number, args: string) => ({
    ...proc(tid, tgid, user, cpu, res, args), command: "nginx-w", tgid, thread: true, state: "S",
  });
  return {
    ts: Date.now(),
    host: { hostname: "fakevm", kernel: "Linux 6.1.0", os: "Debian GNU/Linux 12", arch: "x86_64", cores: 4 },
    cpu: { user: 25, nice: 1, system: 8, iowait: 2, steal: 0, total: 36 },
    cores: [0, 1, 2, 3].map(core),
    load: [0.52, 0.4, 0.31],
    uptime: 93784,
    mem: { total: 8 * 2 ** 30, used: 3 * 2 ** 30, buffers: 100 * 2 ** 20, cache: 2 * 2 ** 30, available: 4 * 2 ** 30, swapTotal: 2 ** 30, swapUsed: 100 * 2 ** 20 },
    tasks: { total: 6, running: 1, threads: 12 },
    procs: [
      proc(1, 0, "root", 0.1, 12 << 20, "/sbin/init splash"),
      proc(412, 1, "root", 1.5, 30 << 20, "/usr/sbin/sshd -D"),
      proc(900, 412, "alice", 0.2, 8 << 20, "sshd: alice@pts/0"),
      proc(901, 900, "alice", 0.0, 6 << 20, "-bash"),
      proc(1234, 1, "www-data", 42.5, 200 << 20, "nginx: worker process"),
      proc(2345, 1, "postgres", 7.25, 500 << 20, "postgres: checkpointer"),
      { ...proc(77, 2, "root", 0, 0, "[kworker/0:1]"), command: "kworker/0:1", kernel: true, virt: 0 },
      ...(threads
        ? [thread(1235, 1234, "www-data", 20, 200 << 20, "nginx: worker process"), thread(1236, 1234, "www-data", 1, 200 << 20, "nginx: worker process")]
        : []),
    ],
    net: [{ name: "eth0", rxBytes: 1e9, txBytes: 5e8, rxRate: 120000 + wob * 1000, txRate: 45000 }],
    disks: [{ filesystem: "/dev/sda1", mount: "/", total: 50 * 2 ** 30, used: 20 * 2 ** 30, avail: 30 * 2 ** 30, percent: 40 }],
  };
}

// --- fake transfers (transfer.rs, §13.4.S) -------------------------------------------

let dialogResult: unknown = null;
let transferCounter = 0;
let transferStepMs = 60;
const transferSpecs: Record<string, unknown>[] = [];
const cancelledJobs = new Set<string>();

function subtreeFiles(path: string): FileEntry[] {
  const root = findEntry(path);
  if (!root) return [];
  if (root.kind !== "dir") return [root];
  const out: FileEntry[] = [];
  for (const key of Object.keys(tree).filter((k) => inside(path, k))) {
    for (const e of tree[key]) if (e.kind !== "dir") out.push(e);
  }
  return out;
}

async function runFakeTransfer(jobId: string, spec: Record<string, unknown>): Promise<void> {
  const items = spec.items as string[];
  const kind = spec.kind as string;
  const files = kind === "upload" ? [] : items.flatMap((i) => subtreeFiles(i));
  const filesTotal = kind === "upload" ? items.length : files.length;
  const bytesTotal = kind === "upload" ? items.length * 1000 : files.reduce((a, f) => a + f.size, 0);
  await emit("transfer://progress", { jobId, bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal, currentPath: "", rateBps: 0, etaSecs: null, scanning: true });
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    await delay(transferStepMs);
    if (cancelledJobs.has(jobId)) {
      await emit("transfer://done", { jobId, cancelled: true, failed: 0, skipped: 0, filesDone: 0, bytesDone: 0 });
      return;
    }
    const bytesDone = Math.round((bytesTotal * i) / steps);
    await emit("transfer://progress", {
      jobId, bytesDone, bytesTotal, filesDone: Math.floor((filesTotal * i) / steps), filesTotal,
      currentPath: files[Math.min(files.length - 1, i - 1)]?.name ?? "", rateBps: 1_000_000,
      etaSecs: steps - i, scanning: false,
    });
  }
  const dest = spec.dest as string;
  try {
    for (const item of items) {
      const name = (spec.rename as string | undefined) ?? item.replace(/\\/g, "/").split("/").pop()!;
      if (kind === "download") continue;
      if (kind === "copy") transferSubtree(item, `${dest}/${name}`, true);
      else if (!findEntry(`${dest}/${name}`)) {
        fileContents[`${dest}/${name}`] = "uploaded";
        (tree[dest] ??= []).push(entry(name, dest));
      }
    }
  } catch {
    /* clash: leave as is */
  }
  await emit("transfer://done", { jobId, failed: 0, skipped: 0, filesDone: filesTotal, bytesDone: bytesTotal });
}

async function handle(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  // File commands on a session the backend no longer has (dropped / disconnected) fail like a dead link.
  if (
    typeof args.sessionId === "string" &&
    ["list_dir", "stat", "read_file", "write_file"].includes(cmd) &&
    !sessions.has(args.sessionId)
  ) {
    throw { kind: "Connection", message: "no such session" };
  }
  if (cmd.startsWith("systemd_")) return systemdCommand(cmd, args);
  switch (cmd) {
    case "list_hosts":
      return [...FAKE_HOSTS, ...(window.__HARNESS_EXTRA_HOSTS__ ?? [])];

    case "connect": {
      const req = args.req as ConnectRequest;
      connectRequests.push(JSON.parse(JSON.stringify(req)) as ConnectRequest);
      const fail = failNextConnect.shift();
      if (fail) throw fail;
      sessionCounter += 1;
      const id = `sess-${sessionCounter}`;
      const user = req.user ?? "testuser";
      const hostname = req.hostname ?? req.alias ?? "unknown";
      const info: SessionInfo = {
        id,
        label: req.alias ?? `${user}@${hostname}`,
        user,
        hostname,
        home: HOME,
      };
      sessions.set(id, info);
      return info;
    }

    case "session_ping": {
      // §13.4.A: a session the harness "dropped" no longer answers.
      if (!sessions.has(args.sessionId as string)) throw { kind: "Connection", message: "ping failed" };
      return null;
    }

    case "disconnect": {
      sessions.delete(args.sessionId as string);
      for (const [fid, f] of forwards) if (f.sessionId === args.sessionId) forwards.delete(fid);
      return null;
    }

    case "list_dir": {
      const path = args.path as string;
      const gitDir = g1GitDirList(path);
      if (gitDir) return gitDir.map((e) => ({ ...e, size: 0, mtime: 0, permissions: e.kind === "dir" ? 0o40755 : 0o100644, isHidden: false }));
      const entries = tree[path];
      if (!entries) notFound(path);
      return entries.map((e) => ({ ...e }));
    }

    case "stat": {
      const path = args.path as string;
      const found = findEntry(path);
      if (found) return found;
      notFound(path);
    }

    // Scenario 57 (docs/GUIDE.md §14.4.X): properties dialog + on-demand folder size.
    case "file_info": {
      const path = args.path as string;
      const found = findEntry(path);
      if (!found) notFound(path);
      const isFile = found.kind === "file";
      return {
        path,
        name: found.name,
        kind: found.kind,
        linkTarget: found.kind === "symlink" ? "/etc/hostname" : null,
        linkTargetKind: found.kind === "symlink" ? "file" : null,
        size: found.size,
        mode: found.permissions,
        uid: 1000,
        gid: 1000,
        user: "testuser",
        group: "staff",
        atime: 1_700_000_100,
        mtime: found.mtime,
        ctime: 1_700_000_200,
        btime: null,
        hardLinks: 1,
        mime: isFile ? "text/plain" : "inode/directory",
        lines: isFile ? (fileContents[path] ?? "").split(String.fromCharCode(10)).length - 1 : null,
      };
    }

    case "dir_size": {
      const path = args.path as string;
      if (!tree[path]) notFound(path);
      const files = Object.keys(fileContents).filter((p) => inside(path, p));
      return {
        bytes: files.reduce((n, p) => n + fileContents[p].length, 0) + 4096,
        files: files.length,
        dirs: Object.keys(tree).filter((d) => d !== path && inside(path, d)).length,
        partial: false,
      };
    }

    case "read_file": {
      const path = args.path as string;
      await delay(readFileDelayMs);
      const content = fileContents[path];
      if (content === undefined) notFound(path);
      return {
        path,
        content,
        mtime: mtimeOf(path),
        size: content.length,
        isBinary: false,
      };
    }

    case "write_file": {
      const path = args.path as string;
      const expected = args.expectedMtime as number | undefined;
      if (touchedPaths.has(path) && expected !== undefined && expected !== mtimeOf(path)) {
        conflict(`${path} changed on the server`);
      }
      fileContents[path] = args.content as string;
      writeLog.push({ path, content: args.content as string, expectedMtime: expected });
      // Like the real backend: writing creates the file if it is missing.
      if (!findEntry(path)) {
        const [dir, name] = splitPath(path);
        if (tree[dir]) tree[dir].push(entry(name, dir));
        else notFound(dir);
      }
      mtimes[path] = mtimeOf(path) + 1;
      return mtimes[path];
    }

    case "write_file_sudo": {
      const path = args.path as string;
      fileContents[path] = args.content as string;
      return 1_700_000_002;
    }

    case "create_file": {
      const path = args.path as string;
      if (findEntry(path)) conflict(`${path} already exists`);
      fileContents[path] = "";
      const dir = path.slice(0, path.lastIndexOf("/")) || "/";
      const name = path.slice(path.lastIndexOf("/") + 1);
      (tree[dir] ??= []).push(entry(name, dir));
      return null;
    }

    case "create_dir": {
      const path = args.path as string;
      tree[path] ??= [];
      const dir = path.slice(0, path.lastIndexOf("/")) || "/";
      const name = path.slice(path.lastIndexOf("/") + 1);
      (tree[dir] ??= []).push(entry(name, dir, "dir", 0));
      return null;
    }

    case "rename":
      transferSubtree(args.from as string, args.to as string, false);
      return null;

    case "copy_path":
      transferSubtree(args.from as string, args.to as string, true);
      return null;

    case "remove":
      removeSubtree(args.path as string);
      return null;

    case "transfer_start": {
      transferCounter += 1;
      const id = `job-${transferCounter}`;
      const spec = JSON.parse(JSON.stringify(args.spec)) as Record<string, unknown>;
      transferSpecs.push(spec);
      void runFakeTransfer(id, spec);
      return id;
    }

    case "transfer_cancel":
      cancelledJobs.add(args.jobId as string);
      return null;

    case "transfer_resolve":
      return null;

    case "download":
      return null;

    case "upload":
      return `${args.remoteDir}/uploaded`;

    case "term_open": {
      termCounter += 1;
      return `term-${termCounter}`;
    }

    case "term_write":
      termWriteLog.push({ termId: args.termId as string, data: args.data as string });
      return null;

    case "term_resize":
      termResizeLog.push({ termId: args.termId as string, cols: args.cols as number, rows: args.rows as number });
      return null;
    case "term_close":
      return null;

    // §14.4.W detachable terminal window: the fake window announces itself with
    // `termwin://ready` shortly after it is "created" (the init message the main
    // window answers with is observable through `__harness.termwinEvents()`).
    case "term_snapshot":
      return { data: "", seq: 0 };
    case "term_window_open":
      termWindowCalls.push({ cmd, args });
      if (!termWindowOpen) {
        termWindowOpen = true;
        setTimeout(() => void emit("termwin://ready"), 30);
      }
      return null;
    case "term_window_focus":
      termWindowCalls.push({ cmd, args });
      return null;
    case "term_window_close":
      termWindowCalls.push({ cmd, args });
      termWindowOpen = false;
      return null;

    // §13.4.R search: case-insensitive substring over fakeContents under root,
    // streamed (matches event, then done) a few ms after the id is returned.
    case "search_start": {
      const req = args.req as { root: string; query: string; caseSensitive?: boolean };
      searchCounter += 1;
      const id = `search-${searchCounter}`;
      const needle = req.caseSensitive ? req.query : req.query.toLowerCase();
      const matches: { path: string; line: number; text: string }[] = [];
      for (const [path, content] of Object.entries(fileContents)) {
        if (!path.startsWith(req.root.replace(/\/$/, "") + "/")) continue;
        content.split("\n").forEach((text, i) => {
          if ((req.caseSensitive ? text : text.toLowerCase()).includes(needle)) {
            matches.push({ path, line: i + 1, text });
          }
        });
      }
      setTimeout(() => {
        if (cancelledSearches.has(id)) return;
        if (matches.length) void emit("search://matches", { searchId: id, matches });
        void emit("search://done", { searchId: id, total: matches.length, truncated: false, engine: "grep" });
      }, 60);
      return id;
    }

    case "search_cancel":
      cancelledSearches.add(args.searchId as string);
      return null;

    case "cron_read":
      return cronText;

    case "cron_write":
      cronText = args.text as string;
      cronWrites.push(cronText);
      return null;

    case "du_start": {
      duCounter += 1;
      const id = `du-${duCounter}`;
      const root = (args.path as string).replace(/(.)\/+$/, "$1");
      const depth = Number(args.depth) || 1;
      duRequests.push({ path: root, depth });
      const entries = Object.keys(FAKE_DU)
        .filter((p) => (root === "/" ? true : p === root || p.startsWith(root + "/")) && duDepth(p) - duDepth(root) <= depth)
        .sort((a, b) => duDepth(b) - duDepth(a) || a.localeCompare(b))
        .map((path) => ({ path, kb: FAKE_DU[path] }));
      setTimeout(() => {
        if (cancelledDu.has(id)) {
          void emit("du://done", { duId: id, cancelled: true, denied: 0, errors: 0, errorSamples: [], code: null });
          return;
        }
        if (entries.length) void emit("du://entries", { duId: id, entries });
        void emit("du://done", {
          duId: id, cancelled: false, denied: root === "/" ? 3 : 0, errors: 0, errorSamples: [], code: root === "/" ? 1 : 0,
        });
      }, 60);
      return id;
    }

    case "du_cancel":
      cancelledDu.add(args.duId as string);
      return null;

    case "monitor_start": {
      const sid = args.sessionId as string;
      const ms = Math.max(50, Math.min(Number(args.intervalMs) || 1000, 400));
      clearInterval(monitorTimers.get(sid)?.timer);
      const threads = args.threads === true;
      const timer = setInterval(() => void emit("monitor://snapshot", { sessionId: sid, snapshot: fakeSnapshot(threads) }), ms);
      monitorTimers.set(sid, { timer, intervalMs: Number(args.intervalMs), threads });
      void emit("monitor://snapshot", { sessionId: sid, snapshot: fakeSnapshot(threads) });
      return null;
    }

    case "monitor_stop":
      clearInterval(monitorTimers.get(args.sessionId as string)?.timer);
      monitorTimers.delete(args.sessionId as string);
      return null;

    case "proc_kill":
      killLog.push({ pid: args.pid as number, signal: args.signal as string });
      return null;

    case "proc_kill_many":
      for (const pid of args.pids as number[]) killLog.push({ pid, signal: args.signal as string });
      return null;

    case "proc_renice":
      reniceLog.push({ pid: args.pid as number, nice: args.nice as number });
      return null;

    case "proc_details": {
      const pid = args.pid as number;
      detailLog.push(pid);
      if (pid === 2345) {
        // permission-denied shape: unreadable fields come back as -1 / empty
        return {
          pid, exists: true, cmdline: "", exe: "", cwd: "", envCount: -1, fdCount: -1, fds: [], threads: 2, ppid: 1,
          uid: "113", vmPeak: 0, vmSwap: 0, ctxVoluntary: 5, ctxNonvoluntary: 1, ioRead: -1, ioWrite: -1, children: [],
        };
      }
      return {
        pid, exists: true, cmdline: `/usr/sbin/nginx -g daemon off; -c /etc/nginx/nginx.conf (pid ${pid})`,
        exe: "/usr/sbin/nginx", cwd: "/srv/www", envCount: 14, fdCount: 23, fds: ["/dev/null", "socket:[1234]", "/var/log/nginx/access.log"],
        threads: 2, ppid: 1, uid: "33", vmPeak: 700 << 20, vmSwap: 0, ctxVoluntary: 1200, ctxNonvoluntary: 30,
        ioRead: 4096, ioWrite: 8192, children: pid === 1 ? [412, 1234, 2345] : [],
      };
    }

    case "logs_open": {
      logCounter += 1;
      const id = `log-${logCounter}`;
      logStreams.push({ id, sessionId: args.sessionId as string, source: args.source });
      return id;
    }

    case "logs_close": {
      void emit("logs://end", { streamId: args.streamId, code: null });
      return null;
    }

    case "logs_discover":
      return { files: ["/var/log/syslog", "/var/log/auth.log"], containers: ["web"], units: ["ssh.service"] };

    case "logs_export":
      return null;

    case "forward_start": {
      const sessionId = args.sessionId as string;
      const spec = args.spec as ForwardSpec;
      if (!sessions.has(sessionId)) throw { kind: "NotFound", message: `no such session: ${sessionId}` };
      if (spec.bindPort === 1) throw { kind: "Io", message: `Port 1 is already in use on ${spec.bindAddress ?? "127.0.0.1"}` };
      forwardCounter += 1;
      const info: ForwardInfo = {
        id: `fwd-${forwardCounter}`,
        sessionId,
        kind: spec.kind,
        bindAddress: spec.bindAddress ?? (spec.kind === "R" ? "localhost" : "127.0.0.1"),
        bindPort: spec.bindPort,
        targetHost: spec.targetHost,
        targetPort: spec.targetPort,
        label: spec.label ?? null,
        state: "running",
        activeConnections: 0,
        totalConnections: 0,
        bytesIn: 0,
        bytesOut: 0,
        lastError: null,
      };
      forwards.set(info.id, info);
      return info;
    }

    case "forward_stop": {
      const id = args.forwardId as string;
      const info = forwards.get(id);
      forwards.delete(id);
      if (info) await emit("forward://state", { forwardId: id, sessionId: info.sessionId, state: "stopped", message: null });
      return null;
    }

    case "forward_list":
      return [...forwards.values()];

    case "forward_set_close_to_tray":
      return null;

    // §13.4.T2 recording: calls are logged for scenario 36; one fake .cast file.
    case "rec_default_dir":
      return "C:/fake/recordings";
    case "rec_start":
      recLog.push({ cmd, args });
      return `C:/fake/recordings/alpha-20240101-120000.cast`;
    case "rec_stop":
    case "rec_delete":
    case "rec_reveal":
      recLog.push({ cmd, args });
      return null;
    case "rec_list":
      return [
        {
          path: "C:/fake/recordings/alpha-20240101-120000.cast",
          name: "alpha-20240101-120000.cast",
          host: "alpha",
          startedAt: 1704110400,
          duration: 3.5,
          size: 321,
        },
      ];
    case "rec_read":
      return FAKE_CAST;

    // §14 git: `gitHandlers` (see the end of this file) are tried in order; first non-null answer wins.
    case "git_run": {
      const req = { repo: args.repo as string, args: args.args as string[], stdin: (args.stdin as string | null) ?? null };
      for (const h of gitHandlers) {
        const out = h(req);
        if (out) return out;
      }
      return { code: 128, stdout: "", stderr: `fatal: fake git does not know: ${req.args.join(" ")}`, truncated: false };
    }

    case "local_write_text":
    case "local_read_text":
      return syncCommand(cmd, args);

    // §15.3.D docker: fake CLI and streams (tests/ui/mockDocker.ts)
    case "docker_run":
      return dockerRun(args.args as string[], (args.command as string | null) ?? null, (args.stdin as string | null) ?? null);
    case "docker_logs_start":
      return dockerLogsStart(args.sessionId as string, args.target as string, (args.opts as Record<string, unknown>) ?? {});
    case "docker_stats_start":
      return dockerStatsStart();
    case "docker_events_start":
      return dockerEventsStart();
    case "docker_logs_stop":
    case "docker_stats_stop":
    case "docker_events_stop":
      dockerStreamStop(args.streamId as string);
      return null;

    case "load_store":
      return stores.get(args.name as string) ?? null;

    case "save_store":
      stores.set(args.name as string, args.value);
      return null;

    default:
      if (cmd.startsWith("plugin:dialog|")) return dialogResult; // null = open/save cancelled
      // Window chrome (§15.3.T): minimize / maximize / close / title are only recorded.
      if (cmd.startsWith("plugin:window|")) return windowCommand(cmd.slice("plugin:window|".length), args);
      if (cmd === "plugin:app|version") return "0.1.0";
      // Clipboard plugin: route to the page clipboard so scenarios can read it back.
      if (cmd === "plugin:clipboard-manager|read_text") return navigator.clipboard.readText();
      if (cmd === "plugin:clipboard-manager|write_text") return navigator.clipboard.writeText(String(args.text ?? ""));
      console.warn(`[harness] unhandled command: ${cmd}`, args);
      return null;
  }
}

const windowCalls: { cmd: string; args: Record<string, unknown> }[] = [];
let windowMaximized = false;
let windowTitle = "";
function windowCommand(name: string, args: Record<string, unknown>): unknown {
  if (name === "is_maximized") return windowMaximized;
  if (name === "set_title") windowTitle = String(args.value ?? "");
  windowCalls.push({ cmd: name, args });
  if (name === "toggle_maximize" || name === "internal_toggle_maximize") windowMaximized = !windowMaximized;
  else if (name === "maximize") windowMaximized = true;
  else if (name === "unmaximize") windowMaximized = false;
  if (/maximize/.test(name)) void emit("tauri://resize", { width: 1280, height: 800 });
  return null;
}

mockIPC((cmd, args) => handle(cmd, (args ?? {}) as Record<string, unknown>), {
  shouldMockEvents: true,
});

const recLog: { cmd: string; args: Record<string, unknown> }[] = [];
const termWindowCalls: { cmd: string; args: Record<string, unknown> }[] = [];
let termWindowOpen = false;
const termwinLog: { name: string; payload: unknown }[] = [];
for (const name of ["init", "ctx", "settings", "remap", "open", "reopen", "activate", "close-requested", "split", "ready", "tabs", "dock", "opened"]) {
  void listen("termwin://" + name, (e) => termwinLog.push({ name, payload: e.payload }));
}

const FAKE_CAST = [
  JSON.stringify({ version: 2, width: 60, height: 10, timestamp: 1704110400, title: "alpha", env: { TERM: "xterm-256color", SHELL: "/bin/sh" } }),
  JSON.stringify([0.1, "o", "hello-from-cast\r\n"]),
  JSON.stringify([3.5, "o", "second-line\r\n"]),
].join("\n");

// --- surface for tests (window.__harness) -----------------------------------

declare global {
  interface Window {
    __harness: {
      emit: (event: string, payload: unknown) => Promise<void>;
      getStore: (name: string) => unknown;
      setStore: (name: string, value: unknown) => void;
      setReadFileDelay: (ms: number) => void;
      sessions: () => SessionInfo[];
      /** Every `connect` request the app sent, in order (secrets included, test-only). */
      connectRequests: () => ConnectRequest[];
      /** Make the next `connect` call reject with this AppError-shaped value. */
      failNextConnect: (err: unknown) => void;
      forwards: () => ForwardInfo[];
      /** Log streams opened via `logs_open` (docs/GUIDE.md §13.4.L). */
      logStreams: () => { id: string; sessionId: string; source: unknown }[];
      /** Simulates the file being deleted server-side (e.g. while a session
       * is paused): removes it from both the fake tree and its contents, so
       * a later `read_file`/`list_dir` behaves as if it's gone. */
      deleteFile: (path: string) => void;
      /** Fake-filesystem inspection for file-op scenarios. */
      fileExists: (path: string) => boolean;
      fileContent: (path: string) => string | null;
      writes: () => { path: string; content: string; expectedMtime?: number }[];
      /** Simulates another client editing the file: new content + bumped mtime; later guarded writes conflict. */
      touchRemote: (path: string, content: string) => void;
      /** Simulates a network drop (§13.4.A): the session stops answering and
       * `session://closed` fires with an error reason (not a user disconnect). */
      dropSession: (sessionId: string, reason?: string) => Promise<void>;
      /** Dashboard (§13.4.M / §14.4.H) test surface. */
      monitorRunning: () => { sessionId: string; intervalMs: number; threads: boolean }[];
      kills: () => { pid: number; signal: string }[];
      reniceCalls: () => { pid: number; nice: number }[];
      detailCalls: () => number[];
      /** term_window_* commands the app sent (§14.4.W). */
      termWindowCalls: () => { cmd: string; args: Record<string, unknown> }[];
      /** Every `termwin://*` message the main window emitted, in order (§14.4.W). */
      termwinEvents: () => { name: string; payload: unknown }[];
      /** Window commands (`plugin:window|*`: minimize, toggle_maximize, close, ...) the title bar sent (§15.3.T). */
      windowCalls: () => { cmd: string; args: Record<string, unknown> }[];
      windowTitle: () => string;
      /** Set the fake window's maximized state (and fire a resize event). */
      setMaximized: (v: boolean) => Promise<void>;
      /** rec_* commands the app sent (§13.4.T2). */
      recCalls: () => { cmd: string; args: Record<string, unknown> }[];
      /** `transfer_start` specs, in order (§13.4.S). */
      transferSpecs: () => Record<string, unknown>[];
      /** Delay between fake progress steps (4 steps per job). */
      setTransferStepMs: (ms: number) => void;
      /** What the native open/save dialogs resolve to (default null = cancelled). */
      setDialogResult: (v: unknown) => void;
      /** §14.4.G1 fake git (tests/ui/mockGit.ts): every `git_run` the sidebar sent, a repo snapshot, "git not installed", patches. */
      g1GitCalls: () => { repo: string; args: string[]; stdin?: string }[];
      g1GitSnapshot: (root?: string) => Record<string, unknown> | null;
      g1GitMissing: (missing: boolean) => void;
      g1GitPatch: (root: string, patch: Record<string, unknown>) => void;
    };
  }
}

window.__harness = {
  emit: (event, payload) => emit(event, payload),
  getStore: (name) => stores.get(name) ?? null,
  setStore: (name, value) => stores.set(name, value),
  setReadFileDelay: (ms) => {
    readFileDelayMs = ms;
  },
  sessions: () => [...sessions.values()],
  dropSession: (sessionId, reason = "connection reset by peer") => {
    sessions.delete(sessionId);
    return emit("session://closed", { sessionId, reason });
  },
  connectRequests: () => connectRequests,
  failNextConnect: (err) => {
    failNextConnect.push(err);
  },
  forwards: () => [...forwards.values()],
  logStreams: () => [...logStreams],
  touchRemote: (path, content) => {
    fileContents[path] = content;
    mtimes[path] = mtimeOf(path) + 100;
    touchedPaths.add(path);
  },
  fileExists: (path) => findEntry(path) !== null,
  fileContent: (path) => fileContents[path] ?? null,
  writes: () => writeLog.map((w) => ({ ...w })),
  windowCalls: () => windowCalls.map((c) => ({ cmd: c.cmd, args: { ...c.args } })),
  windowTitle: () => windowTitle,
  setMaximized: (v) => {
    windowMaximized = v;
    return emit("tauri://resize", { width: 1280, height: 800 });
  },
  recCalls: () => recLog.map((c) => ({ ...c })),
  termWindowCalls: () => termWindowCalls.map((c) => ({ ...c })),
  termwinEvents: () => termwinLog.map((e) => ({ ...e })),
  transferSpecs: () => transferSpecs.map((t) => ({ ...t })),
  setDialogResult: (v) => {
    dialogResult = v;
  },
  setTransferStepMs: (ms) => {
    transferStepMs = ms;
  },
  monitorRunning: () => [...monitorTimers].map(([sessionId, v]) => ({ sessionId, intervalMs: v.intervalMs, threads: v.threads })),
  kills: () => [...killLog],
  reniceCalls: () => [...reniceLog],
  detailCalls: () => [...detailLog],
  cronWrites: () => [...cronWrites],
  cronText: () => cronText,
  setCron: (t: string) => {
    cronText = t;
  },
  duRequests: () => duRequests.map((r) => ({ ...r })),
  termWrites: () => termWriteLog.map((w) => ({ ...w })),
  /** Every term_resize the app sent (xterm fit), in order (§15.3.S). */
  termResizes: () => termResizeLog.map((r) => ({ ...r })),
  // §14.4.G1 fake git (tests/ui/mockGit.ts)
  g1GitCalls: () => g1GitCalls.map((c) => ({ ...c, args: [...c.args] })),
  g1GitSnapshot: (root) => g1Snapshot(root),
  g1GitMissing: (missing) => g1SetGitMissing(missing),
  g1GitPatch: (root, patch) => g1Patch(root, patch),
  // §15.3.D fake docker (tests/ui/mockDocker.ts)
  dockerCalls: () => dockerFake.calls.map((c) => ({ ...c, args: [...c.args] })),
  dockerFakeSet: (patch: Record<string, unknown>) => Object.assign(dockerFake, patch),
  dockerLogStreams: () => dockerFake.logStreams.map((s) => ({ ...s })),
  dockerStreams: () => ({ stats: dockerFake.statsRunning, events: dockerFake.eventsRunning }),
  dockerEmitEvent: (type: string, action: string, name: string, id: string) => dockerEmitEvent(type, action, name, id),
  dockerPushLog: (target: string, text: string) => dockerPushLog(target, text),
  dockerReset: () => resetDocker(),
  dockerState: () => dockerFake.containers.map((c) => ({ name: c.name, state: c.state })),
  // §14.4.G2 fake git (tests/ui/fakeGitG2.ts)
  gitCalls: () => gitFake.calls.map((c) => [...c.args]),
  gitFakeSet: (patch: { active?: boolean; mode?: "small" | "big"; dirty?: string[]; failNext?: string | null }) => Object.assign(gitFake, patch),
  deleteFile: (path) => {
    delete fileContents[path];
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    if (tree[dir]) tree[dir] = tree[dir].filter((e) => e.path !== path);
  },
};
