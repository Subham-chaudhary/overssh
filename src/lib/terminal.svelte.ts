// Local UI state for the terminal panel (task T4/Phase4 T). Kept separate from
// src/lib/stores.svelte.ts (owned by other agents' explorer/editor work): this
// module only tracks which terminals are open and routes term:// events to the
// Terminal.svelte instance that owns each one.
//
// docs/GUIDE.md §12.1 contract: `openNew`/`focusActive`/`hasFocus` are the only
// public entry points other owners (App.svelte's `!` palette mode, the command
// palette, etc.) should call — every "open a terminal" path in this codebase
// (the panel's "+" button, CommandHistory's Run/Insert) is routed through
// `openNew` too, so there's exactly one place that shows the panel, creates a
// tab, waits for the Terminal component to mount, focuses it, and (if asked)
// feeds it a command once the shell is ready.

import { untrack } from "svelte";
import * as api from "./api";
import { lastTermSize } from "./api";
import { app } from "./stores.svelte";
import { isReconnecting } from "./reconnect.svelte";
import { settings } from "./settings.svelte";
import { registerCommand, unregisterCommand } from "./commands.svelte";
import type { AppError } from "./types";

export interface TerminalTab {
  id: string; // termId, from term_open
  sessionId: string;
  title: string;
  exited: boolean;
  /** Exit code from the last term://exit for this tab, once it has exited.
   * Only meaningful while the tab is still around to show it (see
   * `openedWithCommand` — a non-command terminal is removed immediately on
   * exit and never lingers with this set). */
  exitCode: number | null;
  /** True if this tab was opened via `openNew(..., { command })`. Drives the
   * §12 item 2 exception: a command-terminal that exits non-zero stays open
   * ("[exited with code N] — press any key to close") instead of
   * auto-closing. */
  openedWithCommand: boolean;
  /** Directory the terminal was opened in, if known (for reopen). */
  cwd?: string;
  /** True once the user renamed/titled it explicitly (kept for reopen). */
  customTitle?: boolean;
  /** Stable identity for keyed rendering: `id` changes when the tab is rebound
   * to a new PTY after an auto-reconnect (§13.4.A); `key` never does. */
  key?: string;
  /** True while the backend is recording this terminal (§13.4.T2). */
  recording: boolean;
  /** Path of the running (or last) recording file. */
  recPath?: string;
}

type DataHandler = (data: string, seq?: number) => void;

/** What the terminal window needs to know about the main window's sessions
 * (§14.4.W). Only the terminal window holds one (`terminalStore.remote`). */
export interface TermContext {
  sessions: { id: string; label: string; user: string; hostname: string }[];
  activeSessionId: string | null;
  /** Explorer directory per session id (start directory of new terminals). */
  cwds: Record<string, string>;
  /** Sessions the main window is auto-reconnecting right now. */
  reconnecting: string[];
}

/** Tab state handed between windows (§14.4.W). */
export interface TabState {
  tabs: TerminalTab[];
  activeId: string | null;
  mru?: string[];
  closedStack?: { sessionId: string; cwd?: string; title: string }[];
}

/** Set by src/terminal-window/bridge.svelte.ts so the store can route work to
 * the terminal window while the main window's panel is detached. */
export interface DetachHooks {
  detach(): Promise<void>;
  dock(): Promise<void>;
  open(sessionId: string, opts: { cwd?: string; command?: string; title?: string }): Promise<string>;
  reopen(): void;
  activate(id: string): void;
  remap(oldId: string, newId: string): void;
  /** The session is gone for good (disconnect, reconnect cancelled). */
  lost(sessionId: string): void;
  focusWindow(): void;
  /** Splits the detached window's terminal area (§15.3.S). */
  split(dir: "row" | "col"): void;
}
type ExitHandler = (code: number | null, keepOpen: boolean) => void;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MOUNT_TIMEOUT_MS = 2000;
const FIRST_DATA_TIMEOUT_MS = 1500;

class TerminalStore {
  tabs = $state<TerminalTab[]>([]);
  activeId = $state<string | null>(null);
  /** Terminal ids, most recently focused first (may be stale; see `mruTabs`). */
  mru = $state<string[]>([]);
  /** Closed terminals (last = most recent), for Ctrl+Shift+T. */
  closedStack = $state<{ sessionId: string; cwd?: string; title: string }[]>([]);

