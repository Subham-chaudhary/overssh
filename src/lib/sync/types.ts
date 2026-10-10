// Settings sync: shared types (docs/GUIDE.md §15.3.Y). Pure: no runes, no I/O,
// so everything under lib/sync that is not `*.svelte.ts` runs in the unit tests.
import type { ForwardRule, HistoryEntry, LogSourceSpec, Profile, Snippet } from "../types";
import type { WorkspaceProfile } from "../profiles/types";

export const BUNDLE_FORMAT = "overssh-settings";
export const BUNDLE_VERSION = 1;
/** Hard limit for a bundle read from a file / the clipboard. */
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

export type SectionId =
  | "settings"
  | "appearance"
  | "hosts"
  | "snippets"
  | "forwards"
  | "workspaceProfiles"
  | "logs"
  | "prefs"
  | "history";

export const SECTION_IDS: readonly SectionId[] = [
  "settings",
  "appearance",
  "hosts",
  "snippets",
  "forwards",
  "workspaceProfiles",
  "logs",
  "prefs",
  "history",
];

export interface SectionMeta {
  id: SectionId;
  label: string;
  description: string;
  /** Pre-checked in the export dialog. */
  defaultOn: boolean;
  /** Shown in the dialogs next to the checkbox. */
  warning?: string;
}

export const SECTION_META: Record<SectionId, SectionMeta> = {
  settings: {
    id: "settings",
    label: "Settings",
    description: "Editor, files, terminal, connection, Git and Docker settings.",
    defaultOn: true,
  },
  appearance: {
    id: "appearance",
    label: "Appearance",
    description: "Color theme, accent, density, corner radius and motion.",
    defaultOn: true,
  },
  hosts: {
    id: "hosts",
    label: "Saved hosts",
    description: "Host profiles saved in the app (host, user, port, identity file path, proxy jump). No passwords or keys.",
    defaultOn: true,
  },
  snippets: {
    id: "snippets",
    label: "Snippets",
    description: "Command snippets. Remembered variable values are not exported.",
    defaultOn: true,
  },
  forwards: {
    id: "forwards",
    label: "Port-forward rules",
    description: "Saved tunnels (local, remote, dynamic).",
    defaultOn: true,
  },
  workspaceProfiles: {
    id: "workspaceProfiles",
    label: "Workspace profiles",
    description: "Saved workspaces (hosts, explorer folders, open files, terminals, tunnels to start). References only: no passwords, keys or file contents.",
    defaultOn: true,
  },
  logs: {
    id: "logs",
    label: "Saved log sources",
    description: "Saved log sources and log buffer preferences. Sudo passwords are never saved.",
    defaultOn: true,
  },
  prefs: {
    id: "prefs",
    label: "Dashboard preferences",
    description: "htop tab columns, sort order and toggles.",
    defaultOn: true,
  },
  history: {
    id: "history",
    label: "Command history",
    description: "Commands you typed in terminals, per host.",
    defaultOn: false,
    warning: "Command history may contain secrets (tokens or passwords typed on a command line). Off by default.",
  },
};

/** Settings tree minus `theme` and `appearance` (they have their own section). */
export type SettingsPatch = Record<string, unknown>;

export interface AppearanceSection {
  theme?: string;
  appearance?: Record<string, unknown>;
}

export interface PrefsSection {
  htop?: {
    columns?: string[];
    sortKey?: string;
    desc?: boolean;
    tree?: boolean;
    hideKernel?: boolean;
    threads?: boolean;
    meters?: boolean;
  };
}

export interface SyncLogSource {
  id: string;
  host: string;
  name: string;
  source: Omit<LogSourceSpec, "password">;
}

export interface LogsSection {
  saved: SyncLogSource[];
  prefs: { maxLines?: number; tailLines?: number };
}

export interface SyncSections {
  settings?: SettingsPatch;
  appearance?: AppearanceSection;
  hosts?: Profile[];
  snippets?: Snippet[];
  forwards?: ForwardRule[];
  workspaceProfiles?: WorkspaceProfile[];
  logs?: LogsSection;
  prefs?: PrefsSection;
  history?: HistoryEntry[];
}

export interface SyncBundle {
  format: typeof BUNDLE_FORMAT;
  version: number;
  /** ISO 8601. */
  exportedAt: string;
  /** App version that produced the file (informational). */
  app: string;
  sections: SyncSections;
}

/** What the sanitizers need to know about the running app. */
export interface SyncContext {
  /** The app's `DEFAULTS` (a `Settings`): the schema for the settings tree. */
  defaults: Record<string, unknown>;
  themeIds: readonly string[];
  /** Valid htop column keys (`COLUMNS`). */
  htopColumns?: readonly string[];
}

export type Resolution = "skip" | "overwrite" | "keepBoth";

export type ConflictSection = "hosts" | "snippets" | "forwards" | "workspaceProfiles" | "logs";

export interface Conflict {
  /** `<section>:<incoming id>`; key of the decision map. */
  key: string;
  section: ConflictSection;
  reason: "id" | "name" | "tunnel";
  incoming: string;
  existing: string;
}

export interface LeafDiff {
  path: string;
  from: unknown;
  to: unknown;
}

export interface SectionPreview {
  id: SectionId;
  label: string;
  /** Items (lists) or values (settings trees) in the file. */
  incoming: number;
  /** New items that will be added. */
  add: number;
  /** Identical to what is already here: nothing to do. */
  same: number;
  conflicts: number;
  /** Settings-like sections: values that will change. */
  changes: LeafDiff[];
  note?: string;
}

export interface ImportPlan {
  previews: SectionPreview[];
  conflicts: Conflict[];
}
