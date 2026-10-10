// Window-to-window plumbing for the detachable terminal panel (docs/GUIDE.md §14.4.W).
//
// Two roles live in this module:
//  - main window (`initMain`): starts/stops the detached window, mirrors sessions and
//    settings to it, forwards "open a terminal" requests, takes the tabs back on dock.
//  - terminal window (`initTerminalWindow`): adopts the tab list, replays scrollback (done
//    per Terminal.svelte via `term_snapshot`), mirrors its tab list back to the main window.
//
// Messages are global Tauri events (`termwin://*`). Names are one-directional so a window
// never hears its own message: main -> window use INIT/CTX/SETTINGS/REMAP/OPEN/REOPEN/
// ACTIVATE (+ CLOSE_REQUESTED, also sent by Rust), window -> main use READY/TABS/DOCK/
// OPENED/RECORD (+ GONE, sent by Rust when the window is destroyed).

import { untrack } from "svelte";
import * as api from "../lib/api";
import { isAppError } from "../lib/api";
import { app } from "../lib/stores.svelte";
import { settings, updateSettings } from "../lib/settings.svelte";
import { reconnect } from "../lib/reconnect.svelte";
import { registerCommand } from "../lib/commands.svelte";
import { record } from "../lib/history.svelte";
import { terminalStore, type TabState, type TermContext } from "../lib/terminal.svelte";
import { termLayout } from "./layout.svelte";
import type { Settings } from "../lib/types";

export const EV = {
  // main -> terminal window
  init: "termwin://init",
  ctx: "termwin://ctx",
  settings: "termwin://settings",
  remap: "termwin://remap",
  open: "termwin://open",
  reopen: "termwin://reopen",
  activate: "termwin://activate",
  split: "termwin://split",
  // Rust (or main) -> terminal window: "dock your tabs back and close"
  closeRequested: "termwin://close-requested",
  // terminal window -> main
  ready: "termwin://ready",
  tabs: "termwin://tabs",
  dock: "termwin://dock",
  opened: "termwin://opened",
  record: "termwin://record",
  // Rust -> main: the terminal window was destroyed
  gone: "termwin://gone",
} as const;

interface InitPayload extends Required<TabState> {
  ctx: TermContext;
  settings: Settings;
}

interface OpenRequest {
  reqId: string;
  sessionId: string;
  opts: { cwd?: string; command?: string; title?: string };
}

interface OpenReply {
  reqId: string;
  id?: string;
  error?: string;
}

function errorMessage(err: unknown): string {
  return isAppError(err) ? err.message : err instanceof Error ? err.message : String(err);
}

// --- remembered window geometry (shared localStorage, same origin) ------------

const GEOMETRY_KEY = "overssh.termwin.geometry";

function loadGeometry(): api.WinGeometry | null {
  try {
    const raw = localStorage.getItem(GEOMETRY_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as api.WinGeometry;
    return typeof g === "object" && g !== null ? g : null;
  } catch {
    return null;
  }
}

function saveGeometry(g: api.WinGeometry): void {
  try {
    localStorage.setItem(GEOMETRY_KEY, JSON.stringify(g));
  } catch {
    // storage unavailable: the window just opens at its default place next time
  }
}

// =============================================================================
// Main window
// =============================================================================

let mainStarted = false;
let mainListeners: Promise<unknown> = Promise.resolve();
let detaching = false;
let readyResolve: (() => void) | null = null;
const openWaiters = new Map<
  string,
  { resolve: (id: string) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
let reqCounter = 0;
/** Bumps on every detach, so a stale dock fallback timer never closes a newer window. */
let detachGeneration = 0;

/** What the terminal window needs to know about the main window's sessions. */
function buildCtx(): TermContext {
  const sessions = app.sessions.map((s) => ({ id: s.id, label: s.label, user: s.user, hostname: s.hostname }));
  const cwds: Record<string, string> = {};
  for (const s of app.sessions) {
    const cwd = app.workspaces[s.id]?.explorer.cwd;
    if (cwd) cwds[s.id] = cwd;
  }
  return {
    sessions,
    activeSessionId: app.activeSessionId,
    cwds,
    reconnecting: Object.keys(reconnect.items),
  };
}

/** The terminal window announced itself: hand it everything it needs. */
function onReady(): void {
  if (!detaching && !terminalStore.detached) return; // stray (e.g. a window we did not open)
  const st = terminalStore.snapshotState();
  const payload: InitPayload = { ...st, ctx: buildCtx(), settings: $state.snapshot(settings) as Settings };
  void api.emitEvent(EV.init, payload);
  if (!terminalStore.detached) detachGeneration++;
  terminalStore.detached = true;
  app.showTerminal = false;
  readyResolve?.();
}

async function detachPanel(): Promise<void> {
  if (terminalStore.detached) {
    void api.termWindowFocus().catch(() => undefined);
    return;
  }
  if (detaching) return;
  detaching = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await mainListeners;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      timer = setTimeout(() => reject(new Error("The terminal window did not start")), 15_000);
    });
    await api.termWindowOpen(loadGeometry());
    await ready;
  } catch (err) {
    await api.termWindowClose().catch(() => undefined);
    app.addToast("error", errorMessage(err));
  } finally {
    if (timer) clearTimeout(timer);
    readyResolve = null;
    detaching = false;
  }
}

