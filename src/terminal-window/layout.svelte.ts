// Split-pane state of the detached terminal window (docs/GUIDE.md §15.3.S).
// Local to that window: the main window never sees it. Panes point at terminals by
// their stable tab key, so an auto-reconnect (new PTY id, same key) keeps the layout.

import { app } from "../lib/stores.svelte";
import { isAppError } from "../lib/api";
import { terminalStore, type TerminalTab } from "../lib/terminal.svelte";
import {
  MAX_PANES,
  computePlacement,
  findLeaf,
  leaves,
  neighbor,
  newLeaf,
  reconcile,
  removeLeaf,
  restore,
  serialize,
  setRatio,
  splitLeaf,
  type Direction,
  type LayoutState,
  type Node,
  type Placement,
  type SplitDir,
} from "./splitLayout";

const STORAGE_KEY = "overssh.termwin.layout.v1";

export const tabKey = (t: TerminalTab): string => t.key ?? t.id;

function readStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStorage(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // storage unavailable: the layout is simply not remembered
  }
}

class TermLayout {
  private first = newLeaf(null);
  root = $state<Node>(this.first);
  focusId = $state<string>(this.first.id);
  /** Size of the pane area in px (set by TerminalPanel). */
  width = $state(0);
  height = $state(0);
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  get leafCount(): number {
    return leaves(this.root).length;
  }

  get isSplit(): boolean {
    return this.leafCount > 1;
  }

  get placement(): Placement {
    return computePlacement(this.root, this.width, this.height);
  }

  get focusedKey(): string | null {
    return findLeaf(this.root, this.focusId)?.key ?? null;
  }

  private apply(state: LayoutState): void {
    this.root = state.root;
    this.focusId = state.focusId;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      writeStorage(serialize({ root: this.root, focusId: this.focusId }));
    }, 300);
  }

  /** Window start: adopt the remembered layout if enough of its terminals still exist. */
  restoreFromStorage(): void {
    const keys = terminalStore.tabs.map(tabKey);
    const st = restore(readStorage(), keys);
    if (st) this.apply(st);
  }

  /** Keeps panes and tabs in step (tab opened/closed/activated). */
  sync(): void {
    const keys = terminalStore.tabs.map(tabKey);
    const activeTab = terminalStore.activeTab;
    const r = reconcile({ root: this.root, focusId: this.focusId }, keys, activeTab ? tabKey(activeTab) : null);
    if (r.state.root !== this.root || r.state.focusId !== this.focusId) this.apply(r.state);
    if (r.activate) {
      const t = terminalStore.tabs.find((x) => tabKey(x) === r.activate);
      if (t) terminalStore.setActive(t.id);
    }
  }

  /** Gives a pane focus and makes its terminal the active one. */
  focus(leafId: string, focusTerminal = true): void {
    const leaf = findLeaf(this.root, leafId);
    if (!leaf) return;
    if (this.focusId !== leafId) {
      this.focusId = leafId;
      this.scheduleSave();
    }
    const tab = leaf.key ? terminalStore.tabs.find((t) => tabKey(t) === leaf.key) : undefined;
    if (tab) {
      if (terminalStore.activeId !== tab.id) terminalStore.setActive(tab.id);
      if (focusTerminal) terminalStore.focusActive();
    }
  }

  /** Alt+Arrow: moves focus to the neighbouring pane. Returns false when there is none. */
  focusDirection(dir: Direction): boolean {
    const p = this.placement;
    if (!p.fits) return false;
    const to = neighbor(p.panes, this.focusId, dir);
    if (!to) return false;
    this.focus(to);
    return true;
  }

  /** Focus the next/previous pane in tree order (wraps). */
  focusCycle(step: 1 | -1): void {
    const ls = leaves(this.root);
    const i = ls.findIndex((l) => l.id === this.focusId);
    if (ls.length < 2 || i < 0) return;
    this.focus(ls[(i + step + ls.length) % ls.length].id);
  }

  setRatio(splitId: string, ratio: number): void {
    this.root = setRatio(this.root, splitId, ratio);
    this.scheduleSave();
  }

  /** Splits the focused pane and opens a new terminal in the new pane. */
  async split(dir: SplitDir): Promise<boolean> {
    if (this.leafCount >= MAX_PANES) {
      app.addToast("info", `At most ${MAX_PANES} terminal panes`);
      return false;
    }
    const sid = terminalStore.defaultSessionId();
    if (!sid) {
      app.addToast("info", "Connect to a host in the main window first");
      return false;
    }
    const r = splitLeaf(this.root, this.focusId, dir);
    if (!r) return false;
    this.apply({ root: r.root, focusId: r.leafId });
    try {
      await terminalStore.openNew(sid, { cwd: terminalStore.cwdFor(sid) });
    } catch (err) {
      app.addToast("error", isAppError(err) ? err.message : String(err));
      this.dropEmptyPanes();
      return false;
    }
    return true;
  }

  /** Removes panes that never got a terminal (a failed split). */
  private dropEmptyPanes(): void {
    for (const l of leaves(this.root)) {
      if (l.key !== null || this.leafCount < 2) continue;
      const r = removeLeaf(this.root, l.id);
      if (!r) continue;
      this.apply({ root: r.root, focusId: this.focusId === l.id ? r.focus : this.focusId });
    }
  }

  /** Collapses every pane into one (terminals stay open as tabs). */
  unsplit(): void {
    const keep = findLeaf(this.root, this.focusId) ?? leaves(this.root)[0];
    const single = newLeaf(keep.key);
    this.apply({ root: single, focusId: single.id });
  }
}

export const termLayout = new TermLayout();
