// Ctrl+Tab switcher state (docs/GUIDE.md §13.4.K). Driven by App.svelte's
// capture-phase key handlers; rendered by components/TabSwitcher.svelte.

import { app } from "./stores.svelte";
import { terminalStore } from "./terminal.svelte";
import { settings } from "./settings.svelte";
import { onActiveTabLeave } from "./autosave.svelte";
import { basename, dirname } from "./paths";

export interface SwitchItem {
  id: string;
  title: string;
  /** Dim secondary text: directory for files, session label for terminals. */
  detail: string;
  dirty: boolean;
}

/** Delay before the popup is drawn, so a quick Ctrl+Tab tap doesn't flicker. */
const SHOW_DELAY_MS = 120;

class TabSwitcher {
  /** A switch session is in progress (Ctrl held since the first Ctrl+Tab). */
  active = $state(false);
  /** The popup is drawn (after SHOW_DELAY_MS). */
  visible = $state(false);
  kind = $state<"file" | "terminal">("file");
  items = $state<SwitchItem[]>([]);
  index = $state(0);
  private timer: ReturnType<typeof setTimeout> | undefined;

  private build(kind: "file" | "terminal"): { items: SwitchItem[]; current: number } {
    if (kind === "terminal") {
      const mru = settings.editor.tabSwitchOrder === "mru";
      const tabs = mru ? terminalStore.mruTabs() : terminalStore.tabs;
      const items = tabs.map((t) => ({
        id: t.id,
        title: t.title,
        detail: terminalStore.sessionList.find((s) => s.id === t.sessionId)?.label ?? "",
        dirty: false,
      }));
      return { items, current: Math.max(0, tabs.findIndex((t) => t.id === terminalStore.activeId)) };
    }
    const ws = app.activeWorkspace;
    const sid = app.activeSessionId;
    if (!ws || !sid) return { items: [], current: 0 };
    const mru = settings.editor.tabSwitchOrder === "mru";
    const tabs = mru ? app.mruTabs(sid) : ws.tabs;
    const items = tabs.map((t) => ({
      id: t.id,
      title: basename(t.path),
      detail: dirname(t.path),
      dirty: t.doc !== t.savedDoc,
    }));
    return { items, current: Math.max(0, tabs.findIndex((t) => t.id === ws.activeTabId)) };
  }

  /** First Ctrl+Tab starts a session; further presses move the highlight.
   * Returns false if there was nothing to switch between. */
  step(dir: 1 | -1, kind: "file" | "terminal"): boolean {
    if (!this.active) {
      const { items, current } = this.build(kind);
      if (items.length < 2) return false;
      this.kind = kind;
      this.items = items;
      // MRU lists have the current item first; start on the previous one
      // (or the oldest when going backwards). Round robin steps from current.
      this.index = (current + dir + items.length) % items.length;
      this.active = true;
      this.visible = false;
      this.timer = setTimeout(() => {
        if (this.active) this.visible = true;
      }, SHOW_DELAY_MS);
      return true;
    }
    this.move(dir);
    return true;
  }

  move(dir: 1 | -1): void {
    const n = this.items.length;
    if (n === 0) return;
    this.index = (this.index + dir + n) % n;
  }

  select(index: number): void {
    this.index = index;
    this.commit();
  }

  private reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.active = false;
    this.visible = false;
    this.items = [];
    this.index = 0;
  }

  cancel(): void {
    this.reset();
  }

  commit(): void {
    if (!this.active) return;
    const item = this.items[this.index];
    const kind = this.kind;
    this.reset();
    if (!item) return;
    if (kind === "terminal") {
      terminalStore.setActive(item.id);
      terminalStore.focusActive();
    } else {
      const ws = app.activeWorkspace;
      if (!ws || item.id === ws.activeTabId) return;
      onActiveTabLeave(ws.activeTabId);
      app.setActiveTab(item.id);
    }
  }
}

export const tabSwitcher = new TabSwitcher();
