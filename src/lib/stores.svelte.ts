// Single shared app state (Svelte 5 runes), per docs/GUIDE.md §7.
// Components read/mutate `app` directly; all backend I/O goes through lib/api.ts.

import { clipboardWrite } from "$lib/clipboard";
import { SvelteSet } from "svelte/reactivity";
import { toast } from "svelte-sonner";
import * as api from "./api";
import { isAppError } from "./api";
import { basename, dirname, join, validateEntryName } from "./paths";
import { languageName } from "./languages";
import { touchSavedHost } from "./hosts.svelte";
import { settings } from "./settings.svelte";
import { registerCommand } from "./commands.svelte";
import type {
  ConnectRequest,
  ErrorKind,
  FileEntry,
  SessionClosedEvent,
  SessionInfo,
} from "./types";

/** Activity-bar views (docs/GUIDE.md §13.1). */
export type SidebarView = "hosts" | "explorer" | "search" | "scm" | "commands" | "monitor" | "logs" | "ports" | "docker";

export interface Tab {
  id: string;
  sessionId: string;
  path: string;
  doc: string;
  savedDoc: string;
  mtime: number;
  language: string;
  isBinary: boolean;
  tooLarge: boolean;
  forceOpen: boolean; // user chose "open anyway" for a binary file
  loading: boolean;
  saving: boolean;
  error: string | null;
  line: number;
  col: number;
  /** Set when an autosave hit PermissionDenied; autosave skips the tab until a
   * manual save succeeds (a manual Ctrl+S still offers sudo). */
  autoSavePaused?: boolean;
  /** Set when reopening this tab on Resume (docs/GUIDE.md §12, "Pause
   * session") hit `NotFound` — the file was deleted on the server while the
   * session was paused. The tab is kept (with its saved content, if any) so
   * the user doesn't lose unsaved work; Editor.svelte shows a warning banner.
   * Saving clears it (a normal write recreates the file). */
  missing?: boolean;
  /** The user confirmed saving a binary / non-UTF-8 buffer (shown lossy). */
  lossyOk?: boolean;
}

/** Above this size (from the explorer listing) opening a file asks first. */
const LARGE_FILE_BYTES = 5 * 1024 * 1024;

/** True when the loaded text is a lossy view of the bytes on the server. */
function isLossy(tab: Tab): boolean {
  return tab.isBinary || tab.savedDoc.includes("\uFFFD");
}

/** Latest listing request per explorer pane / child dir: a late answer for an
 * older request (fast navigation, refresh while loading) is dropped. */
const listTokens = new WeakMap<object, Map<string, number>>();
let listSeq = 0;
function nextListToken(ex: ExplorerState, key: string): number {
  let m = listTokens.get(ex);
  if (!m) listTokens.set(ex, (m = new Map()));
  const t = ++listSeq;
  m.set(key, t);
  return t;
}
function isLatestList(ex: ExplorerState, key: string, token: number): boolean {
  return listTokens.get(ex)?.get(key) === token;
}

/** One open tab's snapshot inside a `PausedSession` (docs/GUIDE.md §12,
 * "Pause session"). `doc` is only carried for a dirty tab — a clean tab is
 * just reopened fresh on resume, same as a normal `openFile`. */
export interface PausedTab {
  path: string;
  dirty: boolean;
  doc: string | null;
}

/** A disconnected-but-remembered session (docs/GUIDE.md §12, "Pause
 * session"): everything needed to reconnect and put the workbench back the
 * way it was, persisted via the "paused" store so it survives an app
 * restart. `request` never carries a password/passphrase — Resume always
 * goes through the normal connect prompts. */
export interface PausedSession {
  id: string;
  label: string;
  request: ConnectRequest;
  tabs: PausedTab[];
  activeTabPath: string | null;
  cwd: string;
  expandedDirs: string[];
  pausedAt: number;
  /** Second explorer pane, if the Explorer was split (§15.3.S). */
  split?: { cwd: string; expandedDirs: string[]; active: number; ratio: number };
}

export interface SaveOptions {
  /** Autosave: no success toast, no sudo prompt, skipped while a save is in
   * flight, a conflict is pending, or the tab is paused. */
  auto?: boolean;
}

/** A lazily-loaded, expanded tree node's children (keyed by directory path in
 * `ExplorerState.children`). Separate from `ExplorerState.entries`, which only
 * holds the root listing. */
export interface DirNode {
  entries: FileEntry[] | null;
  loading: boolean;
  error: string | null;
}

export interface ExplorerState {
  cwd: string;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  showHidden: boolean;
  /** Currently selected tree row (posix path), or null. */
  selected: string | null;
  /** Directory paths currently expanded in the tree. */
  expanded: SvelteSet<string>;
  /** Loaded/loading children for expanded (or previously expanded) directories. */
  children: Record<string, DirNode>;
  /** Directory path currently highlighted as a drag-and-drop target, or null. */
  dropTarget: string | null;
  /** Extra selected rows for multi-select (Ctrl/Shift+click); empty or a single
   * path means "just `selected`". See lib/fileops.svelte.ts. */
  multi: string[];
  /** Paths being dragged inside the tree (pointer drag, lib/fileops), or null. */
  dragPaths: string[] | null;
}

/** One connected session's own editor tabs, active tab, and explorer state
 * (docs/GUIDE.md §11 "Workspaces"). Session-only: nothing here persists
 * across restarts. Keyed by `SessionInfo.id` in `AppState.workspaces`. */
export interface Workspace {
  tabs: Tab[];
  activeTabId: string | null;
  /** Explorer panes: one, or two when the Explorer is split (§15.3.S). */
  panes: ExplorerState[];
  /** Index into `panes` of the focused pane. Shortcuts, "Set as Explorer Root",
   * Go Up, search/disk-usage "open in explorer" and new file/folder act on it. */
  activePane: number;
  /** Share of the sidebar height given to pane 0 while split. */
  splitRatio: number;
  /** The focused pane's state (getter): all single-explorer code keeps using this. */
  readonly explorer: ExplorerState;
}

/** A fresh explorer pane rooted at `cwd` (listing not loaded yet). */
function newExplorerState(cwd: string, showHidden: boolean): ExplorerState {
  return {
    cwd,
    entries: [],
    loading: true,
    error: null,
    showHidden,
    selected: null,
    expanded: new SvelteSet<string>(),
    children: {},
    dropTarget: null,
    multi: [],
    dragPaths: null,
  };
}

const MIN_SPLIT_RATIO = 0.15;

/** Input dialog request driving `InputDialog.svelte`, created by `app.ask()`. */
export interface DialogRequest {
  id: string;
  title: string;
  message?: string;
  input?: {
    value: string;
    password?: boolean;
    selectStart?: number;
    selectEnd?: number;
    /** Returns an error message for an invalid value (shown inline, confirm disabled). */
    validate?: (value: string) => string | null;
  };
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
}

