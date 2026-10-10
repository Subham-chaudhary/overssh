// Menu bar model (docs/GUIDE.md §15.3.T). Items point at commands of the
// palette registry (`lib/commands.svelte.ts`) by id; an item whose command is
// not registered (yet) is hidden, so features that register late (Docker, Git,
// recordings...) appear on their own. A few items have no command and run a
// callback from the host component instead.
import type { Command } from "../../lib/commands.svelte";

export interface ItemDef {
  kind: "item";
  /** Label shown in the menu; may depend on which command was resolved. */
  label: string | ((cmd: Command | undefined) => string);
  /** Command ids, first registered one wins. Omit for a callback item. */
  ids?: string[];
  /** Callback item (no command), always visible. */
  run?: () => void;
  /** Hint shown when the command has no `keybinding` of its own. */
  hint?: string;
  testid?: string;
}
export interface SepDef {
  kind: "sep";
}
export type EntryDef = ItemDef | SepDef;
export interface MenuDef {
  id: string;
  label: string;
  entries: EntryDef[];
}

export interface ResolvedItem {
  kind: "item";
  key: string;
  label: string;
  hint: string;
  testid: string;
  run: () => void;
}
export type ResolvedEntry = ResolvedItem | SepDef;
export interface ResolvedMenu {
  id: string;
  label: string;
  entries: ResolvedEntry[];
}

export interface MenuActions {
  openPalette: () => void;
  openAbout: () => void;
  exit: () => void;
}

const item = (label: ItemDef["label"], ids: string[], hint?: string): ItemDef => ({ kind: "item", label, ids, hint });
const sep: SepDef = { kind: "sep" };

export function buildMenus(a: MenuActions): MenuDef[] {
  return [
    {
      id: "file",
      label: "File",
      entries: [
        item("New Connection...", ["connection.new"]),
        item("New File", ["explorer.newFile"]),
        item("New Folder", ["explorer.newFolder"]),
        sep,
        item("Save", ["file.save"]),
        item("Close Tab", ["file.closeTab"]),
        item("Reopen Closed Tab", ["file.reopenClosedTab"]),
        sep,
        item("Open Settings", ["preferences.openSettings"]),
        item("Disconnect", ["connection.disconnectCurrent"]),
        sep,
        { kind: "item", label: "Exit", run: a.exit, testid: "menu-exit" },
      ],
    },
    {
      id: "edit",
      label: "Edit",
      entries: [
        item("Find in Files", ["search.findInFiles"], "Ctrl+Shift+F"),
        item("Compare with Saved on Server", ["editor.compareWithServer"]),
        sep,
        item("Run Snippet...", ["snippets.run"]),
        item("New Snippet...", ["snippets.new"]),
        sep,
        item("Toggle Word Wrap", ["editor.toggleWordWrap"]),
        item("Toggle Minimap", ["editor.toggleMinimap"]),
        item("Toggle Auto Save", ["files.toggleAutoSave"]),
      ],
    },
    {
      id: "view",
      label: "View",
      entries: [
        { kind: "item", label: "Command Palette...", run: a.openPalette, hint: "Ctrl+Shift+P", testid: "menu-palette" },
        item("Color Theme...", ["preferences.colorTheme"]),
        sep,
        item("Toggle Sidebar", ["view.toggleSidebar"]),
        item("Toggle Terminal Panel", ["view.toggleTerminal"]),
        item("Toggle Terminal Position", ["terminal.togglePosition"]),
        item("Show Hidden Files", ["files.toggleHidden"]),
        sep,
        item("Refresh Explorer", ["explorer.refresh"]),
        item("Reset Theme Customization", ["preferences.resetAppearance"]),
      ],
    },
    {
      id: "go",
      label: "Go",
      entries: [
        item("Hosts", ["view.hosts"]),
        item("Explorer", ["view.explorer"]),
        item("Search", ["search.findInFiles"], "Ctrl+Shift+F"),
        item("Source Control", ["git.show"], "Ctrl+Shift+G"),
        item("Commands", ["view.commands"]),
        item("Dashboard", ["monitor.show"]),
        item("Logs", ["logs.show"]),
        item("Ports", ["ports.show"]),
        // Docker registers its own command (agent D); the first match wins.
        item("Docker", ["docker.show", "docker.open", "docker.view"]),
        sep,
        item("Process Manager (htop)", ["monitor.htop"]),
        item("Open Log File...", ["logs.openFile"]),
        item("Open System Journal", ["logs.journal"]),
        item("Forward a Port...", ["ports.add"]),
      ],
    },
    {
      id: "terminal",
      label: "Terminal",
      entries: [
        item("New Terminal", ["terminal.new"]),
        item("Reopen Closed Terminal", ["terminal.reopenClosed"]),
        sep,
        item((c) => (c?.id === "terminal.dock" ? "Dock Terminals" : "Detach Terminals"), ["terminal.dock", "terminal.detach"]),
        item("Move Panel to Bottom", ["terminal.moveToBottom"]),
        item("Move Panel to Right", ["terminal.moveToRight"]),
        sep,
        item("Start Recording", ["terminal.startRecording"]),
        item("Stop Recording", ["terminal.stopRecording"]),
        item("Show Recordings", ["terminal.showRecordings"]),
      ],
    },
    {
      id: "help",
      label: "Help",
      entries: [
        { kind: "item", label: "Command Palette...", run: a.openPalette, hint: "Ctrl+Shift+P", testid: "menu-help-palette" },
        sep,
        { kind: "item", label: "About OverSSH", run: a.openAbout, testid: "menu-about" },
      ],
    },
  ];
}

/** Resolves items against the live registry, drops missing commands and tidies separators. */
export function resolveMenus(defs: MenuDef[], registry: readonly Command[]): ResolvedMenu[] {
  const out: ResolvedMenu[] = [];
  for (const def of defs) {
    const entries: ResolvedEntry[] = [];
    for (const e of def.entries) {
      if (e.kind === "sep") {
        entries.push(e);
        continue;
      }
      let cmd: Command | undefined;
      if (e.ids) {
        for (const id of e.ids) {
          cmd = registry.find((c) => c.id === id);
          if (cmd) break;
        }
        if (!cmd) continue; // command not registered: hide the item
      }
      const run = e.run ?? (() => cmd?.run());
      entries.push({
        kind: "item",
        key: `${def.id}:${e.ids?.[0] ?? e.testid ?? (typeof e.label === "string" ? e.label : "item")}`,
        label: typeof e.label === "function" ? e.label(cmd) : e.label,
        hint: cmd?.keybinding ?? e.hint ?? "",
        testid: e.testid ?? `menu-item-${cmd?.id ?? "x"}`,
        run,
      });
    }
    // No leading / trailing / doubled separators.
    const clean: ResolvedEntry[] = [];
    for (const e of entries) {
      if (e.kind === "sep" && (clean.length === 0 || clean[clean.length - 1].kind === "sep")) continue;
      clean.push(e);
    }
    while (clean.length && clean[clean.length - 1].kind === "sep") clean.pop();
    if (clean.length) out.push({ id: def.id, label: def.label, entries: clean });
  }
  return out;
}
