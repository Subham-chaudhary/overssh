// Local UI state for the terminal panel (task T4). Kept separate from
// src/lib/stores.svelte.ts (owned by T3's explorer/editor work): this module
// only tracks which terminals are open and routes term:// events to the
// Terminal.svelte instance that owns each one.

import * as api from "./api";

export interface TerminalTab {
  id: string; // termId, from term_open
  sessionId: string;
  title: string;
  exited: boolean;
}

type DataHandler = (data: string) => void;
type ExitHandler = (code: number | null) => void;

class TerminalStore {
  tabs = $state<TerminalTab[]>([]);
  activeId = $state<string | null>(null);

  private dataHandlers = new Map<string, DataHandler>();
  private exitHandlers = new Map<string, ExitHandler>();
  private listenStarted: Promise<void> | null = null;

  get activeTab(): TerminalTab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  /**
   * Starts the single global `term://*` listener pair. Safe to call from
   * every Terminal.svelte/TerminalPanel.svelte mount — only the first call
   * actually subscribes.
   */
  ensureListening(): Promise<void> {
    if (!this.listenStarted) {
      this.listenStarted = Promise.all([
        api.onTermData((payload) => {
          this.dataHandlers.get(payload.termId)?.(payload.data);
        }),
        api.onTermExit((payload) => {
          const tab = this.tabs.find((t) => t.id === payload.termId);
          if (tab) tab.exited = true;
          this.exitHandlers.get(payload.termId)?.(payload.code);
        }),
      ]).then(() => undefined);
    }
    return this.listenStarted;
  }

  /** Registers the handler a Terminal.svelte instance uses to write incoming data. */
  onData(termId: string, handler: DataHandler): void {
    this.dataHandlers.set(termId, handler);
  }

  /** Registers the handler a Terminal.svelte instance uses to render "[process exited]". */
  onExit(termId: string, handler: ExitHandler): void {
    this.exitHandlers.set(termId, handler);
  }

  /** Called from Terminal.svelte's onDestroy. */
  offHandlers(termId: string): void {
    this.dataHandlers.delete(termId);
    this.exitHandlers.delete(termId);
  }

  async open(sessionId: string, title: string, cols: number, rows: number, cwd?: string): Promise<string> {
    const id = await api.termOpen(sessionId, cols, rows, cwd);
    this.tabs.push({ id, sessionId, title, exited: false });
    this.activeId = id;
    return id;
  }

  /** Closes a terminal: tells the backend, then drops its bookkeeping here. */
  async close(id: string): Promise<void> {
    try {
      await api.termClose(id);
    } catch {
      // Best-effort — the terminal's process may already have exited and the
      // backend entry cleaned itself up.
    } finally {
      this.forget(id);
    }
  }

  /** Drops a tab's bookkeeping without calling term_close (e.g. session already gone). */
  forget(id: string): void {
    this.offHandlers(id);
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    this.tabs.splice(idx, 1);
    if (this.activeId === id) {
      const neighbor = this.tabs[idx] ?? this.tabs[idx - 1];
      this.activeId = neighbor ? neighbor.id : null;
    }
  }

  setActive(id: string): void {
    if (this.tabs.some((t) => t.id === id)) this.activeId = id;
  }
}

export const terminalStore = new TerminalStore();
