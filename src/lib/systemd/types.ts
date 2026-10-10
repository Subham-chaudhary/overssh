// Types mirrored from src-tauri/src/systemd.rs (docs/GUIDE.md §15.3.V).

export interface SystemdProbe {
  available: boolean;
  uid: number;
  user: string;
  isRoot: boolean;
  sudo: boolean;
  version: string | null;
  pid1: string;
  userBus: boolean;
}

export interface SystemdUnit {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

export interface SystemdUnitFile {
  unit: string;
  state: string;
  preset: string | null;
}

export interface SystemdList {
  units: SystemdUnit[];
  unitFiles: SystemdUnitFile[];
  json: boolean;
}

export interface SystemdTimer {
  unit: string;
  activates: string;
  /** Unix microseconds, or null. */
  next: number | null;
  last: number | null;
  /** Raw time columns (plain fallback only). */
  text: string;
}

export interface SystemdProp {
  key: string;
  value: string;
}

export interface SystemdStat {
  unit: string;
  memory: number | null;
  cpuNs: number | null;
  tasks: number | null;
  mainPid: number;
}

export interface SystemdText {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type SystemdTextKind = "status" | "cat" | "deps" | "revdeps";

export type SystemdAction =
  | "start"
  | "stop"
  | "restart"
  | "reload"
  | "try-restart"
  | "reload-or-restart"
  | "enable"
  | "disable"
  | "mask"
  | "unmask"
  | "reset-failed"
  | "daemon-reload";

export type SystemdActionError = "sudoPassword" | "sudoMissing" | "sudoDenied" | "failed";

export interface SystemdActionResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error: SystemdActionError | null;
  /** Equivalent shell command (with sudo unless --user). */
  command: string;
}

/** One table row: a unit from `list-units` merged with its unit-file state and live stats. */
export interface SvcRow {
  unit: string;
  description: string;
  load: string;
  active: string;
  sub: string;
  /** Unit-file state (`enabled`, `disabled`, `static`, `masked`, …) or "". */
  enabled: string;
  preset: string | null;
  /** Not in `list-units`: only a unit file exists. */
  fileOnly: boolean;
  memory: number | null;
  cpuPct: number | null;
  tasks: number | null;
}