  private dataHandlers = new Map<string, DataHandler>();
  private exitHandlers = new Map<string, ExitHandler>();
  /** Registered by Terminal.svelte once its xterm instance exists, so
   * `focusActive()`/`openNew()` can focus it without either side reaching
   * into the other's DOM. */
  private focusFns = new Map<string, () => void>();
  private mountResolvers = new Map<string, () => void>();
  private firstDataResolvers = new Map<string, () => void>();
  private listenStarted: Promise<void> | null = null;
  private recWatching = false;

  /** Recordings browser dialog (mounted in App.svelte). */
  showRecordings = $state(false);

  /** Main window only: the panel lives in the separate terminal window. While
   * true, `tabs`/`activeId` are a read-only mirror pushed by that window and
   * no Terminal.svelte is mounted here. */
  detached = $state(false);
  /** Terminal window only: mirror of the main window's sessions. */
  remote = $state<TermContext | null>(null);
  hooks: DetachHooks | null = null;
  /** Terminal window only: sends captured commands to the main window's history. */
  recordHook: ((host: string, raw: string) => void) | null = null;

  /** Session a "new terminal" should use: in the terminal window the active tab's session
   * (falling back to the main window's active one), in the main window the active session. */
  defaultSessionId(): string | null {
    if (this.remote) {
      const t = this.activeTab;
      if (t && this.sessionList.some((s) => s.id === t.sessionId)) return t.sessionId;
    }
    return this.currentSessionId;
  }

  /** Sessions a terminal can be opened on (main: live sessions; terminal window: mirror). */
  get sessionList(): { id: string; label: string; user: string; hostname: string }[] {
    return this.remote ? this.remote.sessions : app.sessions;
  }

  get currentSessionId(): string | null {
    return this.remote ? this.remote.activeSessionId : app.activeSessionId;
  }

  sessionLabel(sessionId: string): string {
    return this.sessionList.find((s) => s.id === sessionId)?.label ?? sessionId;
  }

  /** `user@hostname` of a session (command-history key). */
  hostKey(sessionId: string): string | null {
    const s = this.sessionList.find((x) => x.id === sessionId);
    return s ? `${s.user}@${s.hostname}` : null;
  }

  /** Explorer directory of a session (start directory for new terminals). */
  cwdFor(sessionId: string | null): string | undefined {
    if (!sessionId) return undefined;
    if (this.remote) return this.remote.cwds[sessionId];
    return app.workspaces[sessionId]?.explorer.cwd;
  }

  private sessionReconnecting(sessionId: string): boolean {
    return this.remote ? this.remote.reconnecting.includes(sessionId) : isReconnecting(sessionId);
  }

  detach(): Promise<void> {
    return this.hooks?.detach() ?? Promise.resolve();
  }

  dock(): Promise<void> {
    return this.hooks?.dock() ?? Promise.resolve();
  }

  focusWindow(): void {
    this.hooks?.focusWindow();
  }

  /** Main window, while detached: asks the terminal window to split its pane area. */
  splitWindow(dir: "row" | "col"): void {
    this.hooks?.split(dir);
  }

  /** Replaces the tab state wholesale (terminal window start, dock back, mirror update). */
  applyTabState(st: TabState): void {
    this.tabs = st.tabs;
    this.activeId = st.activeId;
    if (st.mru) this.mru = st.mru;
    if (st.closedStack) this.closedStack = st.closedStack;
  }

