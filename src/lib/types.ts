// TS mirrors of docs/GUIDE.md §5.1. Keep in lockstep with the Rust side.

export interface HostEntry {
  // one concrete Host alias from ~/.ssh/config
  alias: string;
  hostname: string; // resolved HostName (or alias if none)
  user: string | null;
  port: number; // default 22
  identityFiles: string[]; // expanded (~ -> home), as written
  proxyJump: string | null;
}

export interface ConnectRequest {
  alias?: string; // either alias ...
  hostname?: string; // ... or explicit quick-connect fields
  user?: string;
  port?: number;
  identityFile?: string;
  password?: string; // filled after a NeedPassword error
  passphrase?: string; // filled after a NeedPassphrase error
  acceptHostKey?: boolean; // filled after a HostKeyUnknown error
  /** -J override ("a,b,user@c:2222"); "none" = direct; absent = use ssh config (§13.4.P). */
  proxyJump?: string;
  /** Secrets/approvals for ProxyJump hops, keyed by `AppError.hop` (§13.4.P). */
  jumpAuth?: Record<string, JumpHopAuth>;
}

export interface JumpHopAuth {
  password?: string;
  passphrase?: string;
  acceptHostKey?: boolean;
}

export interface SessionInfo {
  id: string; // uuid
  label: string; // alias or user@host
  user: string;
  hostname: string;
  home: string; // remote realpath(".")
}

export type FileKind = "file" | "dir" | "symlink" | "other";

export interface FileEntry {
  name: string;
  path: string; // absolute posix path
  kind: FileKind;
  size: number;
  mtime: number; // unix seconds
  permissions: number; // mode bits, e.g. 0o100644
  isHidden: boolean;
  linkTargetIsDir?: boolean; // for symlinks, resolved via stat
}

export interface FileContent {
  path: string;
  content: string; // utf-8 (lossy)
  mtime: number;
  size: number;
  isBinary: boolean;
}

export type ErrorKind =
  | "NeedPassword"
  | "NeedPassphrase"
  | "HostKeyUnknown"
  | "HostKeyChanged"
  | "AuthFailed"
  | "Connection"
  | "NotFound"
  | "PermissionDenied"
  | "Conflict"
  | "TooLarge"
  | "Config"
  | "Io"
  | "Other";

export interface AppError {
  kind: ErrorKind;
  message: string;
  fingerprint?: string;
  keyPath?: string;
  /** Set when a ProxyJump hop (`user@host:port`) raised this prompt-able error. */
  hop?: string;
}

// §11.2 schemas (Phase 3 — settings/profiles/history persistence)

import type { ThemeId } from "./themes";
export type { ThemeId } from "./themes";

export interface Settings {
  theme: ThemeId;
  /** Theme customization layered over `theme` (docs/GUIDE.md §14.4.Z). */
  appearance: {
    /** `#rrggbb` accent override; null = the theme's own accent. */
    accent: string | null;
    /** UI scale: compact 0.92x, normal 1x, comfortable 1.08x. */
    density: "compact" | "normal" | "comfortable"; // 'normal'
    /** Corner radius of buttons, inputs, popups. */
    radius: "sharp" | "default" | "round"; // 'default'
    /** Terminal cursor and selection follow the accent. */
    terminalAccent: boolean; // true
  };
  editor: {
    themeOverride: ThemeId | null;
    fontFamily: string; // default "Cascadia Code, Consolas, monospace"
    fontSize: number; // 13
    ligatures: boolean; // false
    minimap: boolean; // true
    wordWrap: boolean; // false
    stickyScroll: boolean; // true
    bracketPairColorization: boolean; // true
    renderWhitespace: "none" | "boundary" | "all"; // 'none'
    lineNumbers: boolean; // true
    tabSize: number; // 4
    insertSpaces: boolean; // true
    smoothScrolling: boolean; // true
    cursorBlinking: "blink" | "smooth" | "phase" | "expand" | "solid"; // 'smooth'
    /** Ctrl+Tab order: most-recently-used ("mru") or tab-strip order ("roundRobin"). */
    tabSwitchOrder: "mru" | "roundRobin"; // 'mru'
  };
  files: {
    autoSave: "off" | "afterDelay" | "onFocusChange" | "onWindowChange"; // 'off'
    autoSaveDelay: number; // 1000
    showHidden: boolean; // false
  };
  terminal: {
    fontSize: number; // 13
    cursorStyle: "block" | "bar" | "underline"; // 'bar'
    historyHints: boolean; // true
    position: "bottom" | "right"; // 'bottom' (docs/GUIDE.md §12.1)
    /** asciinema v2 session recording (§13.4.T2). */
    recording: {
      enabled: boolean; // false: no toggle is shown and nothing records
      autoRecordNew: boolean; // false: start recording every new terminal
      directory: string | null; // null = <app data dir>/recordings
    };
  };
  ports: {
    /** Closing the window hides to the tray while forwards run (§13.4.P). */
    closeToTray: boolean; // true
  };
  connection: {
    /** Reconnect automatically after a network drop / sleep (§13.4.A). */
    autoReconnect: boolean; // true
    /** On a drop, keep the workspace but do not retry: the user continues by hand (or see `resumeOnRestore`). */
    pauseOnDrop: boolean; // false
    /** With `pauseOnDrop`: continue automatically when the network comes back. */
    resumeOnRestore: boolean; // false
  };
  /** Source control (docs/GUIDE.md §14). */
  git: {
    enabled: boolean; // true: show the Source Control view and detect repos
    autoFetchMinutes: number; // 0 = off
    pruneOnFetch: boolean; // false
    confirmSync: boolean; // true: ask before push/pull/sync
    smartCommit: boolean; // true: commit all changes when nothing is staged (asks first)
    confirmDiscard: boolean; // true
    pullRebase: boolean; // false: `pull --rebase` when true
    graphMaxCommits: number; // 500
    graphAllBranches: boolean; // true: `--all` in the graph
    showRemoteBranches: boolean; // true
    diffSideBySide: boolean; // true: side-by-side diff, false = inline
    ignoreWhitespace: boolean; // false
    defaultBranchName: string; // "main" (git init)
  };
}