export interface AskOptions {
  title: string;
  message?: string;
  /** Present -> a text/password prompt resolving to the entered string (or
   * `null` if cancelled). Absent -> a yes/no confirm resolving to a boolean. */
  input?: {
    value?: string;
    password?: boolean;
    selectRange?: [number, number];
    /** Inline validation: an error message blocks the confirm button. */
    validate?: (value: string) => string | null;
  };
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** Tunnel-only (-N) connect hook: see `AppState.connectBackground` (§13.4.P). */
export interface BackgroundConnect {
  resolve: (info: SessionInfo | null) => void;
}

export interface PendingConnect {
  req: ConnectRequest;
  kind: ErrorKind;
  message: string;
  fingerprint?: string;
  keyPath?: string;
  /** ProxyJump hop (`user@host:port`) that raised this prompt; absent = the target (§13.4.P). */
  hop?: string;
  /** Set for a tunnel-only (-N) connect: resolves instead of opening a workspace. */
  background?: BackgroundConnect;
  /** Auto-reconnect (§13.4.A): when set, the answered prompt goes here instead
   * of starting a new `connect` flow; `onCancel` runs if the user dismisses it. */
  retry?: (req: ConnectRequest) => void | Promise<void>;
  onCancel?: () => void;
  /** Threaded through from `connect()`'s caller across however many
   * password/passphrase/host-key retries it takes, and run exactly once the
   * connect flow actually succeeds. Used by `resumeSession` to reopen tabs
   * only once there's a real session to reopen them in. */
  onSuccess?: (info: SessionInfo) => void | Promise<void>;
}

const PAUSED_SAVE_DEBOUNCE_MS = 500;

export interface ConflictState {
  tabId: string;
  path: string;
}

/** Compare-with-server diff view for one tab (§13.4.D). `serverContent` and
 * `serverMtime` come from a fresh `read_file` when the compare was opened. */
export interface CompareState {
  tabId: string;
  path: string;
  serverContent: string;
  serverMtime: number;
}

export type ToastKind = "info" | "success" | "error";

const PROMPTABLE_KINDS: ReadonlySet<ErrorKind> = new Set([
  "NeedPassword",
  "NeedPassphrase",
  "HostKeyUnknown",
  "HostKeyChanged",
]);

function errorMessage(err: unknown): string {
  return isAppError(err) ? err.message : String(err);
}

/** Best-effort classifier for "you dropped a folder, not a file" upload
 * failures. `upload` is files-only (§5.2): opening a local directory as a file
 * fails fast (before anything is written remotely), but the OS error text
 * differs by platform, so this matches on the common substrings rather than a
 * dedicated backend check. */
function isLikelyDirectoryError(err: unknown): boolean {
  if (!isAppError(err)) return false;
  if (err.kind !== "PermissionDenied" && err.kind !== "Io" && err.kind !== "Other") return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("is a directory") ||
    msg.includes("access is denied") ||
    msg.includes("incorrect function") ||
    msg.includes("os error 5") ||
    msg.includes("os error 21")
  );
}

class AppState {
  // --- sidebar ------------------------------------------------------------
  // Host state itself lives in `src/lib/hosts.svelte.ts`'s `hostStore` (a
  // single flat list of ssh-config + saved hosts) — see docs/GUIDE.md §12.
  sidebarView = $state<SidebarView | null>("hosts");
  sidebarWidth = $state(260);
  showTerminal = $state(false);

  // --- global dialogs (owned by later Phase 3 tasks; flags live here so the
  // activity bar / keyboard shortcuts wired up now have something to set) ---
  showSettings = $state(false);
  showPalette = $state(false);
  /** Drives QuickConnect's dialog so "Connection: New Connection" (command
   * palette) can open it without HostList/QuickConnect owning global state. */
  showQuickConnect = $state(false);

  // --- connect flow -------------------------------------------------------
  connecting = $state(false);
  connectTarget = $state<string | null>(null);
  pendingConnect = $state<PendingConnect | null>(null);

  // --- sessions / workspaces (§11 "Workspaces") -----------------------------
  sessions = $state<SessionInfo[]>([]);
  activeSessionId = $state<string | null>(null);
  /** One workspace (tabs + active tab + explorer) per connected session. */
  workspaces = $state<Record<string, Workspace>>({});
  /** The (sanitized — never a password/passphrase) `ConnectRequest` that
   * produced each live session, kept around only so `pauseSession` has
   * something to snapshot and reconnect with later. */
  private connectRequests: Record<string, ConnectRequest> = {};

  // --- auto-reconnect plumbing (§13.4.A; the engine is lib/reconnect.svelte.ts) ---
  /** Session ids closed on purpose (disconnect / pause): their `session://closed` is not a drop. */
  private closing = new Set<string>();
  /** Tunnel-only (-N) sessions (no workspace) with what is needed to reconnect them. */
  private backgroundSessions: Record<string, { req: ConnectRequest; label: string }> = {};
  /** Set by the reconnect engine: returns true if it took over a dropped session. */
  reconnectHandler: ((payload: SessionClosedEvent) => boolean) | null = null;
  /** Set by the reconnect engine: true while a dropped session is being reconnected. */
  isSessionReconnecting: (sessionId: string) => boolean = () => false;
  private dropHooks: Array<(oldId: string) => void> = [];
  private remapHooks: Array<(oldId: string, newId: string) => void | Promise<void>> = [];
  private lostHooks: Array<(sessionId: string) => void> = [];

  // --- paused sessions (§12, "Pause session") -------------------------------
  pausedSessions = $state<PausedSession[]>([]);
  private pausedSaveTimer?: ReturnType<typeof setTimeout>;

  // --- editor tabs (per active workspace) ------------------------------------
  conflict = $state<ConflictState | null>(null);
  /** Open diff views by tab id (§13.4.D). Editor.svelte shows DiffView for the active tab's entry. */
  compare = $state<Record<string, CompareState>>({});

  // --- generic input/confirm dialog ------------------------------------------
  dialogRequest = $state<DialogRequest | null>(null);
  private dialogResolve: ((value: string | boolean | null) => void) | null = null;

  get activeSession(): SessionInfo | null {
    return this.sessions.find((s) => s.id === this.activeSessionId) ?? null;
  }

  get activeWorkspace(): Workspace | null {
    return this.activeSessionId ? (this.workspaces[this.activeSessionId] ?? null) : null;
  }

  get activeExplorer(): ExplorerState | null {
    return this.activeWorkspace?.explorer ?? null;
  }

  get activeTab(): Tab | null {
    const ws = this.activeWorkspace;
    return ws ? (ws.tabs.find((t) => t.id === ws.activeTabId) ?? null) : null;
  }

  /** Every workspace's tabs are only ever touched by `sessionId`- or
   * `tabId`-scoped methods below — this just locates the tab (and its
   * owning workspace) wherever it lives, for the handful of callers
   * (`saveTab`, `closeTab`, conflict resolution…) that only have a `tabId`. */
  private findTab(tabId: string): Tab | null {
    for (const ws of Object.values(this.workspaces)) {
      const tab = ws.tabs.find((t) => t.id === tabId);
      if (tab) return tab;
    }
    return null;
  }

  /** Sets the active tab within the *active* workspace. Use this instead of
   * mutating `app.activeWorkspace.activeTabId` directly from components. */
  setActiveTab(tabId: string): void {
    const ws = this.activeWorkspace;
    if (ws && ws.tabs.some((t) => t.id === tabId)) {
      ws.activeTabId = tabId;
      this.touchTab(this.activeSessionId, tabId);
    }
  }

  // --- tab MRU + recently-closed stack (§13.4.K) ------------------------------

  /** Per-session tab ids, most recently focused first. May be stale/partial:
   * read it only through `mruTabs()`. */
  tabMru = $state<Record<string, string[]>>({});
  /** Per-session stack (last = most recent) of closed file tabs. */
  closedTabs = $state<Record<string, { path: string; line: number; col: number }[]>>({});

  /** Marks `tabId` as the most recently used tab of `sessionId`'s workspace. */
  touchTab(sessionId: string | null, tabId: string): void {
    if (!sessionId) return;
    this.tabMru[sessionId] = [tabId, ...(this.tabMru[sessionId] ?? []).filter((id) => id !== tabId)];
  }

  /** The workspace's tabs ordered by last focus (active first). Tabs never
   * recorded (e.g. activated by direct assignment) keep strip order at the end. */
  mruTabs(sessionId: string): Tab[] {
    const ws = this.workspaces[sessionId];
    if (!ws) return [];
    const order = [ws.activeTabId, ...(this.tabMru[sessionId] ?? [])];
    const out: Tab[] = [];
    for (const id of order) {
      const t = id ? ws.tabs.find((x) => x.id === id) : undefined;
      if (t && !out.includes(t)) out.push(t);
    }
    for (const t of ws.tabs) if (!out.includes(t)) out.push(t);
    return out;
  }

  /** Reopens the most recently closed file tab of the active workspace
   * (skips files that are already open again). Returns whether one opened. */
  async reopenClosedTab(): Promise<boolean> {
    const sid = this.activeSessionId;
    if (!sid || !this.sessions.some((s) => s.id === sid)) return false;
    const stack = this.closedTabs[sid];
    while (stack && stack.length > 0) {
      const entry = stack.pop()!;
      const ws = this.workspaces[sid];
      if (!ws || ws.tabs.some((t) => t.path === entry.path)) continue;
      await this.openFile(sid, entry.path);
      const t = this.workspaces[sid]?.tabs.find((x) => x.path === entry.path);
      if (t) {
        t.line = entry.line;
        t.col = entry.col;
      }
      return true;
    }
    return false;
  }

