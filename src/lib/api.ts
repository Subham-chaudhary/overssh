// The ONLY module that talks to @tauri-apps/api. Every backend call and every
// backend event is wrapped here with a typed signature, per docs/GUIDE.md §5.
// Components must import from here, never from '@tauri-apps/api/*' directly.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import type {
  AppError,
  ConnectRequest,
  ErrorKind,
  FileContent,
  FileEntry,
  ForwardInfo,
  ForwardSpec,
  ForwardStateEvent,
  HostEntry,
  RecInfo,
  SessionClosedEvent,
  SessionInfo,
  TermDataEvent,
  TermExitEvent,
} from "./types";

const KNOWN_KINDS: ReadonlySet<string> = new Set<ErrorKind>([
  "NeedPassword",
  "NeedPassphrase",
  "HostKeyUnknown",
  "HostKeyChanged",
  "AuthFailed",
  "Connection",
  "NotFound",
  "PermissionDenied",
  "Conflict",
  "TooLarge",
  "Config",
  "Io",
  "Other",
]);

/** Type guard for the normalized error shape thrown by every function in this module. */
export function isAppError(err: unknown): err is AppError {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    typeof (err as { kind: unknown }).kind === "string" &&
    KNOWN_KINDS.has((err as { kind: string }).kind) &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  );
}

/** Normalize whatever Tauri's `invoke` rejected with into an `AppError`. */
function normalizeError(err: unknown): AppError {
  if (isAppError(err)) return err;
  if (typeof err === "string") return { kind: "Other", message: err };
  if (err instanceof Error) return { kind: "Other", message: err.message };
  return { kind: "Other", message: String(err) };
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw normalizeError(err);
  }
}

// --- Commands (§5.2) --------------------------------------------------

export function listHosts(): Promise<HostEntry[]> {
  return call<HostEntry[]>("list_hosts");
}

export function connect(req: ConnectRequest): Promise<SessionInfo> {
  return call<SessionInfo>("connect", { req });
}

export function disconnect(sessionId: string): Promise<void> {
  return call<void>("disconnect", { sessionId });
}

/** Liveness probe (§13.4.A): resolves if the server answers, rejects if the link is dead. */
export function sessionPing(sessionId: string): Promise<void> {
  return call<void>("session_ping", { sessionId });
}

export function listDir(sessionId: string, path: string): Promise<FileEntry[]> {
  return call<FileEntry[]>("list_dir", { sessionId, path });
}

export function stat(sessionId: string, path: string): Promise<FileEntry> {
  return call<FileEntry>("stat", { sessionId, path });
}

export function readFile(sessionId: string, path: string): Promise<FileContent> {
  return call<FileContent>("read_file", { sessionId, path });
}

export function writeFile(
  sessionId: string,
  path: string,
  content: string,
  expectedMtime?: number,
): Promise<number> {
  return call<number>("write_file", { sessionId, path, content, expectedMtime });
}

export function createFile(sessionId: string, path: string): Promise<void> {
  return call<void>("create_file", { sessionId, path });
}

/** Save-as-root (GUIDE §3 item 8): uploads `content` to a remote temp file
 * over SFTP, then moves it into place as root on a separate exec channel.
 * Returns the target's fresh mtime. Never called with a logged password. */
export function writeFileSudo(
  sessionId: string,
  path: string,
  content: string,
  password?: string,
): Promise<number> {
  return call<number>("write_file_sudo", { sessionId, path, content, password });
}

export function createDir(sessionId: string, path: string): Promise<void> {
  return call<void>("create_dir", { sessionId, path });
}

export function rename(sessionId: string, from: string, to: string): Promise<void> {
  return call<void>("rename", { sessionId, from, to });
}

/** Recursive copy (server-side `cp -a`, SFTP fallback). Fails with `Conflict` if `to` exists. */
export function copyPath(sessionId: string, from: string, to: string): Promise<void> {
  return call<void>("copy_path", { sessionId, from, to });
}

export function remove(sessionId: string, path: string, recursive: boolean): Promise<void> {
  return call<void>("remove", { sessionId, path, recursive });
}