export interface Profile {
  id: string; // uuid
  name: string; // display name, default "user@hostname"
  alias: string | null; // ~/.ssh/config alias it came from, if any
  hostname: string;
  user: string;
  port: number;
  identityFile: string | null;
  proxyJump?: string | null; // -J chain (§13.4.P)
  pinned: boolean;
  lastUsed: number; // unix ms
}

export interface HistoryEntry {
  cmd: string;
  host: string; // "user@hostname"
  count: number;
  lastUsed: number; // unix ms
  pinned: boolean; // pinned = snippet
}

/** §13.4.N: a reusable command template (`{{variables}}`). Persisted in the
 * "history" store envelope next to the history entries. */
export interface Snippet {
  id: string;
  name?: string;
  cmd: string; // template
  description?: string;
  folder?: string;
  tags: string[];
  scope: "host" | "all";
  host?: string; // "user@hostname", set when scope === "host"
  created: number; // unix ms
  lastUsed: number; // unix ms, 0 = never
  useCount: number;
  lastValues?: Record<string, string>;
}

// §5.3 events (backend -> frontend)

export interface TermDataEvent {
  termId: string;
  data: string;
  /** Chunk number in the backend scrollback ring (§14.4.W); absent in old mocks. */
  seq?: number;
}

export interface TermExitEvent {
  termId: string;
  code: number | null;
}

export interface SessionClosedEvent {
  sessionId: string;
  reason: string;
}

// §13.4.L log reader

export type LogSourceKind = "file" | "journal" | "docker" | "command";

/** What to stream. `password` is only ever sent to the backend, never persisted. */
export interface LogSourceSpec {
  kind: LogSourceKind;
  path?: string;
  unit?: string;
  container?: string;
  command?: string;
  lines?: number;
  sudo?: boolean;
  password?: string;
}

export interface LogDataEvent {
  streamId: string;
  lines: string[];
}

export interface LogEndEvent {
  streamId: string;
  code: number | null;
  error?: string;
}

export interface LogDiscovery {
  files: string[];
  containers: string[];
  units: string[];
}

// §13.4.M Dashboard (monitor.rs) — mirrors the camelCase serde payloads.

export interface CpuUsage {
  user: number;
  nice: number;
  system: number;
  iowait: number;
  steal: number;
  total: number;
}

export interface MonMem {
  total: number;
  used: number;
  buffers: number;
  cache: number;
  available: number;
  swapTotal: number;
  swapUsed: number;
}

export interface MonProc {
  pid: number;
  ppid: number;
  user: string;
  pri: number;
  ni: number;
  virt: number;
  res: number;
  state: string;
  cpu: number;
  mem: number;
  time: number; // cpu seconds
  threads: number;
  command: string;
  args: string;
  kernel: boolean;
  /** Shared memory, bytes (0 when unavailable). */
  shr: number;
  /** Estimated start time, unix seconds (0 = unknown). */
  start: number;
  /** Owning pid; equals `pid` for processes, the process pid for thread rows. */
  tgid: number;
  /** Non-main thread row (only when threads are requested). */
  thread: boolean;
}

/** §14.4.H `proc_details`; -1 means unreadable (permission denied). */
export interface ProcDetails {
  pid: number;
  exists: boolean;
  cmdline: string;
  exe: string;
  cwd: string;
  envCount: number;
  fdCount: number;
  fds: string[];
  threads: number;
  ppid: number;
  uid: string;
  vmPeak: number;
  vmSwap: number;
  ctxVoluntary: number;
  ctxNonvoluntary: number;
  ioRead: number;
  ioWrite: number;
  children: number[];
}

export interface MonNetIf {
  name: string;
  rxBytes: number;
  txBytes: number;
  rxRate: number;
  txRate: number;
}

export interface MonDisk {
  filesystem: string;
  mount: string;
  total: number;
  used: number;
  avail: number;
  percent: number;
}