/** Takes the tabs back from the terminal window and closes it. */
function finishDock(st: TabState): void {
  if (!terminalStore.detached) return;
  terminalStore.applyTabState(st);
  terminalStore.detached = false;
  app.showTerminal = st.tabs.length > 0;
  // "New terminal" requests the window can no longer answer fail now, not after 30 s.
  for (const [reqId, w] of openWaiters) {
    openWaiters.delete(reqId);
    clearTimeout(w.timer);
    w.reject(new Error("The terminal window closed"));
  }
  void api.termWindowClose().catch(() => undefined);
}

/** "Dock back" from the main window: ask the window for its final state. */
async function dockPanel(): Promise<void> {
  if (!terminalStore.detached) return;
  const gen = detachGeneration;
  void api.emitEvent(EV.closeRequested).catch(() => undefined);
  // Window not answering: fall back to the last mirrored tab list.
  setTimeout(() => {
    if (terminalStore.detached && gen === detachGeneration) finishDock(terminalStore.snapshotState());
  }, 3000);
}

/** A "new terminal" request for the detached window; resolves with the new termId. */
function openRemote(
  sessionId: string,
  opts: { cwd?: string; command?: string; title?: string },
): Promise<string> {
  const reqId = `${Date.now()}-${++reqCounter}`;
  void api.termWindowFocus().catch(() => undefined);
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      openWaiters.delete(reqId);
      reject(new Error("The terminal window did not answer"));
    }, 30_000);
    openWaiters.set(reqId, { resolve, reject, timer });
    const req: OpenRequest = { reqId, sessionId, opts };
    void api.emitEvent(EV.open, req);
  });
}

function onOpened(reply: OpenReply): void {
  const w = openWaiters.get(reply.reqId);
  if (!w) return;
  openWaiters.delete(reply.reqId);
  clearTimeout(w.timer);
  if (reply.id) w.resolve(reply.id);
  else w.reject(new Error(reply.error ?? "Could not open a terminal"));
}

/** Idempotent. Called when the panel is first mounted in the main window. */
export function initMain(): void {
  if (mainStarted) return;
  mainStarted = true;

  terminalStore.hooks = {
    detach: detachPanel,
    dock: dockPanel,
    open: openRemote,
    reopen: () => void api.emitEvent(EV.reopen),
    activate: (id) => void api.emitEvent(EV.activate, { id }),
    remap: (oldId, newId) => void api.emitEvent(EV.remap, { oldId, newId }),
    focusWindow: () => void api.termWindowFocus().catch(() => undefined),
    split: (dir) => {
      void api.termWindowFocus().catch(() => undefined);
      void api.emitEvent(EV.split, { dir });
    },
  };

  mainListeners = Promise.all([
    api.listenEvent<void>(EV.ready, onReady),
    api.listenEvent<TabState>(EV.tabs, (st) => {
      if (terminalStore.detached) terminalStore.applyTabState(st);
    }),
    api.listenEvent<TabState>(EV.dock, finishDock),
    api.listenEvent<OpenReply>(EV.opened, onOpened),
    api.listenEvent<{ host: string; raw: string }>(EV.record, (p) => record(p.host, p.raw)),
    api.listenEvent<void>(EV.gone, () => {
      if (terminalStore.detached) finishDock(terminalStore.snapshotState());
    }),
  ]);

  // Created from a microtask so the root is not parented to the (mounting) panel component,
  // which is destroyed while detached.
  queueMicrotask(() => $effect.root(() => {
    // Palette: Detach <-> Dock.
    $effect(() => {
      const detached = terminalStore.detached;
      return untrack(() =>
        detached
          ? registerCommand({
              id: "terminal.dock",
              title: "Terminal: Dock Panel",
              category: "Terminal",
              run: () => void terminalStore.dock(),
            })
          : registerCommand({
              id: "terminal.detach",
              title: "Terminal: Detach Panel to Window",
              category: "Terminal",
              run: () => void terminalStore.detach(),
            }),
      );
    });
    // Palette: split the detached window's terminal area (only while detached).
    $effect(() => {
      if (!terminalStore.detached) return;
      const offs = [
        registerCommand({
          id: "terminal.splitRight",
          title: "Terminal: Split Right (Terminals Window)",
          category: "Terminal",
          run: () => terminalStore.splitWindow("row"),
        }),
        registerCommand({
          id: "terminal.splitDown",
          title: "Terminal: Split Down (Terminals Window)",
          category: "Terminal",
          run: () => terminalStore.splitWindow("col"),
        }),
      ];
      return () => offs.forEach((off) => off());
    });
    // Keep the window's view of sessions / explorer dirs / reconnects current.
    $effect(() => {
      if (!terminalStore.detached) return;
      const ctx = buildCtx();
      void api.emitEvent(EV.ctx, ctx);
    });
    // ...and its settings (theme, font size, ...).
    $effect(() => {
      if (!terminalStore.detached) return;
      JSON.stringify(settings); // track the whole tree
      void api.emitEvent(EV.settings, $state.snapshot(settings));
    });
    // "Show the terminal panel" (Ctrl+J, palette, status bar, snippets...) means "bring the window".
    $effect(() => {
      if (!terminalStore.detached || !app.showTerminal) return;
      untrack(() => {
        app.showTerminal = false;
        terminalStore.focusWindow();
      });
    });
  }));
}