  // --- toasts (shadcn `sonner`; see components/ui/sonner's <Toaster/> in
  // App.svelte) ------------------------------------------------------------

  /** The one API every other module uses to show a toast — unchanged from
   * before the sonner migration, so callers never import `svelte-sonner`
   * directly. */
  addToast(kind: ToastKind, message: string): void {
    if (kind === "success") toast.success(message);
    else if (kind === "error") toast.error(message);
    else toast.info(message);
  }

  // --- generic input/confirm dialog -------------------------------------

  /** Replaces every `window.prompt`/`window.confirm` in the app. With
   * `opts.input`, shows a text/password field and resolves to the entered
   * string, or `null` if cancelled. Without it, shows a yes/no confirm and
   * resolves to a boolean. Enter confirms, Esc cancels. */
  ask(opts: AskOptions & { input: NonNullable<AskOptions["input"]> }): Promise<string | null>;
  ask(opts: AskOptions & { input?: undefined }): Promise<boolean>;
  ask(opts: AskOptions): Promise<string | boolean | null> {
    return new Promise((resolve) => {
      // Only one dialog at a time; cancel whatever was pending.
      this.dialogResolve?.(opts.input ? null : false);
      this.dialogResolve = resolve;
      this.dialogRequest = {
        id: crypto.randomUUID(),
        title: opts.title,
        message: opts.message,
        input: opts.input
          ? {
              value: opts.input.value ?? "",
              password: opts.input.password,
              selectStart: opts.input.selectRange?.[0],
              selectEnd: opts.input.selectRange?.[1],
              validate: opts.input.validate,
            }
          : undefined,
        confirmLabel: opts.confirmLabel ?? (opts.input ? "OK" : "Confirm"),
        cancelLabel: opts.cancelLabel ?? "Cancel",
        danger: opts.danger,
      };
    });
  }

  /** Called by `InputDialog.svelte` when the user confirms or cancels. */
  resolveDialog(value: string | boolean | null): void {
    const resolve = this.dialogResolve;
    this.dialogResolve = null;
    this.dialogRequest = null;
    resolve?.(value);
  }

  // --- connect flow ---------------------------------------------------------

  /** `onSuccess`, if given, runs exactly once — the moment this connect flow
   * actually succeeds, however many password/passphrase/host-key retries
   * that takes (each retry re-enters `connect` via `submitConnectPrompt`,
   * which threads it along). `resumeSession` uses this to reopen tabs only
   * once there's a real session to reopen them in. */
  async connect(
    req: ConnectRequest,
    targetLabel: string,
    onSuccess?: (info: SessionInfo) => void | Promise<void>,
    background?: BackgroundConnect,
  ): Promise<void> {
    this.connecting = true;
    this.connectTarget = targetLabel;
    try {
      const info = await api.connect(req);
      if (background) {
        // Tunnel-only (-N): a live backend session, but no workspace/explorer/tabs.
        this.pendingConnect = null;
        touchSavedHost(info.user, info.hostname, req.port ?? 22);
        this.backgroundSessions[info.id] = { req, label: targetLabel };
        background.resolve(info);
        return;
      }
      this.sessions.push(info);
      this.activeSessionId = info.id;
      this.pendingConnect = null;
      this.sidebarView = "explorer";
      this.connectRequests[info.id] = req;
      // Connecting never creates or modifies a saved host — it only bumps
      // `lastUsed` on one that already matches these connection fields, if
      // any (docs/GUIDE.md §12 hosts redesign).
      touchSavedHost(info.user, info.hostname, req.port ?? 22);
      await this.initExplorer(info);
      if (onSuccess) await onSuccess(info);
    } catch (err) {
      if (isAppError(err) && PROMPTABLE_KINDS.has(err.kind)) {
        this.pendingConnect = {
          req,
          kind: err.kind,
          message: err.message,
          fingerprint: err.fingerprint,
          keyPath: err.keyPath,
          hop: err.hop,
          background,
          onSuccess,
        };
        return; // keep connecting=true/connectTarget: dialog is now the UI
      }
      this.addToast("error", errorMessage(err));
      this.connectTarget = null;
      background?.resolve(null);
    } finally {
      if (!this.pendingConnect) this.connecting = false;
    }
  }

  /** Called by PromptDialog with the field(s) it collected; retries `connect`. */
  async submitConnectPrompt(fields: Partial<ConnectRequest>): Promise<void> {
    const pending = this.pendingConnect;
    if (!pending) return;
    // A prompt raised by a ProxyJump hop stores its answer under that hop (§13.4.P).
    const merged: ConnectRequest = pending.hop
      ? {
          ...pending.req,
          jumpAuth: {
            ...pending.req.jumpAuth,
            [pending.hop]: { ...pending.req.jumpAuth?.[pending.hop], ...fields },
          },
        }
      : { ...pending.req, ...fields };
    this.pendingConnect = null;
    if (pending.retry) {
      await pending.retry(merged);
      return;
    }
    await this.connect(
      merged,
      this.connectTarget ?? merged.alias ?? merged.hostname ?? "",
      pending.onSuccess,
      pending.background,
    );
  }

  /** Tunnel-only (-N) connect for the Ports feature: same prompts (password /
   * passphrase / host key, incl. per-hop ProxyJump prompts) as `connect`, but
   * no workspace is created. Resolves the live `SessionInfo`, or `null` if the
   * user cancelled or the connect failed (a toast was shown). */
  connectBackground(req: ConnectRequest, targetLabel: string): Promise<SessionInfo | null> {
    return new Promise((resolve) => {
      void this.connect(req, targetLabel, undefined, { resolve });
    });
  }

  cancelConnectPrompt(): void {
    this.pendingConnect?.background?.resolve(null);
    this.pendingConnect?.onCancel?.();
    this.pendingConnect = null;
    this.connectTarget = null;
    this.connecting = false;
  }

  // --- sessions / workspaces / explorer ---------------------------------------

  /** Creates the new session's workspace (empty tabs, root explorer listing
   * loading) and loads its root listing. */
  async initExplorer(info: SessionInfo): Promise<void> {
    this.workspaces[info.id] = {
      tabs: [],
      activeTabId: null,
      panes: [newExplorerState(info.home, settings.files.showHidden)],
      activePane: 0,
      splitRatio: 0.5,
      get explorer(): ExplorerState {
        return this.panes[this.activePane] ?? this.panes[0];
      },
    };
    await this.refreshExplorer(info.id);
  }

  /** Explorer pane `pane` of a workspace; without `pane` the focused one. */
  paneState(sessionId: string, pane?: number): ExplorerState | undefined {
    const ws = this.workspaces[sessionId];
    if (!ws) return undefined;
    return pane === undefined ? ws.explorer : ws.panes[pane];
  }

  /** Reloads an explorer pane's root listing (its `cwd`; the focused pane unless
   * `pane` is given). Nested expanded nodes are untouched — see `refreshDir`
   * for refreshing just one directory. */
  async refreshExplorer(sessionId: string, path?: string, pane?: number): Promise<void> {
    const ex = this.paneState(sessionId, pane);
    if (!ex) return;
    const target = path ?? ex.cwd;
    const navigated = target !== ex.cwd;
    const token = nextListToken(ex, "\0root");
    const hadListing = !ex.error;
    ex.loading = true;
    ex.error = null;
    try {
      const entries = await api.listDir(sessionId, target);
      if (!isLatestList(ex, "\0root", token)) return; // a newer navigation / refresh won
      ex.cwd = target;
      ex.entries = entries;
      if (navigated) {
        // The tree root changed: nested expand/selection state no longer applies.
        ex.expanded.clear();
        ex.children = {};
        ex.selected = null;
        ex.multi = [];
      }
    } catch (err) {
      if (!isLatestList(ex, "\0root", token)) return;
      if (navigated && hadListing) {
        // Keep showing the folder we were in; say why the new one did not open
        // (not while reconnecting: every call fails then, the banner explains it).
        if (!this.isSessionReconnecting(sessionId)) {
          this.addToast("error", `Cannot open ${target}: ${errorMessage(err)}`);
        }
      } else {
        ex.error = errorMessage(err);
      }
    } finally {
      if (isLatestList(ex, "\0root", token)) ex.loading = false;
    }
  }