  snapshotState(): Required<TabState> {
    return {
      tabs: $state.snapshot(this.tabs) as TerminalTab[],
      activeId: this.activeId,
      mru: [...this.mru],
      closedStack: $state.snapshot(this.closedStack) as Required<TabState>["closedStack"],
    };
  }

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
          const handler = this.dataHandlers.get(payload.termId);
          if (handler) handler(payload.data, payload.seq);
          else if (this.rebinding > 0) this.orphans.set(payload.termId, [...(this.orphans.get(payload.termId) ?? []), payload.data]);
          this.notifyFirstData(payload.termId);
        }),
        api.onTermExit((payload) => {
          this.handleExit(payload.termId, payload.code);
        }),
        api.onRecStopped((payload) => {
          if (this.detached) return;
          const tab = this.tabs.find((t) => t.id === payload.termId);
          if (tab?.recording) {
            tab.recording = false;
            app.addToast("error", `Recording stopped: ${payload.reason}`);
          }
        }),
      ]).then(() => undefined);
      this.watchRecordingSetting();
    }
    return this.listenStarted;
  }

  /** Registers the recording palette commands and reacts to the master
   * switch: turning `terminal.recording.enabled` off stops every running
   * recording. Idempotent; runs once from `ensureListening`. */
  private watchRecordingSetting(): void {
    if (this.recWatching) return;
    this.recWatching = true;
    registerCommand({
      id: "terminal.showRecordings",
      title: "Terminal: Show Recordings",
      category: "Terminal",
      run: () => (this.showRecordings = true),
    });
    $effect.root(() => {
      $effect(() => {
        const enabled = settings.terminal.recording.enabled;
        untrack(() => this.syncRecordingSetting(enabled));
      });
    });
  }

  private syncRecordingSetting(enabled: boolean): void {
    if (enabled) {
      registerCommand({
        id: "terminal.startRecording",
        title: "Terminal: Start Recording",
        category: "Terminal",
        run: () => void this.setRecording(this.activeId, true),
      });
      registerCommand({
        id: "terminal.stopRecording",
        title: "Terminal: Stop Recording",
        category: "Terminal",
        run: () => void this.setRecording(this.activeId, false),
      });
    } else {
      unregisterCommand("terminal.startRecording");
      unregisterCommand("terminal.stopRecording");
      void this.stopAllRecordings();
    }
  }

  /** Starts or stops recording one terminal (each start makes a new file). */
  async setRecording(id: string | null, on: boolean): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || tab.exited) return;
    if (on && !settings.terminal.recording.enabled) {
      app.addToast("error", "Enable terminal recording in Settings first.");
      return;
    }
    if (on === tab.recording) return;
    try {
      if (on) {
        tab.recPath = await api.recStart(tab.id, settings.terminal.recording.directory);
        tab.recording = true;
      } else {
        tab.recording = false;
        await api.recStop(tab.id);
      }
    } catch (err) {
      app.addToast("error", api.isAppError(err) ? err.message : String(err));
    }
  }

  toggleRecording(id: string | null): Promise<void> {
    const tab = this.tabs.find((t) => t.id === id);
    return this.setRecording(id, !(tab?.recording ?? false));
  }

  async stopAllRecordings(): Promise<void> {
    await Promise.all(this.tabs.filter((t) => t.recording).map((t) => this.setRecording(t.id, false)));
  }

  /** Registers the handler a Terminal.svelte instance uses to write incoming data. */
  onData(termId: string, handler: DataHandler): void {
    this.dataHandlers.set(termId, handler);
  }

  /** Registers the handler a Terminal.svelte instance uses to render the exit
   * banner. `keepOpen` tells it whether the store is about to remove this tab
   * (false — nothing more to do) or leave it up waiting for a keypress (true). */
  onExit(termId: string, handler: ExitHandler): void {
    this.exitHandlers.set(termId, handler);
  }

  /** Registers the function that focuses this terminal's xterm instance. */
  registerFocus(termId: string, fn: () => void): void {
    this.focusFns.set(termId, fn);
    this.notifyMounted(termId);
  }

  /** Called from Terminal.svelte's onDestroy. */
  offHandlers(termId: string): void {
    this.dataHandlers.delete(termId);
    this.exitHandlers.delete(termId);
    this.focusFns.delete(termId);
    this.mountResolvers.delete(termId);
    this.firstDataResolvers.delete(termId);
  }

  private notifyMounted(termId: string): void {
    const resolve = this.mountResolvers.get(termId);
    if (resolve) {
      this.mountResolvers.delete(termId);
      resolve();
    }
  }

  /** Resolves once Terminal.svelte for `termId` has mounted (registered its
   * focus fn), or after `MOUNT_TIMEOUT_MS` — a timeout fallback so a panel
   * that never becomes visible (e.g. hidden again before it could render)
   * can't hang `openNew()` forever. */
  private waitForMount(termId: string): Promise<void> {
    if (this.focusFns.has(termId)) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.mountResolvers.delete(termId);
        resolve();
      };
      this.mountResolvers.set(termId, finish);
      setTimeout(finish, MOUNT_TIMEOUT_MS);
    });
  }

  private notifyFirstData(termId: string): void {
    const resolve = this.firstDataResolvers.get(termId);
    if (resolve) {
      this.firstDataResolvers.delete(termId);
      resolve();
    }
  }

  /** Resolves on the first `term://data` chunk for `termId` (a decent proxy
   * for "the shell has printed its prompt and is ready for input"), or after
   * `FIRST_DATA_TIMEOUT_MS` — timeout fallback in case the shell is slow, or
   * a broken PTY never sends anything. */
  private waitForFirstData(termId: string): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.firstDataResolvers.delete(termId);
        resolve();
      };
      this.firstDataResolvers.set(termId, finish);
      setTimeout(finish, FIRST_DATA_TIMEOUT_MS);
    });
  }

  /** Sessions with an `openNew()` call currently between having been invoked
   * and having pushed its tab. Lets TerminalPanel.svelte's own "auto-open a
   * terminal when the panel is shown with none open" effect (Ctrl+J, the
   * palette's plain visibility toggle) coexist with App.svelte's explicit
   * "open one if none exists" for Ctrl+` (`toggleTerminalFocus`) without
   * both racing to open two terminals: both paths funnel through `openNew`,
   * which reserves the session here *synchronously*, before its first
   * `await` — so whichever caller runs first (imperative code always runs
   * before Svelte re-schedules reactive effects) is visible to the other
   * before either has had a chance to push a tab. */
  private pendingOpens = new Set<string>();

  hasPendingOpen(sessionId: string): boolean {
    return this.pendingOpens.has(sessionId);
  }

  /** §12.1: the one path every "open a terminal" caller should use. Shows the
   * panel, opens the PTY, creates and activates a tab, waits for its
   * Terminal.svelte to mount and focuses it, then (if `command` was given)
   * writes `command + "\r"` once the shell's first output chunk arrives. */
  async openNew(
    sessionId: string,
    opts: { cwd?: string; command?: string; title?: string } = {},
  ): Promise<string> {
    if (this.detached && this.hooks) return this.hooks.open(sessionId, opts);
    if (!this.sessionList.some((s) => s.id === sessionId)) {
      throw { kind: "Connection", message: "That session is no longer connected." } satisfies AppError;
    }
    if (this.sessionReconnecting(sessionId)) {
      throw {
        kind: "Connection",
        message: `${this.sessionLabel(sessionId)} is reconnecting. Open the terminal once it is back.`,
      } satisfies AppError;
    }
    app.showTerminal = true;
    this.pendingOpens.add(sessionId);
    const ordinal = this.tabs.filter((t) => t.sessionId === sessionId).length + 1;
    const title = opts.title ?? `Terminal ${ordinal}`;
    let id: string;
    try {
      id = await api.termOpen(sessionId, DEFAULT_COLS, DEFAULT_ROWS, opts.cwd);
    } finally {
      this.pendingOpens.delete(sessionId);
    }
    this.tabs.push({
      id,
      sessionId,
      title,
      exited: false,
      exitCode: null,
      openedWithCommand: opts.command !== undefined,
      cwd: opts.cwd,
      customTitle: opts.title !== undefined,
      key: id,
      recording: false,
    });
    if (settings.terminal.recording.enabled && settings.terminal.recording.autoRecordNew) {
      void this.setRecording(id, true);
    }
    this.activeId = id;
    this.touch(id);
    await this.waitForMount(id);
    this.focusActive();
    if (opts.command !== undefined) {
      const command = opts.command;
      await this.waitForFirstData(id);
      // The shell may already be gone (closed tab, dropped link): nothing to type into.
      if (this.tabs.some((t) => t.id === id && !t.exited)) {
        await api.termWrite(id, command + "\r").catch((err) => {
          app.addToast("error", `Could not run the command: ${api.isAppError(err) ? err.message : String(err)}`);
        });
      }
    }
    return id;
  }

  /** Focuses the active terminal's xterm instance. Returns false if there is
   * no active tab, or its Terminal.svelte hasn't registered a focus fn yet. */
  focusActive(): boolean {
    if (this.detached) {
      this.focusWindow();
      return true;
    }
    const id = this.activeId;
    if (!id) return false;
    const fn = this.focusFns.get(id);
    if (!fn) return false;
    fn();
    return true;
  }

  /** True if the currently focused element is inside any mounted xterm
   * instance (any terminal, not just the active tab — matches what the user
   * actually sees focus-wise). */
  hasFocus(): boolean {
    const el = document.activeElement;
    return el !== null && el.closest(".xterm") !== null;
  }

  private rebinding = 0;
  private orphans = new Map<string, string[]>();

  /** Auto-reconnect (§13.4.A): opens a fresh PTY for every terminal of the old
   * session inside the same tab (same xterm instance, so scrollback stays),
   * in the tab's last known cwd, and prints a dim "reconnected" line. */
  async rebindSession(oldSessionId: string, newSessionId: string): Promise<void> {
    if (this.detached) {
      this.hooks?.remap(oldSessionId, newSessionId); // the terminal window owns the PTYs now
      return;
    }
    this.rebinding++;
    try {
      for (const tab of this.tabs.filter((t) => t.sessionId === oldSessionId)) {
        const oldId = tab.id;
        tab.key ??= oldId;
        let newId: string;
        try {
          newId = await api.termOpen(newSessionId, DEFAULT_COLS, DEFAULT_ROWS, tab.cwd);
        } catch (err) {
          this.dataHandlers.get(oldId)?.("\r\n\x1b[31m— could not reopen the shell —\x1b[0m\r\n");
          console.error("terminal rebind failed", err);
          // The old session id is gone after the remap: follow the new one so the tab
          // keeps its label and is closed with that session (`sessionLost`).
          tab.sessionId = newSessionId;
          tab.exited = true;
          continue;
        }
        const size = lastTermSize.get(oldId);
        if (size) void api.termResize(newId, size.cols, size.rows).catch(() => undefined);
        const data = this.dataHandlers.get(oldId);
        const exit = this.exitHandlers.get(oldId);
        const focus = this.focusFns.get(oldId);
        this.dataHandlers.delete(oldId);
        this.exitHandlers.delete(oldId);
        this.focusFns.delete(oldId);
        if (data) this.dataHandlers.set(newId, data);
        if (exit) this.exitHandlers.set(newId, exit);
        if (focus) this.focusFns.set(newId, focus);
        tab.id = newId;
        tab.sessionId = newSessionId;
        tab.exited = false;
        tab.exitCode = null;
        if (tab.recording) tab.recording = false; // the old PTY's recording ended with it
        if (this.activeId === oldId) this.activeId = newId;
        this.mru = this.mru.map((m) => (m === oldId ? newId : m));
        data?.("\r\n\x1b[2m— reconnected —\x1b[0m\r\n");
        for (const chunk of this.orphans.get(newId) ?? []) data?.(chunk);
        this.orphans.delete(newId);
      }
    } finally {
      this.rebinding--;
      if (this.rebinding === 0) this.orphans.clear();
    }
  }

  /** A session is gone for good (user disconnect, or a cancelled auto-reconnect):
   * its PTYs are gone too. Tabs kept as "connection lost" during the reconnect will
   * never get another term://exit, so they are dropped here. */
  sessionLost(sessionId: string): void {
    if (this.detached) {
      this.hooks?.lost(sessionId); // the terminal window owns the tabs
      return;
    }
    const gone = this.tabs.filter((t) => t.sessionId === sessionId).map((t) => t.id);
    if (gone.length === 0) return;
    for (const id of gone) this.forget(id);
    if (this.tabs.length === 0) app.showTerminal = false;
  }

  /** Handles one term://exit: per docs/GUIDE.md §12 item 2, a terminal closes
   * itself automatically (tab removed, xterm disposed via Terminal.svelte's
   * onDestroy) — except a command-terminal (`openNew(..., { command })`) that
   * exited non-zero, which stays open showing the exit banner until any key
   * is pressed (see Terminal.svelte). Hides the panel if this was the last
   * terminal. */
  private handleExit(termId: string, code: number | null, deferred = false): void {
    if (this.detached) return; // the terminal window handles it
    const tab = this.tabs.find((t) => t.id === termId);
    if (!tab) return;
    // Auto-reconnect (§13.4.A): a dropped link ends every channel without an exit
    // status. Wait a moment for `session://closed`, then keep the tab (scrollback)
    // instead of closing it; it is rebound to a new PTY once the session is back.
    if (code === null && !deferred) {
      setTimeout(() => this.handleExit(termId, code, true), 600);
      return;
    }
    if (this.sessionReconnecting(tab.sessionId)) {
      tab.exited = true;
      this.dataHandlers.get(termId)?.("\r\n\x1b[2m— connection lost —\x1b[0m\r\n");
      return;
    }
    tab.exited = true;
    tab.exitCode = code;
    const keepOpen = tab.openedWithCommand && code !== null && code !== 0;
    this.exitHandlers.get(termId)?.(code, keepOpen);
    if (!keepOpen) {
      this.forget(termId);
      if (this.tabs.length === 0) app.showTerminal = false;
    }
  }

  /** Closes a terminal: tells the backend, then drops its bookkeeping here.
   * Used for user-initiated closes (the tab strip's close button, or the
   * "press any key to close" exit banner) — exit-triggered auto-close goes
   * through `handleExit` instead, since the process is already gone. */
  async close(id: string): Promise<void> {
    const t = this.tabs.find((x) => x.id === id);
    if (t) {
      this.closedStack.push({ sessionId: t.sessionId, cwd: t.cwd, title: t.title });
      if (this.closedStack.length > 20) this.closedStack.shift();
    }
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
    this.mru = this.mru.filter((m) => m !== id);
    if (this.activeId === id) {
      const neighbor = this.tabs[idx] ?? this.tabs[idx - 1];
      this.activeId = neighbor ? neighbor.id : null;
    }
  }

  setActive(id: string): void {
    if (this.tabs.some((t) => t.id === id)) {
      this.activeId = id;
      this.touch(id);
      if (this.detached) this.hooks?.activate(id);
    }
  }

  touch(id: string): void {
    this.mru = [id, ...this.mru.filter((m) => m !== id)];
  }

  /** Terminals ordered by last focus (active first); unrecorded ones keep strip order. */
  mruTabs(): TerminalTab[] {
    const out: TerminalTab[] = [];
    for (const id of [this.activeId, ...this.mru]) {
      const t = id ? this.tabs.find((x) => x.id === id) : undefined;
      if (t && !out.includes(t)) out.push(t);
    }
    for (const t of this.tabs) if (!out.includes(t)) out.push(t);
    return out;
  }

  /** Ctrl+W: closes the active terminal. */
  async closeActive(): Promise<boolean> {
    const id = this.activeId;
    if (!id) return false;
    await this.close(id);
    if (this.tabs.length === 0) app.showTerminal = false;
    else this.focusActive();
    return true;
  }

  /** Ctrl+Shift+T: reopens the most recently closed terminal (same session,
   * cwd and title); skips entries whose session is gone. */
  async reopenClosed(): Promise<boolean> {
    if (this.detached && this.hooks) {
      this.hooks.reopen();
      return true;
    }
    while (this.closedStack.length > 0) {
      const e = this.closedStack.pop()!;
      if (!this.sessionList.some((s) => s.id === e.sessionId)) continue;
      try {
        await this.openNew(e.sessionId, { cwd: e.cwd, title: e.title });
      } catch (err) {
        app.addToast("error", api.isAppError(err) ? err.message : String(err));
        return false;
      }
      return true;
    }
    return false;
  }
}

export const terminalStore = new TerminalStore();

app.onSessionRemap((oldId, newId) => terminalStore.rebindSession(oldId, newId));
app.onSessionLost((id) => terminalStore.sessionLost(id));
