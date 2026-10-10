// Workspace profiles (docs/GUIDE.md §15.3.P): a saved set of hosts, explorer roots,
// open files, terminals, tunnels and view state that can be reopened in one click.
// Plain data only: this file is imported by pure helpers that run under node tests.
//
// Never stored: passwords, passphrases, key material, file contents, unsaved edits.
// A host is a *reference* to a saved host or ~/.ssh/config alias; opening a profile
// goes through the normal connect flow, including its prompts.

/** How a host entry finds its host again. `key` is `HostItem.key` ("saved:<id>" /
 * "config:<alias>"), or null for a quick-connect session that had no saved host. The
 * other fields are a non-secret snapshot used to match a host whose id changed (and to
 * connect when `key` is null) and to label the entry when the host is gone. */
export interface HostRef {
  key: string | null;
  name: string;
  alias: string | null;
  hostname: string;
  user: string;
  port: number;
  identityFile: string | null;
  proxyJump: string | null;
}

export interface PaneSpec {
  cwd: string;
  /** Expanded folders (absolute posix paths), shallowest first. */
  expanded: string[];
}

export interface ExplorerSpec {
  /** One or two panes (Explorer split, §15.3.S). */
  panes: PaneSpec[];
  activePane: number;
  splitRatio: number;
}

export interface FileSpec {
  path: string;
  line: number;
  col: number;
}

export interface TerminalSpec {
  /** Custom title, or null for the default "Terminal N". */
  title: string | null;
  /** Start folder, or null for the shell's default. */
  cwd: string | null;
  /** Typed once the shell is ready. Never captured: set by hand in the manage dialog. */
  command: string | null;
}

/** A port-forward rule to start. `ruleId` is the live rule id; the rest lets a rule be
 * found again by shape if its id changed (settings sync merge) and names it in reports. */
export interface ForwardRef {
  ruleId: string;
  label: string;
  kind: "L" | "R" | "D";
  bindPort: number;
  targetHost: string;
  targetPort: number;
}

export interface HostEntry {
  /** Stable id inside the profile (UI keys, terminal layout leaves). */
  id: string;
  ref: HostRef;
  /** True when the host had no workspace, only running tunnels: restore only starts the rules. */
  tunnelOnly: boolean;
  explorer: ExplorerSpec | null;
  files: FileSpec[];
  /** Path of the active editor tab, or null. */
  activeFile: string | null;
  terminals: TerminalSpec[];
  /** Index into `terminals` of the active one, or null. */
  activeTerminal: number | null;
  forwards: ForwardRef[];
}

/** Detached terminal window layout: the split tree of §15.3.S with leaves pointing at
 * terminals of this profile (host entry id + index) instead of live terminal keys. */
export type LayoutSpec =
  | { type: "leaf"; entry: string | null; term: number | null }
  | { type: "split"; dir: "row" | "col"; ratio: number; a: LayoutSpec; b: LayoutSpec };

export interface TerminalsSpec {
  /** The terminal panel was in its own window. */
  detached: boolean;
  /** Split layout of that window (only meaningful when `detached`). */
  layout: LayoutSpec | null;
  /** Which pane had focus: a leaf path of the layout, as {entry, term}. */
  focus: { entry: string; term: number } | null;
}

export interface ViewSpec {
  /** Sidebar view that was showing (null = sidebar hidden). */
  sidebar: string | null;
  /** Dashboard section that was selected. */
  dashboardTab: string | null;
  /** Terminal panel was visible (docked mode). */
  showTerminal: boolean;
}

export interface WorkspaceProfile {
  id: string;
  name: string;
  /** Key of `PROFILE_ICONS`, or null. */
  icon: string | null;
  /** `#rrggbb`, or null. */
  color: string | null;
  hosts: HostEntry[];
  /** Entry id whose workspace is shown when the profile finished opening. */
  activeHost: string | null;
  view: ViewSpec;
  terminals: TerminalsSpec;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
}

export type OpenMode = "sequential" | "parallel";

export interface ProfileOptions {
  /** `sequential`: finish one host before connecting the next. `parallel`: connections
   * still go one at a time (one prompt slot), but each host's restore overlaps the next
   * host's connect. */
  mode: OpenMode;
  /** Disconnect workspaces that are not part of the profile before opening it. */
  closeOthers: boolean;
}

/** On-disk shape of the "workspaces" store. */
export interface ProfilesFile {
  version: 1;
  profiles: WorkspaceProfile[];
  /** Profile to open at launch, or null. */
  startupId: string | null;
  options: ProfileOptions;
}

export const DEFAULT_OPTIONS: ProfileOptions = { mode: "sequential", closeOthers: false };

/** Limits that keep a hand-edited or imported file from exploding the UI. */
export const LIMITS = {
  profiles: 100,
  hosts: 20,
  files: 100,
  terminals: 20,
  expanded: 300,
  forwards: 50,
  name: 80,
  path: 4096,
  command: 2000,
} as const;