  /** Reloads the root listing of every pane (F5, reconnect). */
  async refreshAllPanes(sessionId: string): Promise<void> {
    const n = this.workspaces[sessionId]?.panes.length ?? 0;
    await Promise.all(Array.from({ length: n }, (_, i) => this.refreshExplorer(sessionId, undefined, i)));
  }

  navigateExplorer(sessionId: string, path: string, pane?: number): Promise<void> {
    return this.refreshExplorer(sessionId, path, pane);
  }

  toggleHidden(sessionId: string, pane?: number): void {
    const ex = this.paneState(sessionId, pane);
    if (ex) ex.showHidden = !ex.showHidden;
  }

  selectPath(sessionId: string, path: string | null, pane?: number): void {
    const ex = this.paneState(sessionId, pane);
    if (ex) {
      ex.selected = path;
      ex.multi = [];
    }
  }

  /** Finds a `FileEntry` by path among the root listing or any loaded child node
   * of any pane (the focused pane's own listing first). */
  findEntry(sessionId: string, path: string): FileEntry | null {
    const ws = this.workspaces[sessionId];
    if (!ws) return null;
    for (const ex of [ws.explorer, ...ws.panes.filter((p) => p !== ws.explorer)]) {
      const root = ex.entries.find((e) => e.path === path);
      if (root) return root;
      for (const node of Object.values(ex.children)) {
        const found = node.entries?.find((e) => e.path === path);
        if (found) return found;
      }
    }
    return null;
  }

  private async loadDirNode(sessionId: string, path: string, pane?: number): Promise<void> {
    const ex = this.paneState(sessionId, pane);
    if (!ex) return;
    const token = nextListToken(ex, path);
    ex.children[path] = { entries: ex.children[path]?.entries ?? null, loading: true, error: null };
    try {
      const entries = await api.listDir(sessionId, path);
      if (isLatestList(ex, path, token)) ex.children[path] = { entries, loading: false, error: null };
    } catch (err) {
      if (isLatestList(ex, path, token)) ex.children[path] = { entries: null, loading: false, error: errorMessage(err) };
    }
  }

  async expandDir(sessionId: string, path: string, pane?: number): Promise<void> {
    const ws = this.workspaces[sessionId];
    const ex = this.paneState(sessionId, pane);
    if (!ws || !ex) return;
    ex.expanded.add(path);
    if (!ex.children[path]) {
      await this.loadDirNode(sessionId, path, pane ?? ws.activePane);
    }
  }

  collapseDir(sessionId: string, path: string, pane?: number): void {
    this.paneState(sessionId, pane)?.expanded.delete(path);
  }

  async toggleExpandDir(sessionId: string, path: string, pane?: number): Promise<void> {
    const ex = this.paneState(sessionId, pane);
    if (!ex) return;
    if (ex.expanded.has(path)) {
      this.collapseDir(sessionId, path, pane);
    } else {
      await this.expandDir(sessionId, path, pane);
    }
  }

  /** Refreshes just the directory affected by a mutation (create/rename/
   * delete/upload) in every pane: the root listing if it's a pane's `cwd`, or a
   * loaded/expanded child node otherwise. Never collapses the rest of the tree. */
  async refreshDir(sessionId: string, dirPath: string): Promise<void> {
    const ws = this.workspaces[sessionId];
    if (!ws) return;
    await Promise.all(
      ws.panes.map(async (ex, i) => {
        if (dirPath === ex.cwd) {
          await this.refreshExplorer(sessionId, undefined, i);
        } else if (ex.expanded.has(dirPath) || ex.children[dirPath]) {
          await this.loadDirNode(sessionId, dirPath, i);
        }
      }),
    );
  }

  // --- split explorer (§15.3.S) -----------------------------------------------

  /** True when the Explorer shows two panes. */
  isExplorerSplit(sessionId: string): boolean {
    return (this.workspaces[sessionId]?.panes.length ?? 1) > 1;
  }

  /** Makes pane `i` the focused one (no-op for an unknown index). */
  setActivePane(sessionId: string, i: number): void {
    const ws = this.workspaces[sessionId];
    if (ws && i !== ws.activePane && ws.panes[i]) ws.activePane = i;
  }

  /** Splits the Explorer: a second pane rooted at `cwd` (default: the focused
   * pane's root, with its expanded folders). The new pane becomes the focused one. */
  async splitExplorer(sessionId: string, cwd?: string): Promise<void> {
    const ws = this.workspaces[sessionId];
    if (!ws || ws.panes.length > 1) return;
    const src = ws.explorer;
    const pane = newExplorerState(cwd ?? src.cwd, src.showHidden);
    if (cwd === undefined || cwd === src.cwd) {
      for (const p of src.expanded) pane.expanded.add(p);
      pane.children = $state.snapshot(src.children) as ExplorerState["children"];
      pane.entries = $state.snapshot(src.entries) as FileEntry[];
      pane.loading = false;
    }
    ws.panes.push(pane);
    ws.activePane = 1;
    ws.splitRatio = 0.5;
    if (ws.panes[1].loading) await this.refreshExplorer(sessionId, undefined, 1);
  }

  /** Closes the split, keeping pane `keep` (default: the focused one). */
  closeExplorerSplit(sessionId: string, keep?: number): void {
    const ws = this.workspaces[sessionId];
    if (!ws || ws.panes.length < 2) return;
    const kept = ws.panes[keep ?? ws.activePane] ?? ws.explorer;
    for (const p of ws.panes) {
      p.dragPaths = null;
      p.dropTarget = null;
    }
    ws.panes = [kept];
    ws.activePane = 0;
  }