export function download(
  sessionId: string,
  remotePath: string,
  localPath: string,
): Promise<void> {
  return call<void>("download", { sessionId, remotePath, localPath });
}

export function upload(
  sessionId: string,
  localPath: string,
  remoteDir: string,
): Promise<string> {
  return call<string>("upload", { sessionId, localPath, remoteDir });
}

export function termOpen(
  sessionId: string,
  cols: number,
  rows: number,
  cwd?: string,
): Promise<string> {
  return call<string>("term_open", { sessionId, cols, rows, cwd });
}

export function termWrite(termId: string, data: string): Promise<void> {
  return call<void>("term_write", { termId, data });
}

/** Last size sent per terminal; auto-reconnect (§13.4.A) re-applies it to the replacement PTY. */
export const lastTermSize = new Map<string, { cols: number; rows: number }>();

export function termResize(termId: string, cols: number, rows: number): Promise<void> {
  lastTermSize.set(termId, { cols, rows });
  return call<void>("term_resize", { termId, cols, rows });
}

export function termClose(termId: string): Promise<void> {
  return call<void>("term_close", { termId });
}

// --- Detachable terminal window (§14.4.W) ---------------------------------

/** Recent output of a terminal; chunks with `seq` <= `seq` are already in `data`. */
export function termSnapshot(termId: string): Promise<{ data: string; seq: number }> {
  return call<{ data: string; seq: number }>("term_snapshot", { termId });
}

