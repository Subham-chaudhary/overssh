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
}

// §5.3 events (backend -> frontend)

export interface TermDataEvent {
  termId: string;
  data: string;
}

export interface TermExitEvent {
  termId: string;
  code: number | null;
}

export interface SessionClosedEvent {
  sessionId: string;
  reason: string;
}