  setSplitRatio(sessionId: string, ratio: number): void {
    const ws = this.workspaces[sessionId];
    if (ws) ws.splitRatio = Math.min(1 - MIN_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
  }

  /** "Open in Other Pane": roots the other pane at `path` and focuses it
   * (splitting first when the Explorer is not split). */
  async openInOtherPane(sessionId: string, path: string, fromPane?: number): Promise<void> {
    const ws = this.workspaces[sessionId];
    if (!ws) return;
    if (ws.panes.length < 2) {
      await this.splitExplorer(sessionId, path);
      return;
    }
    const from = fromPane ?? ws.activePane;
    const other = from === 0 ? 1 : 0;
    ws.activePane = other;
    await this.refreshExplorer(sessionId, path, other);
  }

  // --- explorer file mutations (create/rename/delete/upload/copy) -----------

  /** Directory a keyboard/toolbar "New file/folder" targets: the selected row
   * if it's a directory, the selected file's parent, else the explorer cwd. */
  newEntryDir(sessionId: string, pane?: number): string | null {
    const ex = this.paneState(sessionId, pane);
    if (!ex) return null;
    const sel = ex.selected ? this.findEntry(sessionId, ex.selected) : null;
    if (!sel) return ex.cwd;
    if (sel.kind === "dir" || (sel.kind === "symlink" && sel.linkTargetIsDir === true)) return sel.path;
    return dirname(sel.path);
  }

  /** Makes a freshly created entry visible: refreshes (and expands, if it's
   * not the explorer root) its parent, then selects it. */
  private async revealCreated(sessionId: string, dirPath: string, path: string): Promise<void> {
    const ex = this.workspaces[sessionId]?.explorer;
    if (!ex) return;
    if (dirPath !== ex.cwd && !ex.expanded.has(dirPath)) {
      ex.expanded.add(dirPath);
      await this.loadDirNode(sessionId, dirPath, this.workspaces[sessionId]?.activePane);
    } else {
      await this.refreshDir(sessionId, dirPath);
    }
    this.selectPath(sessionId, path);
  }

  /** Set by lib/fileops.svelte.ts: records a created file/folder on the explorer's undo stack. */
  onEntryCreated: ((sessionId: string, path: string, kind: "file" | "dir") => void) | null = null;

  async createFileIn(sessionId: string, dirPath: string): Promise<void> {
    const name = (
      await this.ask({
        title: "New file",
        message: dirPath,
        input: { validate: (v) => validateEntryName(v, true) },
        confirmLabel: "Create",
      })
    )?.trim();
    if (!name || validateEntryName(name, true) || !this.workspaces[sessionId]) return;
    const path = join(dirPath, name);
    try {
      await api.createFile(sessionId, path);
    } catch (err) {
      this.addToast("error", errorMessage(err));
      return;
    }
    this.onEntryCreated?.(sessionId, path, "file");
    await this.revealCreated(sessionId, dirPath, path);
    await this.openFile(sessionId, path);
  }

  async createFolderIn(sessionId: string, dirPath: string): Promise<void> {
    const name = (
      await this.ask({
        title: "New folder",
        message: dirPath,
        input: { validate: (v) => validateEntryName(v, true) },
        confirmLabel: "Create",
      })
    )?.trim();
    if (!name || validateEntryName(name, true) || !this.workspaces[sessionId]) return;
    const path = join(dirPath, name);
    try {
      await api.createDir(sessionId, path);
    } catch (err) {
      this.addToast("error", errorMessage(err));
      return;
    }
    this.onEntryCreated?.(sessionId, path, "dir");
    await this.revealCreated(sessionId, dirPath, path);
  }

  async copyPath(path: string): Promise<void> {
    try {
      await clipboardWrite(path);
      this.addToast("info", "Path copied");
    } catch {
      this.addToast("error", "Clipboard access denied");
    }
  }

  /** Uploads files and folders dropped from Windows Explorer (or picked via
   * "Upload here…") as one transfer job (docs/GUIDE.md §13.4.S). */
  async uploadDroppedFiles(
    sessionId: string,
    localPaths: string[],
    remoteDir: string,
  ): Promise<void> {
    if (localPaths.length === 0) return;
    try {
      const { startUpload } = await import("./transfers.svelte");
      await startUpload(sessionId, localPaths, remoteDir);
    } catch (err) {
      this.addToast("error", `Upload failed: ${errorMessage(err)}`);
    }
  }

  setActiveSession(sessionId: string): void {
    if (this.sessions.some((s) => s.id === sessionId)) {
      this.activeSessionId = sessionId;
      this.sidebarView = "explorer";
    }
  }

  /** User-initiated disconnect: confirms first if the session's workspace has
   * unsaved tabs (its whole workspace — tabs included — is discarded). */
  async disconnectSession(sessionId: string): Promise<void> {
    const dirtyCount =
      this.workspaces[sessionId]?.tabs.filter((t) => t.doc !== t.savedDoc).length ?? 0;
    if (dirtyCount > 0) {
      const ok = await this.ask({
        title: "Unsaved changes",
        message: `This session has ${dirtyCount} file${dirtyCount === 1 ? "" : "s"} with unsaved changes. Disconnect anyway?`,
        confirmLabel: "Disconnect anyway",
        danger: true,
      });
      if (!ok) return;
      // Dropped (or already disconnected) while the dialog was open.
      if (!this.sessions.some((s) => s.id === sessionId)) return;
    }
    this.closing.add(sessionId);
    try {
      await api.disconnect(sessionId);
    } catch (err) {
      this.addToast("error", errorMessage(err));
    }
    this.dropSession(sessionId);
  }

  /** Common cleanup for both a user-initiated disconnect and a server-side
   * close: drops the session's whole workspace (tabs, active tab, explorer). */
  private dropSession(sessionId: string): void {
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    // Conflict dialog / diff views pointing at this workspace's tabs would be stuck.
    const tabIds = new Set((this.workspaces[sessionId]?.tabs ?? []).map((t) => t.id));
    if (this.conflict && tabIds.has(this.conflict.tabId)) this.conflict = null;
    for (const id of Object.keys(this.compare)) if (tabIds.has(id)) delete this.compare[id];
    delete this.tabMru[sessionId];
    delete this.closedTabs[sessionId];
    const { [sessionId]: _removed, ...rest } = this.workspaces;
    this.workspaces = rest;
    delete this.connectRequests[sessionId];
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions[0]?.id ?? null;
      if (!this.activeSessionId) this.sidebarView = "hosts";
    }
    this.fireLost(sessionId);
  }

  /** Server-side close: never prompts (the connection is already gone). With
   * auto-reconnect on, the workspace is kept and the engine takes over
   * (§13.4.A); a close the user asked for is ignored here. */
  handleSessionClosed(payload: SessionClosedEvent): void {
    const id = payload.sessionId;
    if (this.closing.has(id)) return;
    const known = this.sessions.some((s) => s.id === id);
    const background = id in this.backgroundSessions;
    if (!known && !background) return;
    if (this.reconnectHandler?.(payload)) return;
    if (!known) {
      delete this.backgroundSessions[id];
      this.fireLost(id);
      return;
    }
    this.dropSession(id);
    this.addToast("error", `Session closed: ${payload.reason}`);
  }

  // --- auto-reconnect support (§13.4.A) ---------------------------------------

  /** The `ConnectRequest` (secrets included, memory only) behind a live session. */
  requestFor(sessionId: string): ConnectRequest | undefined {
    return this.connectRequests[sessionId] ?? this.backgroundSessions[sessionId]?.req;
  }

  backgroundInfo(sessionId: string): { req: ConnectRequest; label: string } | undefined {
    return this.backgroundSessions[sessionId];
  }

  backgroundIds(): string[] {
    return Object.keys(this.backgroundSessions);
  }

  /** A tunnel-only session was released on purpose (no reconnect for it). */
  releaseBackground(sessionId: string): void {
    this.closing.add(sessionId);
    if (delete this.backgroundSessions[sessionId]) this.fireLost(sessionId);
  }

  /** Subscriptions for stores keyed by session id: the connection dropped and
   * a reconnect is starting / it came back as a new id / the session is gone for good. */
  onSessionDrop(cb: (oldId: string) => void): void {
    this.dropHooks.push(cb);
  }
  onSessionRemap(cb: (oldId: string, newId: string) => void | Promise<void>): void {
    this.remapHooks.push(cb);
  }
  onSessionLost(cb: (sessionId: string) => void): void {
    this.lostHooks.push(cb);
  }

  fireDrop(oldId: string): void {
    for (const cb of this.dropHooks) {
      try {
        cb(oldId);
      } catch (err) {
        console.error("session drop hook failed", err);
      }
    }
  }

  private fireLost(sessionId: string): void {
    for (const cb of this.lostHooks) {
      try {
        cb(sessionId);
      } catch (err) {
        console.error("session lost hook failed", err);
      }
    }
  }

  /** Rebinds a dropped session's workspace (tabs, explorer, MRU, active id) to
   * the freshly connected backend session `info`, runs the remap hooks (terminals,
   * forwards, monitor, logs), then refreshes the explorer and clean tabs. Dirty
   * tabs stay dirty; the save-conflict check still applies. */
  async remapSession(oldId: string, info: SessionInfo, req: ConnectRequest): Promise<void> {
    const newId = info.id;
    const idx = this.sessions.findIndex((s) => s.id === oldId);
    if (idx >= 0) this.sessions[idx] = info;
    const ws = this.workspaces[oldId];
    if (ws) {
      for (const t of ws.tabs) t.sessionId = newId;
      const { [oldId]: _moved, ...rest } = this.workspaces;
      this.workspaces = { ...rest, [newId]: ws };
    }
    if (this.tabMru[oldId]) {
      this.tabMru[newId] = this.tabMru[oldId];
      delete this.tabMru[oldId];
    }
    if (this.closedTabs[oldId]) {
      this.closedTabs[newId] = this.closedTabs[oldId];
      delete this.closedTabs[oldId];
    }
    if (this.activeSessionId === oldId) this.activeSessionId = newId;
    if (oldId in this.backgroundSessions) {
      this.backgroundSessions[newId] = { ...this.backgroundSessions[oldId], req };
      delete this.backgroundSessions[oldId];
    } else {
      this.connectRequests[newId] = req;
    }
    delete this.connectRequests[oldId];
    const hooks = this.remapHooks.map(async (cb) => {
      try {
        await cb(oldId, newId);
      } catch (err) {
        console.error("session remap hook failed", err);
      }
    });
    await Promise.all([...hooks, this.refreshAfterReconnect(newId)]);
  }