export interface WinGeometry {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export function termWindowOpen(geometry: WinGeometry | null): Promise<void> {
  return call<void>("term_window_open", { geometry });
}

export function termWindowFocus(): Promise<void> {
  return call<void>("term_window_focus");
}

export function termWindowClose(): Promise<void> {
  return call<void>("term_window_close");
}

/** Window-to-window messages (`termwin://*`, §14.4.W). */
export function emitEvent(name: string, payload?: unknown): Promise<void> {
  return emit(name, payload);
}

export function listenEvent<T>(name: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(name, (e) => handler(e.payload));
}

// --- Port forwarding (§13.4.P) ------------------------------------------

export function forwardStart(sessionId: string, spec: ForwardSpec): Promise<ForwardInfo> {
  return call<ForwardInfo>("forward_start", { sessionId, spec });
}

export function forwardStop(forwardId: string): Promise<void> {
  return call<void>("forward_stop", { forwardId });
}

export function forwardList(): Promise<ForwardInfo[]> {
  return call<ForwardInfo[]>("forward_list");
}

export function forwardSetCloseToTray(enabled: boolean): Promise<void> {
  return call<void>("forward_set_close_to_tray", { enabled });
}

export function onForwardState(handler: (payload: ForwardStateEvent) => void): Promise<UnlistenFn> {
  return listen<ForwardStateEvent>("forward://state", (e) => handler(e.payload));
}

// --- Persistence (§11.1) -------------------------------------------------

export type StoreName = "settings" | "profiles" | "history" | "paused" | "forwards" | "logs";

/** Reads `<app_data_dir>/<name>.json`. `null` if missing or corrupt. */
export function loadStore<T>(name: StoreName): Promise<T | null> {
  return call<T | null>("load_store", { name });
}

export function saveStore(name: StoreName, value: unknown): Promise<void> {
  return call<void>("save_store", { name, value });
}

// --- Terminal recording (§13.4.T2) ---------------------------------------

export function recStart(termId: string, dir?: string | null): Promise<string> {
  // The offset lets Rust name files in local time.
  return call<string>("rec_start", {
    termId,
    dir: dir ?? undefined,
    tzOffsetMinutes: -new Date().getTimezoneOffset(),
  });
}

export function recStop(termId: string): Promise<void> {
  return call<void>("rec_stop", { termId });
}

export function recList(dir?: string | null): Promise<RecInfo[]> {
  return call<RecInfo[]>("rec_list", { dir: dir ?? undefined });
}

export function recDelete(path: string): Promise<void> {
  return call<void>("rec_delete", { path });
}

export function recRead(path: string): Promise<string> {
  return call<string>("rec_read", { path });
}

export function recReveal(path: string): Promise<void> {
  return call<void>("rec_reveal", { path });
}

export function recDefaultDir(): Promise<string> {
  return call<string>("rec_default_dir");
}

/** Backend stopped a recording on its own (e.g. disk write error). */
export function onRecStopped(
  handler: (payload: { termId: string; reason: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ termId: string; reason: string }>("rec://stopped", (e) => handler(e.payload));
}

// --- Drag-and-drop (Tauri v2 webview) --------------------------------------

export type { DragDropEvent };

/** Native OS file/folder drag-and-drop over the app's webview (task T5). The
 * one exception to "components never import @tauri-apps/api": wrapped here
 * instead so `Explorer.svelte` still only reaches into `lib/api.ts`. */
export function onDragDrop(handler: (event: DragDropEvent) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((e) => handler(e.payload));
}

// --- Events (§5.3) ------------------------------------------------------

export function onTermData(handler: (payload: TermDataEvent) => void): Promise<UnlistenFn> {
  return listen<TermDataEvent>("term://data", (e) => handler(e.payload));
}

export function onTermExit(handler: (payload: TermExitEvent) => void): Promise<UnlistenFn> {
  return listen<TermExitEvent>("term://exit", (e) => handler(e.payload));
}

export function onSessionClosed(
  handler: (payload: SessionClosedEvent) => void,
): Promise<UnlistenFn> {
  return listen<SessionClosedEvent>("session://closed", (e) => handler(e.payload));
}

// --- Logs (§13.4.L) ---------------------------------------------------------

import type { LogDataEvent, LogDiscovery, LogEndEvent, LogSourceSpec } from "./types";

export function logsOpen(sessionId: string, source: LogSourceSpec): Promise<string> {
  return call<string>("logs_open", { sessionId, source });
}

export function logsClose(streamId: string): Promise<void> {
  return call<void>("logs_close", { streamId });
}

export function logsDiscover(sessionId: string): Promise<LogDiscovery> {
  return call<LogDiscovery>("logs_discover", { sessionId });
}

/** Writes `lines` (joined by \n) to a local file chosen with the save dialog. */
export function logsExport(path: string, lines: string[]): Promise<void> {
  return call<void>("logs_export", { path, lines });
}

export function onLogData(handler: (payload: LogDataEvent) => void): Promise<UnlistenFn> {
  return listen<LogDataEvent>("logs://data", (e) => handler(e.payload));
}

export function onLogEnd(handler: (payload: LogEndEvent) => void): Promise<UnlistenFn> {
  return listen<LogEndEvent>("logs://end", (e) => handler(e.payload));
}

// --- Dashboard (§13.4.M) ------------------------------------------------

export function monitorStart(sessionId: string, intervalMs: number, threads = false): Promise<void> {
  return call<void>("monitor_start", { sessionId, intervalMs, threads });
}

export function procKillMany(sessionId: string, pids: number[], signal: string): Promise<void> {
  return call<void>("proc_kill_many", { sessionId, pids, signal });
}

export function procDetails(sessionId: string, pid: number): Promise<import("./types").ProcDetails> {
  return call<import("./types").ProcDetails>("proc_details", { sessionId, pid });
}

export function monitorStop(sessionId: string): Promise<void> {
  return call<void>("monitor_stop", { sessionId });
}

export function procKill(sessionId: string, pid: number, signal: string): Promise<void> {
  return call<void>("proc_kill", { sessionId, pid, signal });
}

export function procRenice(sessionId: string, pid: number, nice: number): Promise<void> {
  return call<void>("proc_renice", { sessionId, pid, nice });
}

export function onMonitorSnapshot(
  handler: (payload: import("./types").MonitorSnapshotEvent) => void,
): Promise<UnlistenFn> {
  return listen<import("./types").MonitorSnapshotEvent>("monitor://snapshot", (e) => handler(e.payload));
}

export function onMonitorClosed(
  handler: (payload: import("./types").MonitorClosedEvent) => void,
): Promise<UnlistenFn> {
  return listen<import("./types").MonitorClosedEvent>("monitor://closed", (e) => handler(e.payload));
}

// --- Search (§13.4.R) -------------------------------------------------------

export function searchStart(sessionId: string, req: import("./types").SearchRequest): Promise<string> {
  return call<string>("search_start", { sessionId, req });
}

export function searchCancel(searchId: string): Promise<void> {
  return call<void>("search_cancel", { searchId });
}

export function onSearchMatches(
  handler: (payload: import("./types").SearchMatchesEvent) => void,
): Promise<UnlistenFn> {
  return listen<import("./types").SearchMatchesEvent>("search://matches", (e) => handler(e.payload));
}

export function onSearchDone(
  handler: (payload: import("./types").SearchDoneEvent) => void,
): Promise<UnlistenFn> {
  return listen<import("./types").SearchDoneEvent>("search://done", (e) => handler(e.payload));
}

// --- Git (§14) ------------------------------------------------------------------

export interface GitOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** Runs `git -C <repo> <args…>` on the VM. Never throws for a non-zero exit;
 * check `code`. `repo` "" omits `-C`. */
export function gitRun(sessionId: string, repo: string, args: string[], stdin?: string): Promise<GitOutput> {
  return call<GitOutput>("git_run", { sessionId, repo, args, stdin: stdin ?? null });
}

// --- Cron & disk usage (§13.4.C) ----------------------------------------------

export function cronRead(sessionId: string): Promise<string> {
  return call<string>("cron_read", { sessionId });
}

export function cronWrite(sessionId: string, text: string): Promise<void> {
  return call<void>("cron_write", { sessionId, text });
}

export function duStart(sessionId: string, path: string, depth: number): Promise<string> {
  return call<string>("du_start", { sessionId, path, depth });
}

export function duCancel(duId: string): Promise<void> {
  return call<void>("du_cancel", { duId });
}

export function onDuEntries(
  handler: (payload: import("./types").DuEntriesEvent) => void,
): Promise<UnlistenFn> {
  return listen<import("./types").DuEntriesEvent>("du://entries", (e) => handler(e.payload));
}

export function onDuDone(handler: (payload: import("./types").DuDoneEvent) => void): Promise<UnlistenFn> {
  return listen<import("./types").DuDoneEvent>("du://done", (e) => handler(e.payload));
}

// --- Transfers (§13.4.S) -------------------------------------------------------

import type {
  TransferConflictEvent,
  TransferDoneEvent,
  TransferProgressEvent,
  TransferSpec,
} from "./types";

export function transferStart(spec: TransferSpec): Promise<string> {
  return call<string>("transfer_start", { spec });
}

export function transferCancel(jobId: string): Promise<void> {
  return call<void>("transfer_cancel", { jobId });
}

/** Answer to a `transfer://conflict` prompt. */
export function transferResolve(
  jobId: string,
  policy: "overwrite" | "skip" | "newer" | "cancel",
): Promise<void> {
  return call<void>("transfer_resolve", { jobId, policy });
}

export function onTransferProgress(handler: (p: TransferProgressEvent) => void): Promise<UnlistenFn> {
  return listen<TransferProgressEvent>("transfer://progress", (e) => handler(e.payload));
}

export function onTransferDone(handler: (p: TransferDoneEvent) => void): Promise<UnlistenFn> {
  return listen<TransferDoneEvent>("transfer://done", (e) => handler(e.payload));
}

export function onTransferConflict(handler: (p: TransferConflictEvent) => void): Promise<UnlistenFn> {
  return listen<TransferConflictEvent>("transfer://conflict", (e) => handler(e.payload));
}

/** Properties dialog data (§14.4.X): SFTP lstat/readlink + best-effort exec stat. */
export function fileInfo(sessionId: string, path: string): Promise<import("./types").FileInfo> {
  return call<import("./types").FileInfo>("file_info", { sessionId, path });
}

/** On-demand folder size and file/folder counts (du/find over exec). */
export function dirSize(sessionId: string, path: string): Promise<import("./types").DirSize> {
  return call<import("./types").DirSize>("dir_size", { sessionId, path });
}