// =============================================================================
// Terminal window
// =============================================================================

/** True once the main window's init message arrived and the panel can render. */
export const windowState = $state({ ready: false, docking: false });

function adopt(p: InitPayload): void {
  terminalStore.remote = p.ctx;
  updateSettings(p.settings);
  terminalStore.applyTabState(p);
  app.showTerminal = true;
  windowState.ready = true;
}

/** Hands the tabs back to the main window, which then closes this window. */
export async function dockBack(): Promise<void> {
  if (windowState.docking) return;
  windowState.docking = true;
  try {
    await api.emitEvent(EV.dock, terminalStore.snapshotState());
  } catch (err) {
    console.error("dock message failed", err);
  }
  // Main never closed us (it may be gone): close ourselves.
  setTimeout(() => void api.termWindowClose().catch(() => undefined), 4000);
}

/** Starts the terminal window's side. Resolves once the main window was told we are ready. */
export async function initTerminalWindow(): Promise<void> {
  terminalStore.recordHook = (host, raw) => void api.emitEvent(EV.record, { host, raw });
  await Promise.all([
    api.listenEvent<InitPayload>(EV.init, adopt),
    api.listenEvent<TermContext>(EV.ctx, (ctx) => {
      terminalStore.remote = ctx;
    }),
    api.listenEvent<Settings>(EV.settings, (s) => updateSettings(s)),
    api.listenEvent<{ oldId: string; newId: string }>(EV.remap, (p) => {
      void terminalStore.rebindSession(p.oldId, p.newId);
    }),
    api.listenEvent<OpenRequest>(EV.open, async (req) => {
      try {
        const id = await terminalStore.openNew(req.sessionId, req.opts);
        await api.emitEvent(EV.opened, { reqId: req.reqId, id } satisfies OpenReply);
      } catch (err) {
        await api.emitEvent(EV.opened, { reqId: req.reqId, error: errorMessage(err) } satisfies OpenReply);
      }
    }),
    api.listenEvent<void>(EV.reopen, () => void terminalStore.reopenClosed()),
    api.listenEvent<{ id: string }>(EV.activate, (p) => terminalStore.setActive(p.id)),
    api.listenEvent<{ dir: "row" | "col" }>(EV.split, (p) => void termLayout.split(p.dir === "col" ? "col" : "row")),
    api.listenEvent<void>(EV.closeRequested, () => void dockBack()),
  ]);
  await terminalStore.ensureListening();
  await api.emitEvent(EV.ready);
}

/** Polls the window's place/size (the web platform has no move event) and remembers it. */
export function watchWindowGeometry(): () => void {
  let last = "";
  const tick = () => {
    const g = { x: window.screenX, y: window.screenY, width: window.innerWidth, height: window.innerHeight };
    const key = JSON.stringify(g);
    if (key !== last && g.width > 100 && g.height > 100) {
      last = key;
      saveGeometry(g);
    }
  };
  const timer = setInterval(tick, 1500);
  return () => clearInterval(timer);
}