  /** Reloads the explorer (root + expanded dirs) and silently reloads clean
   * tabs whose remote mtime changed while we were offline. */
  private async refreshAfterReconnect(sessionId: string): Promise<void> {
    const ws = this.workspaces[sessionId];
    if (!ws) return;
    await this.refreshAllPanes(sessionId);
    await Promise.allSettled(ws.panes.flatMap((p) => [...p.expanded]).map((d) => this.refreshDir(sessionId, d)));
    await Promise.allSettled(
      ws.tabs.map(async (tab) => {
        if (tab.doc !== tab.savedDoc || tab.loading || tab.missing || tab.error) return;
        try {
          const st = await api.stat(sessionId, tab.path);
          if (st.mtime === tab.mtime || tab.doc !== tab.savedDoc) return;
          const content = await api.readFile(sessionId, tab.path);
          if (tab.doc !== tab.savedDoc) return; // edited meanwhile: keep the user's text
          tab.doc = content.content;
          tab.savedDoc = content.content;
          tab.mtime = content.mtime;
          tab.isBinary = content.isBinary;
        } catch {
          /* gone or unreadable: leave the tab as it was */
        }
      }),
    );
  }

  // --- paused sessions (docs/GUIDE.md §12, "Pause session") -------------------

  private schedulePausedSave(): void {
    if (this.pausedSaveTimer) clearTimeout(this.pausedSaveTimer);
    this.pausedSaveTimer = setTimeout(() => {
      api.saveStore("paused", $state.snapshot(this.pausedSessions)).catch((err) => {
        this.addToast("error", `Could not save paused sessions: ${errorMessage(err)}`);
      });
    }, PAUSED_SAVE_DEBOUNCE_MS);
  }

  /** Loads paused-session snapshots persisted from a previous run. Never
   * throws — a missing/corrupt store just leaves the list empty. Called once
   * at module load, below (there's no dedicated Phase 4 startup file this
   * module owns to call it from). */
  async loadPausedSessions(): Promise<void> {
    try {
      const stored = await api.loadStore<PausedSession[]>("paused");
      if (Array.isArray(stored)) this.pausedSessions.splice(0, this.pausedSessions.length, ...stored);
    } catch (err) {
      console.error("Failed to load paused sessions, starting empty", err);
    }
  }

  /** Pause: snapshot the workspace (open tabs in order, the active one,
   * unsaved content per dirty tab, explorer cwd + expanded dirs, and the
   * connect request minus any password/passphrase), persist it, then
   * disconnect — no dirty-confirm, since every dirty tab's content is
   * already captured in the snapshot. */
  async pauseSession(sessionId: string): Promise<void> {
    const session = this.sessions.find((s) => s.id === sessionId);
    const ws = this.workspaces[sessionId];
    const req = this.connectRequests[sessionId];
    if (!session || !ws || !req) return;

    const { password: _password, passphrase: _passphrase, jumpAuth: _jumpAuth, ...sanitizedReq } = req;
    const activeTab = ws.tabs.find((t) => t.id === ws.activeTabId);
    const paused: PausedSession = {
      id: crypto.randomUUID(),
      label: session.label,
      request: sanitizedReq,
      tabs: ws.tabs.map((t) => {
        const dirty = t.doc !== t.savedDoc;
        return { path: t.path, dirty, doc: dirty ? t.doc : null };
      }),
      activeTabPath: activeTab?.path ?? null,
      cwd: ws.panes[0].cwd,
      expandedDirs: [...ws.panes[0].expanded],
      pausedAt: Date.now(),
      ...(ws.panes.length > 1
        ? {
            split: {
              cwd: ws.panes[1].cwd,
              expandedDirs: [...ws.panes[1].expanded],
              active: ws.activePane,
              ratio: ws.splitRatio,
            },
          }
        : {}),
    };
    this.pausedSessions.push(paused);
    this.schedulePausedSave();

    this.closing.add(sessionId);
    try {
      await api.disconnect(sessionId);
    } catch (err) {
      this.addToast("error", errorMessage(err));
    }
    this.dropSession(sessionId);
  }

  /** Resume: connects (the normal password/passphrase/host-key prompts
   * apply), then reopens tabs in order, restores the active tab/cwd/expanded
   * dirs, and re-applies any unsaved content as dirty. The paused snapshot is
   * removed up front — if the connect is cancelled or fails, nothing reopens,
   * but re-pausing is one click away, and silently resurrecting a snapshot
   * whose connect attempt failed is more surprising than losing it. */
  async resumeSession(pausedId: string): Promise<void> {
    const paused = this.pausedSessions.find((p) => p.id === pausedId);
    if (!paused) return;
    this.pausedSessions = this.pausedSessions.filter((p) => p.id !== pausedId);
    this.schedulePausedSave();

    await this.connect(paused.request, paused.label, async (info) => {
      for (const tab of paused.tabs) {
        await this.resumeTab(info.id, tab);
      }
      const ws = this.workspaces[info.id];
      if (!ws) return;
      if (paused.activeTabPath) {
        const active = ws.tabs.find((t) => t.path === paused.activeTabPath);
        if (active) ws.activeTabId = active.id;
      }
      await this.refreshExplorer(info.id, paused.cwd, 0);
      for (const dir of paused.expandedDirs) {
        await this.expandDir(info.id, dir, 0);
      }
      if (paused.split) {
        await this.splitExplorer(info.id, paused.split.cwd);
        for (const dir of paused.split.expandedDirs) {
          await this.expandDir(info.id, dir, 1);
        }
        this.setSplitRatio(info.id, paused.split.ratio);
        this.setActivePane(info.id, paused.split.active === 0 ? 0 : 1);
      }
    });
  }

  /** Reopens one paused tab: a plain `read_file` for a clean tab (identical
   * to a normal open), but for a dirty one, the freshly-read server content
   * becomes `savedDoc` while the snapshot's content is restored as `doc` — so
   * the tab comes back exactly as dirty as it was. `NotFound` (the file was
   * deleted while paused) keeps the tab instead of failing it: whatever
   * content the snapshot had (if any) becomes both `doc` and `savedDoc`, and
   * `missing` is set for Editor.svelte's warning banner. */
  private async resumeTab(sessionId: string, saved: PausedTab): Promise<void> {
    const ws = this.workspaces[sessionId];
    if (!ws) return;
    const tab: Tab = {
      id: crypto.randomUUID(),
      sessionId,
      path: saved.path,
      doc: "",
      savedDoc: "",
      mtime: 0,
      language: languageName(saved.path),
      isBinary: false,
      tooLarge: false,
      forceOpen: false,
      loading: true,
      saving: false,
      error: null,
      line: 1,
      col: 1,
    };
    ws.tabs.push(tab);
    try {
      const content = await api.readFile(sessionId, saved.path);
      const t = ws.tabs.find((x) => x.id === tab.id);
      if (!t) return; // closed while loading
      t.savedDoc = content.content;
      t.doc = saved.dirty && saved.doc !== null ? saved.doc : content.content;
      t.mtime = content.mtime;
      t.isBinary = content.isBinary;
    } catch (err) {
      const t = ws.tabs.find((x) => x.id === tab.id);
      if (!t) return;
      if (isAppError(err) && err.kind === "NotFound") {
        t.missing = true;
        if (saved.doc !== null) {
          t.doc = saved.doc;
          t.savedDoc = saved.doc;
        }
      } else {
        t.error = errorMessage(err);
        t.tooLarge = isAppError(err) && err.kind === "TooLarge";
      }
    } finally {
      const t = ws.tabs.find((x) => x.id === tab.id);
      if (t) t.loading = false;
    }
  }

