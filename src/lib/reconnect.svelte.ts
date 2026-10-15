// Auto-reconnect engine (docs/GUIDE.md §13.4.A).
//
// A dropped session keeps its workspace (tabs, buffers, explorer, terminal
// scrollback). This module retries the stored `ConnectRequest` with backoff,
// then calls `app.remapSession(old, info, req)` to rebind everything to the
// new backend session id. Secrets live only in memory (the request map in
// `stores.svelte.ts`); nothing here persists or logs them.

import * as api from "./api";
import { isAppError } from "./api";
import { app } from "./stores.svelte";
import { settings } from "./settings.svelte";
import {
  backoffDelayMs,
  classifyReconnectError,
  isClockJump,
  shouldGiveUp,
  SLEEP_JUMP_MS,
} from "./reconnectLogic";
import type { ConnectRequest, ErrorKind, SessionClosedEvent } from "./types";

export type ReconnectStatus = "connecting" | "waiting" | "prompting" | "failed" | "paused";

export interface ReconnectItem {
  sessionId: string;
  label: string;
  /** Tunnel-only (-N) session: no workspace, only forwards depend on it. */
  background: boolean;
  status: ReconnectStatus;
  /** Attempts made so far (the one in flight counts). */
  attempt: number;
  /** Epoch ms of the next attempt while `waiting`. */
  nextAt: number | null;
  startedAt: number;
  lastError: string | null;
}

export const reconnect = $state({ items: {} as Record<string, ReconnectItem> });

/** Epoch ms ticking once a second while something is waiting (drives the countdown UI). */
export const reconnectClock = $state({ now: Date.now() });

/** Latest request per dropped session (secrets, memory only). */
const requests = new Map<string, ConnectRequest>();
/** Wakes the backoff sleep early (retry now / cancel). */
const wakers = new Map<string, () => void>();
/** The prompt a session currently shows, so a cancel can dismiss exactly that one. */
const prompts = new Map<string, object>();

function errorMessage(err: unknown): string {
  return isAppError(err) ? err.message : String(err);
}

function alive(sessionId: string): boolean {
  return sessionId in reconnect.items;
}

function sleep(sessionId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      wakers.delete(sessionId);
      resolve();
    }
    wakers.set(sessionId, done);
  });
}

/** Waits (without stacking) until no other connect/confirm dialog is open. */
async function waitForPromptSlot(sessionId: string): Promise<boolean> {
  while (alive(sessionId) && (app.pendingConnect !== null || app.dialogRequest !== null)) {
    await sleep(sessionId, 1000);
  }
  return alive(sessionId);
}

function promptOnce(
  sessionId: string,
  label: string,
  req: ConnectRequest,
  err: { kind: ErrorKind; message: string; fingerprint?: string; keyPath?: string; hop?: string },
): Promise<ConnectRequest | null> {
  return new Promise((resolve) => {
    const pending = {
      req,
      kind: err.kind,
      message: err.message,
      fingerprint: err.fingerprint,
      keyPath: err.keyPath,
      hop: err.hop,
      retry: (merged: ConnectRequest) => {
        prompts.delete(sessionId);
        resolve(merged);
      },
      onCancel: () => {
        prompts.delete(sessionId);
        resolve(null);
      },
    };
    prompts.set(sessionId, pending);
    app.connectTarget = label;
    app.pendingConnect = pending;
  });
}

async function run(sessionId: string): Promise<void> {
  const item = reconnect.items[sessionId];
  if (!item) return;
  let skipDelay = false;
  while (alive(sessionId)) {
    const delay = skipDelay ? 0 : backoffDelayMs(item.attempt + 1);
    skipDelay = false;
    if (item.attempt > 0 && shouldGiveUp(Date.now() - item.startedAt, delay)) {
      item.status = "failed";
      item.nextAt = null;
      return;
    }
    if (delay > 0) {
      item.status = "waiting";
      item.nextAt = Date.now() + delay;
      await sleep(sessionId, delay);
      if (!alive(sessionId)) return;
    }
    item.attempt += 1;
    item.status = "connecting";
    item.nextAt = null;
    const req = requests.get(sessionId);
    if (!req) {
      item.status = "failed";
      item.lastError = "No stored connection details";
      return;
    }
    try {
      const info = await api.connect(req);
      if (!alive(sessionId)) {
        void api.disconnect(info.id).catch(() => undefined);
        return;
      }
      await app.remapSession(sessionId, info, req);
      delete reconnect.items[sessionId];
      requests.delete(sessionId);
      if (!item.background) app.addToast("success", `Reconnected to ${item.label}`);
      return;
    } catch (err) {
      if (!alive(sessionId)) return;
      item.lastError = errorMessage(err);
      const cls = classifyReconnectError(isAppError(err) ? err.kind : undefined);
      if (cls === "prompt" && isAppError(err)) {
        item.status = "prompting";
        if (!(await waitForPromptSlot(sessionId))) return;
        const merged = await promptOnce(sessionId, item.label, req, {
          kind: err.kind,
          message: err.message,
          fingerprint: err.fingerprint,
          keyPath: err.keyPath,
          hop: err.hop,
        });
        if (!alive(sessionId)) return;
        if (!merged) {
          item.status = "failed";
          item.lastError = "Cancelled";
          return;
        }
        requests.set(sessionId, merged);
        item.attempt -= 1; // answering a prompt is not a failed attempt
        skipDelay = true;
        continue;
      }
      if (cls === "fatal") {
        // Wrong stored secret: forget it so a manual Retry prompts again.
        if (isAppError(err) && err.kind === "AuthFailed") {
          requests.set(sessionId, { ...req, password: undefined, passphrase: undefined });
        }
        item.status = "failed";
        return;
      }
      // "retry": loop, the backoff applies.
    }
  }
}

