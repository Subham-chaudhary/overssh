// The ONLY module that talks to @tauri-apps/api. Every backend call and every
// backend event is wrapped here with a typed signature, per docs/GUIDE.md §5.
// Components must import from here, never from '@tauri-apps/api/*' directly.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import type {
  AppError,
  ConnectRequest,
  ErrorKind,
  FileContent,
  FileEntry,
  HostEntry,
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

export function termResize(termId: string, cols: number, rows: number): Promise<void> {
  return call<void>("term_resize", { termId, cols, rows });
}

export function termClose(termId: string): Promise<void> {
  return call<void>("term_close", { termId });
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