  /** Discards a paused session without ever reconnecting. */
  discardPausedSession(pausedId: string): void {
    const before = this.pausedSessions.length;
    this.pausedSessions = this.pausedSessions.filter((p) => p.id !== pausedId);
    if (this.pausedSessions.length !== before) this.schedulePausedSave();
  }

  // --- editor tabs (per-workspace) ------------------------------------------

  /** Opens `path` as a tab in `sessionId`'s workspace (creating the tab if
   * it isn't already open there) and makes it that workspace's active tab.
   * Note this does *not* switch `activeSessionId` — call `setActiveSession`
   * first if the caller isn't already viewing that session. */
  async openFile(sessionId: string, path: string): Promise<void> {
    const ws = this.workspaces[sessionId];
    if (!ws) return;
    const existing = ws.tabs.find((t) => t.path === path);
    if (existing) {
      ws.activeTabId = existing.id;
      this.touchTab(sessionId, existing.id);
      return;
    }
    const known = this.findEntry(sessionId, path);
    if (known && known.kind === "file" && known.size > LARGE_FILE_BYTES) {
      const ok = await this.ask({
        title: "Large file",
        message: `"${basename(path)}" is ${(known.size / 1024 / 1024).toFixed(1)} MB. Opening it loads the whole file into the editor, which can be slow. Open anyway?`,
        confirmLabel: "Open",
      });
      if (!ok || this.workspaces[sessionId] !== ws) return;
      const again = ws.tabs.find((t) => t.path === path); // opened meanwhile
      if (again) {
        ws.activeTabId = again.id;
        return;
      }
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      sessionId,
      path,
      doc: "",
      savedDoc: "",
      mtime: 0,
      language: languageName(path),
      isBinary: false,
      tooLarge: false,
      forceOpen: false,
      loading: true,
      saving: false,
      error: null,
      line: 1,
      col: 1,
    };
    ws.tabs.push(tab);
    ws.activeTabId = tab.id;
    this.touchTab(sessionId, tab.id);
    try {
      const content = await api.readFile(sessionId, path);
      const t = ws.tabs.find((x) => x.id === tab.id);
      if (!t) return; // closed while loading
      t.doc = content.content;
      t.savedDoc = content.content;
      t.mtime = content.mtime;
      t.isBinary = content.isBinary;
    } catch (err) {
      const t = ws.tabs.find((x) => x.id === tab.id);
      if (!t) return;
      if (isAppError(err) && err.kind === "Config") {
        // Not a regular file (a directory, device, socket...): nothing to edit.
        this.addToast("error", errorMessage(err));
        const i = ws.tabs.findIndex((x) => x.id === tab.id);
        if (i !== -1) ws.tabs.splice(i, 1);
        this.tabMru[sessionId] = (this.tabMru[sessionId] ?? []).filter((id) => id !== tab.id);
        if (ws.activeTabId === tab.id) ws.activeTabId = this.mruTabs(sessionId)[0]?.id ?? null;
        return;
      }
      t.error = errorMessage(err);
      t.tooLarge = isAppError(err) && err.kind === "TooLarge";
    } finally {
      const t = ws.tabs.find((x) => x.id === tab.id);
      if (t) t.loading = false;
    }
  }

  forceOpenBinary(tabId: string): void {
    const t = this.findTab(tabId);
    if (t) t.forceOpen = true;
  }

  async saveTab(tabId: string, overwrite = false, opts: SaveOptions = {}): Promise<void> {
    const tab = this.findTab(tabId);
    if (!tab) return;
    const auto = opts.auto === true;
    if (auto && (tab.saving || tab.autoSavePaused || this.conflict?.tabId === tabId)) return;
    // Never write a buffer that does not hold the file's text: still loading,
    // failed to load (the buffer is empty) or too large to open.
    if (tab.loading || tab.error !== null || tab.tooLarge) {
      if (!auto && !tab.loading) this.addToast("error", `Cannot save ${basename(tab.path)}: the file is not loaded.`);
      return;
    }
    // A second Ctrl+S while the first write is in flight would carry the old
    // mtime and report a false conflict.
    if (tab.saving) return;
    if (this.isSessionReconnecting(tab.sessionId)) {
      if (!auto) this.addToast("error", `Cannot save ${basename(tab.path)}: the connection is down. Save again once it is reconnected.`);
      return;
    }
    if (!this.sessions.some((s) => s.id === tab.sessionId)) {
      if (!auto) this.addToast("error", `Cannot save ${basename(tab.path)}: the session is closed.`);
      return;
    }
    if (isLossy(tab) && !tab.lossyOk) {
      if (auto) return; // never rewrite lossy bytes without asking
      const ok = await this.ask({
        title: "Save may change bytes",
        message: `"${basename(tab.path)}" ${tab.isBinary ? "looks like a binary file" : "is not valid UTF-8"}. It is shown as text with replacement characters (\uFFFD), and saving writes those characters instead of the original bytes. Save anyway?`,
        confirmLabel: "Save anyway",
        danger: true,
      });
      if (!ok || tab.saving) return;
      tab.lossyOk = true;
    }
    tab.saving = true;
    try {
      // A `missing` tab (docs/GUIDE.md §12, "Pause session") has nothing on
      // the server to conflict with — saving it should just recreate the
      // file, the same as passing no `expectedMtime` at all.
      const skipConflictCheck = overwrite || tab.missing === true;
      const newMtime = await api.writeFile(
        tab.sessionId,
        tab.path,
        tab.doc,
        skipConflictCheck ? undefined : tab.mtime,
      );
      tab.mtime = newMtime;
      tab.savedDoc = tab.doc;
      tab.autoSavePaused = false;
      const recreated = tab.missing === true;
      tab.missing = false;
      if (this.conflict?.tabId === tabId) this.conflict = null;
      if (!auto) this.addToast("success", `Saved ${basename(tab.path)}`);
      // A deleted-but-dirty tab just recreated its file: show it in the tree again.
      if (recreated) void this.refreshDir(tab.sessionId, dirname(tab.path));
    } catch (err) {
      if (isAppError(err) && err.kind === "Conflict" && auto) {
        // §11: autosave never opens the dialog; pause it and offer Compare.
        tab.autoSavePaused = true;
        toast.warning(`${basename(tab.path)} changed on the server. Autosave paused.`, {
          action: {
            label: "Compare",
            onClick: () => {
              if (tab.sessionId === this.activeSessionId) this.setActiveTab(tabId);
              void this.openCompare(tabId);
            },
          },
        });
      } else if (isAppError(err) && err.kind === "Conflict") {
        this.conflict = { tabId, path: tab.path };
      } else if (auto && isAppError(err) && err.kind === "PermissionDenied") {
        tab.autoSavePaused = true;
        this.addToast(
          "error",
          `Autosave paused for ${basename(tab.path)}: permission denied. Press Ctrl+S to save with sudo.`,
        );
      } else if (isAppError(err) && err.kind === "PermissionDenied") {
        await this.trySudoSave(tab);
      } else if (auto && this.isSessionReconnecting(tab.sessionId)) {
        // The link dropped mid-autosave: the reconnect banner says it all; the tab stays dirty.
      } else {
        // The buffer is untouched (still dirty), so saving again is always safe.
        const msg = errorMessage(err);
        const hint = /incomplete/i.test(msg) ? " Your changes are still in the editor: save again." : "";
        if (auto) {
          // One toast, not one per autosave tick: pause until a manual save works.
          tab.autoSavePaused = true;
          this.addToast("error", `Autosave paused for ${basename(tab.path)}: ${msg}${hint} Press Ctrl+S to retry.`);
        } else {
          this.addToast("error", `Could not save ${basename(tab.path)}: ${msg}${hint}`);
        }
      }
    } finally {
      tab.saving = false;
    }
  }