function cancelItem(sessionId: string): void {
  if (!alive(sessionId)) return;
  const owned = prompts.get(sessionId);
  delete reconnect.items[sessionId];
  requests.delete(sessionId);
  if (owned && app.pendingConnect === owned) app.cancelConnectPrompt();
  prompts.delete(sessionId);
  wakers.get(sessionId)?.();
}

function begin(payload: SessionClosedEvent): boolean {
  const id = payload.sessionId;
  if (alive(id)) return true;
  const pause = settings.connection.pauseOnDrop;
  if (!pause && !settings.connection.autoReconnect) return false;
  const req = app.requestFor(id);
  if (!req) return false;
  const bg = app.backgroundInfo(id);
  const label = bg?.label ?? app.sessions.find((s) => s.id === id)?.label ?? id;
  requests.set(id, req);
  reconnect.items[id] = {
    sessionId: id,
    label,
    background: !!bg,
    status: pause ? "paused" : "connecting",
    attempt: 0,
    nextAt: null,
    startedAt: Date.now(),
    lastError: payload.reason || null,
  };
  // Tidy the dead backend session (terminals, forwards, manager entry).
  void api.disconnect(id).catch(() => undefined);
  app.fireDrop(id);
  if (!pause) void run(id);
  return true;
}

/** Retry now: skips the backoff wait, or restarts after "Disconnected". */
export function retryNow(sessionId: string): void {
  const item = reconnect.items[sessionId];
  if (!item) return;
  if (item.status === "failed" || item.status === "paused") {
    item.attempt = 0;
    item.startedAt = Date.now();
    item.status = "connecting";
    void run(sessionId);
  } else if (item.status === "waiting") {
    item.nextAt = Date.now();
    wakers.get(sessionId)?.();
  }
}

/** Continues every paused session (network is back). */
export function continuePaused(): void {
  for (const item of Object.values(reconnect.items)) if (item.status === "paused") retryNow(item.sessionId);
}

/** Cancel: closes the workspace (asks first when it has unsaved tabs). */
export function cancelReconnect(sessionId: string): Promise<void> {
  const item = reconnect.items[sessionId];
  if (item?.background) {
    cancelItem(sessionId);
    app.releaseBackground(sessionId);
    return Promise.resolve();
  }
  return app.disconnectSession(sessionId);
}

export function isReconnecting(sessionId: string): boolean {
  return alive(sessionId);
}

// --- wiring -----------------------------------------------------------------

app.reconnectHandler = begin;
app.isSessionReconnecting = isReconnecting;
app.onSessionLost(cancelItem);

// --- sleep / network-change detection ------------------------------------------

let probing = false;

/** Cheap request to every live session; a failure is treated as a drop. */
export async function probeSessions(): Promise<void> {
  if (probing) return;
  probing = true;
  try {
    const ids = [...app.sessions.map((s) => s.id), ...app.backgroundIds()].filter((id) => !alive(id));
    await Promise.all(
      ids.map(async (id) => {
        try {
          await api.sessionPing(id);
        } catch {
          app.handleSessionClosed({ sessionId: id, reason: "Connection lost (no response from server)" });
        }
      }),
    );
  } finally {
    probing = false;
  }
}

if (typeof window !== "undefined") {
  let lastTick = Date.now();
  let hiddenAt: number | null = null;
  setInterval(() => {
    const now = Date.now();
    const jumped = isClockJump(lastTick, now, 1000);
    lastTick = now;
    if (Object.keys(reconnect.items).length > 0) reconnectClock.now = now;
    // A hidden (tray / minimized) page has its timers throttled to about once a
    // minute, which looks like a jump on every tick: that would ping every session
    // each minute while hidden (§17). The visibilitychange handler below probes
    // once when the window comes back after more than SLEEP_JUMP_MS.
    if (jumped && !document.hidden) void probeSessions();
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (hiddenAt !== null && Date.now() - hiddenAt > SLEEP_JUMP_MS) {
      hiddenAt = null;
      void probeSessions();
    }
    if (!document.hidden && settings.connection.resumeOnRestore && navigator.onLine) continuePaused();
  });
  window.addEventListener("online", () => {
    if (settings.connection.resumeOnRestore) continuePaused();
    void probeSessions();
  });
}