export interface MonitorSnapshot {
  ts: number;
  host: { hostname: string; kernel: string; os: string; arch: string; cores: number };
  cpu: CpuUsage;
  cores: CpuUsage[];
  load: [number, number, number];
  uptime: number;
  mem: MonMem;
  tasks: { total: number; running: number; threads: number };
  procs: MonProc[];
  net: MonNetIf[];
  disks: MonDisk[];
}

export interface MonitorSnapshotEvent {
  sessionId: string;
  snapshot: MonitorSnapshot;
}

export interface MonitorClosedEvent {
  sessionId: string;
  reason: string;
}

// §13.4.P port forwarding

export type ForwardKind = "L" | "R" | "D";

export interface ForwardSpec {
  kind: ForwardKind;
  bindAddress?: string;
  bindPort: number;
  targetHost: string; // "" for D
  targetPort: number; // 0 for D
  label?: string;
}

export interface ForwardInfo {
  id: string;
  sessionId: string;
  kind: ForwardKind;
  bindAddress: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
  label: string | null;
  state: "running";
  activeConnections: number;
  totalConnections: number;
  bytesIn: number;
  bytesOut: number;
  lastError: string | null;
}

export interface ForwardStateEvent {
  forwardId: string;
  sessionId: string;
  state: "stopped" | "error";
  message: string | null;
}

/** A persisted forward rule (the "forwards" store). */
export interface ForwardRule {
  id: string;
  /** `HostItem.key` (`"config:<alias>"` / `"saved:<id>"`). */
  host: string;
  kind: ForwardKind;
  bindAddress: string; // "" = default (127.0.0.1 for L, localhost for R)
  bindPort: number;
  targetHost: string;
  targetPort: number;
  label: string;
  autoStart: boolean;
  /** -N: when no workspace session exists, connect in the background just for this rule. */
  tunnelOnly: boolean;
}

// §13.4.R Remote search (search.rs)

export interface SearchRequest {
  root: string;
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Comma-separated globs. */
  include?: string;
  exclude?: string;
  hidden?: boolean;
  maxResults?: number;
  maxPerFile?: number;
}

export interface SearchMatch {
  /** Absolute POSIX path. */
  path: string;
  line: number;
  text: string;
}

export interface SearchMatchesEvent {
  searchId: string;
  matches: SearchMatch[];
}

export interface SearchDoneEvent {
  searchId: string;
  total: number;
  truncated: boolean;
  cancelled?: boolean;
  engine?: string | null;
  error?: string | null;
}

// --- Disk usage (§13.4.C) ------------------------------------------------------

export interface DuEntry {
  path: string;
  /** KiB (`du -k`). */
  kb: number;
}

export interface DuEntriesEvent {
  duId: string;
  entries: DuEntry[];
}

export interface DuDoneEvent {
  duId: string;
  cancelled: boolean;
  /** stderr lines containing "Permission denied". */
  denied: number;
  errors: number;
  errorSamples: string[];
  code: number | null;
}

/** One `.cast` file in the recordings directory (§13.4.T2). */
export interface RecInfo {
  path: string;
  name: string;
  host: string;
  startedAt: number; // unix seconds
  duration: number; // seconds
  size: number; // bytes
}

// --- Transfers (docs/GUIDE.md §13.4.S) ------------------------------------------

export type TransferKind = "upload" | "download" | "copy";
export type ConflictPolicy = "ask" | "overwrite" | "skip" | "newer";

export interface TransferSpec {
  kind: TransferKind;
  /** upload: destination session; download/copy: source session. */
  sessionId: string;
  /** copy only: destination session. */
  dstSessionId?: string;
  /** upload: local paths; download/copy: remote paths. */
  items: string[];
  /** upload/copy: remote dir; download: local dir. */
  dest: string;
  /** Name for a single root item at the destination. */
  rename?: string;
  conflict?: ConflictPolicy;
}

export interface TransferProgressEvent {
  jobId: string;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  currentPath: string;
  rateBps: number;
  etaSecs: number | null;
  scanning: boolean;
}

export interface TransferDoneEvent {
  jobId: string;
  error?: string;
  cancelled?: boolean;
  failed: number;
  skipped: number;
  filesDone: number;
  bytesDone: number;
}

export interface TransferConflictEvent {
  jobId: string;
  path: string;
}

// --- file properties (docs/GUIDE.md §14.4.X) -------------------------------------
export interface FileInfo {
  path: string;
  name: string;
  kind: FileKind;
  linkTarget: string | null;
  linkTargetKind: FileKind | null; // null for a dangling link
  size: number;
  mode: number | null; // raw mode bits, type bits included
  uid: number | null;
  gid: number | null;
  user: string | null;
  group: string | null;
  atime: number | null; // unix seconds
  mtime: number | null;
  ctime: number | null; // exec stat only
  btime: number | null; // birth time, when the filesystem has one
  hardLinks: number | null;
  mime: string | null;
  lines: number | null;
}

export interface DirSize {
  bytes: number;
  files: number;
  dirs: number;
  partial: boolean; // du reported errors: total is a lower bound
}