  /** GUIDE §3 item 8: on `PermissionDenied`, offer to save via sudo. Uploads
   * the content to a remote temp file over SFTP, then `write_file_sudo` moves
   * it into place as root on a separate exec channel. */
  private async trySudoSave(tab: Tab): Promise<void> {
    const password = await this.ask({
      title: "Permission denied",
      message: `Save "${basename(tab.path)}" with sudo?`,
      input: { password: true },
      confirmLabel: "Save with sudo",
    });
    if (password === null) return; // cancelled
    tab.saving = true;
    try {
      const newMtime = await api.writeFileSudo(
        tab.sessionId,
        tab.path,
        tab.doc,
        password || undefined,
      );
      tab.mtime = newMtime;
      tab.savedDoc = tab.doc;
      tab.autoSavePaused = false;
      tab.missing = false;
      if (this.conflict?.tabId === tab.id) this.conflict = null;
      this.addToast("success", `Saved ${basename(tab.path)} with sudo`);
    } catch (err) {
      this.addToast("error", errorMessage(err));
    } finally {
      tab.saving = false;
    }
  }

  /** Conflict dialog: discard the server copy and force-write ours. */
  resolveConflictOverwrite(): void {
    const c = this.conflict;
    if (!c) return;
    if (!this.findTab(c.tabId)) {
      this.conflict = null; // the tab closed meanwhile
      return;
    }
    void this.saveTab(c.tabId, true);
  }

  /** Re-reads a tab from the server (the editor's "Retry" after a failed load).
   * Asks first when the tab has unsaved changes. */
  async reloadTab(tabId: string): Promise<void> {
    const tab = this.findTab(tabId);
    if (!tab || tab.loading) return;
    if (tab.doc !== tab.savedDoc) {
      const ok = await this.ask({
        title: "Reload from server",
        message: `Discard the unsaved changes in "${basename(tab.path)}"?`,
        confirmLabel: "Discard and reload",
        danger: true,
      });
      if (!ok) return;
    }
    tab.loading = true;
    tab.error = null;
    tab.tooLarge = false;
    try {
      const content = await api.readFile(tab.sessionId, tab.path);
      tab.doc = content.content;
      tab.savedDoc = content.content;
      tab.mtime = content.mtime;
      tab.isBinary = content.isBinary;
      tab.missing = false;
      tab.lossyOk = false;
    } catch (err) {
      tab.error = errorMessage(err);
      tab.tooLarge = isAppError(err) && err.kind === "TooLarge";
    } finally {
      tab.loading = false;
    }
  }

  /** Number of tabs with unsaved changes across every workspace. */
  dirtyTabCount(): number {
    let n = 0;
    for (const ws of Object.values(this.workspaces)) n += ws.tabs.filter((t) => t.doc !== t.savedDoc).length;
    return n;
  }

  /** Before quitting: true when nothing is unsaved or the user chose to discard it. */
  async confirmQuit(): Promise<boolean> {
    const n = this.dirtyTabCount();
    if (n === 0) return true;
    return this.ask({
      title: "Unsaved changes",
      message: `${n} file${n === 1 ? " has" : "s have"} unsaved changes. Quit anyway and lose them?`,
      confirmLabel: "Quit anyway",
      danger: true,
    });
  }

  /** Conflict dialog: discard local edits and reload the server copy. */
  async resolveConflictReload(): Promise<void> {
    const c = this.conflict;
    if (!c) return;
    this.conflict = null;
    const tab = this.findTab(c.tabId);
    if (!tab) return;
    tab.loading = true;
    try {
      const content = await api.readFile(tab.sessionId, tab.path);
      tab.doc = content.content;
      tab.savedDoc = content.content;
      tab.mtime = content.mtime;
      tab.isBinary = content.isBinary;
      tab.error = null;
    } catch (err) {
      this.addToast("error", errorMessage(err));
    } finally {
      tab.loading = false;
    }
  }

  resolveConflictCancel(): void {
    this.conflict = null;
  }

  /** §13.4.D: read the server copy fresh and open the diff view for the tab. */
  async openCompare(tabId: string): Promise<void> {
    const tab = this.findTab(tabId);
    if (!tab) return;
    if (this.conflict?.tabId === tabId) this.conflict = null;
    try {
      const c = await api.readFile(tab.sessionId, tab.path);
      if (c.isBinary) {
        this.addToast("error", "Cannot compare a binary file.");
        return;
      }
      this.compare[tabId] = { tabId, path: tab.path, serverContent: c.content, serverMtime: c.mtime };
    } catch (err) {
      this.addToast("error", errorMessage(err));
    }
  }

  closeCompare(tabId: string): void {
    delete this.compare[tabId];
  }

  /** Diff view actions. `mine` force-writes the buffer, `server` adopts the
   * server copy, `merged` writes `merged` guarded by the fresh server mtime. */
  async applyCompare(tabId: string, mode: "mine" | "server" | "merged", merged = ""): Promise<void> {
    const c = this.compare[tabId];
    const tab = this.findTab(tabId);
    if (!c || !tab) return;
    tab.saving = true;
    try {
      if (mode === "server") {
        tab.doc = c.serverContent;
        tab.savedDoc = c.serverContent;
        tab.mtime = c.serverMtime;
      } else {
        const content = mode === "merged" ? merged : tab.doc;
        tab.mtime = await api.writeFile(
          tab.sessionId,
          tab.path,
          content,
          mode === "merged" ? c.serverMtime : undefined,
        );
        tab.doc = content;
        tab.savedDoc = content;
        this.addToast("success", `Saved ${basename(tab.path)}`);
      }
      tab.autoSavePaused = false;
      tab.missing = false;
      if (this.conflict?.tabId === tabId) this.conflict = null;
      delete this.compare[tabId];
    } catch (err) {
      if (isAppError(err) && err.kind === "Conflict") {
        this.addToast("error", "The file changed on the server again. Review the new version.");
        await this.openCompare(tabId);
      } else {
        this.addToast("error", errorMessage(err));
      }
    } finally {
      tab.saving = false;
    }
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.findTab(tabId);
    if (!tab) return;
    const ws = this.workspaces[tab.sessionId];
    if (!ws) return;
    const dirty = tab.doc !== tab.savedDoc;
    if (dirty) {
      const ok = await this.ask({
        title: "Unsaved changes",
        message: `"${basename(tab.path)}" has unsaved changes. Close anyway?`,
        confirmLabel: "Close anyway",
        danger: true,
      });
      if (!ok) return;
    }
    const idx = ws.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    ws.tabs.splice(idx, 1);
    delete this.compare[tabId];
    if (this.conflict?.tabId === tabId) this.conflict = null;
    this.tabMru[tab.sessionId] = (this.tabMru[tab.sessionId] ?? []).filter((id) => id !== tabId);
    if (!this.closedTabs[tab.sessionId]) this.closedTabs[tab.sessionId] = [];
    this.closedTabs[tab.sessionId].push({ path: tab.path, line: tab.line, col: tab.col });
    if (this.closedTabs[tab.sessionId].length > 20) this.closedTabs[tab.sessionId].shift();
    if (ws.activeTabId === tabId) {
      const neighbor = ws.tabs[idx] ?? ws.tabs[idx - 1];
      ws.activeTabId = neighbor ? neighbor.id : null;
    }
  }
}

export const app = new AppState();

// Paused sessions (docs/GUIDE.md §12, "Pause session") must survive an app
// restart. There's no Phase 4 startup file this module owns (main.ts /
// App.svelte belong to other agents' rows), so load them here instead, once,
// the first time this module — imported by virtually every component — is
// evaluated. Mirrors settings.svelte.ts's `loadSettings()` / hosts.svelte.ts's
// `initHosts()`, just self-triggered instead of caller-triggered.
void app.loadPausedSessions();

// Split Explorer palette commands (§15.3.S). Registered here (not in a component)
// so they exist whether or not the Explorer sidebar is mounted.
registerCommand({
  id: "explorer.split",
  title: "Explorer: Split",
  category: "View",
  run: () => {
    const id = app.activeSessionId;
    if (!id) return;
    app.sidebarView = "explorer";
    void app.splitExplorer(id);
  },
});
registerCommand({
  id: "explorer.closeSplit",
  title: "Explorer: Close Split",
  category: "View",
  run: () => {
    const id = app.activeSessionId;
    if (id) app.closeExplorerSplit(id);
  },
});
