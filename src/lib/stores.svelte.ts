// Single shared app state (Svelte 5 runes), per docs/GUIDE.md §7.
// Components read/mutate `app` directly; all backend I/O goes through lib/api.ts.

import { SvelteSet } from "svelte/reactivity";
import * as api from "./api";
import { isAppError } from "./api";
import { basename, join } from "./paths";
import { languageName } from "./languages";
import type {
  ConnectRequest,
  ErrorKind,
  FileEntry,
  HostEntry,
  SessionClosedEvent,
  SessionInfo,
} from "./types";

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
}

/** Input dialog request driving `InputDialog.svelte`, created by `app.ask()`. */
export interface DialogRequest {
  id: string;
  title: string;
  message?: string;
  input?: { value: string; password?: boolean; selectStart?: number; selectEnd?: number };
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
}

export interface AskOptions {
  title: string;
  message?: string;
  /** Present -> a text/password prompt resolving to the entered string (or
   * `null` if cancelled). Absent -> a yes/no confirm resolving to a boolean. */
  input?: { value?: string; password?: boolean; selectRange?: [number, number] };
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface PendingConnect {
  req: ConnectRequest;
  kind: ErrorKind;
  message: string;
  fingerprint?: string;
  keyPath?: string;
}

export interface ConflictState {
  tabId: string;
  path: string;
}

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

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
  // --- hosts / sidebar --------------------------------------------------
  hosts = $state<HostEntry[]>([]);
  hostsLoading = $state(false);
  hostsError = $state<string | null>(null);
  hostFilter = $state("");

  sidebarView = $state<"hosts" | "explorer">("hosts");
  sidebarWidth = $state(260);
  showTerminal = $state(false);

  // --- connect flow -------------------------------------------------------
  connecting = $state(false);
  connectTarget = $state<string | null>(null);
  pendingConnect = $state<PendingConnect | null>(null);

  // --- sessions / explorer -------------------------------------------------
  sessions = $state<SessionInfo[]>([]);
  activeSessionId = $state<string | null>(null);
  explorers = $state<Record<string, ExplorerState>>({});

  // --- editor tabs ----------------------------------------------------------
  tabs = $state<Tab[]>([]);
  activeTabId = $state<string | null>(null);
  conflict = $state<ConflictState | null>(null);

  // --- toasts ---------------------------------------------------------------
  toasts = $state<Toast[]>([]);

  // --- generic input/confirm dialog ------------------------------------------
  dialogRequest = $state<DialogRequest | null>(null);
  private dialogResolve: ((value: string | boolean | null) => void) | null = null;

  get filteredHosts(): HostEntry[] {
    const f = this.hostFilter.trim().toLowerCase();
    if (!f) return this.hosts;
    return this.hosts.filter(
      (h) =>
        h.alias.toLowerCase().includes(f) ||
        h.hostname.toLowerCase().includes(f) ||
        (h.user ?? "").toLowerCase().includes(f),
    );
  }

  get activeSession(): SessionInfo | null {
    return this.sessions.find((s) => s.id === this.activeSessionId) ?? null;
  }

  get activeExplorer(): ExplorerState | null {
    return this.activeSessionId ? (this.explorers[this.activeSessionId] ?? null) : null;
  }

  get activeTab(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? null;
  }

  // --- toasts -----------------------------------------------------------

  addToast(kind: ToastKind, message: string): void {
    const id = crypto.randomUUID();
    this.toasts.push({ id, kind, message });
    setTimeout(() => this.dismissToast(id), 6000);
  }

  dismissToast(id: string): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
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

  // --- hosts --------------------------------------------------------------

  async loadHosts(): Promise<void> {
    this.hostsLoading = true;
    this.hostsError = null;
    try {
      this.hosts = await api.listHosts();
    } catch (err) {
      this.hostsError = errorMessage(err);
    } finally {
      this.hostsLoading = false;
    }
  }

  // --- connect flow ---------------------------------------------------------

  async connect(req: ConnectRequest, targetLabel: string): Promise<void> {
    this.connecting = true;
    this.connectTarget = targetLabel;
    try {
      const info = await api.connect(req);
      this.sessions.push(info);
      this.activeSessionId = info.id;
      this.pendingConnect = null;
      this.sidebarView = "explorer";
      await this.initExplorer(info);
    } catch (err) {
      if (isAppError(err) && PROMPTABLE_KINDS.has(err.kind)) {
        this.pendingConnect = {
          req,
          kind: err.kind,
          message: err.message,
          fingerprint: err.fingerprint,
          keyPath: err.keyPath,
        };
        return; // keep connecting=true/connectTarget: dialog is now the UI
      }
      this.addToast("error", errorMessage(err));
      this.connectTarget = null;
    } finally {
      if (!this.pendingConnect) this.connecting = false;
    }
  }

  /** Called by PromptDialog with the field(s) it collected; retries `connect`. */
  async submitConnectPrompt(fields: Partial<ConnectRequest>): Promise<void> {
    const pending = this.pendingConnect;
    if (!pending) return;
    const merged: ConnectRequest = { ...pending.req, ...fields };
    this.pendingConnect = null;
    await this.connect(merged, this.connectTarget ?? merged.alias ?? merged.hostname ?? "");
  }

  cancelConnectPrompt(): void {
    this.pendingConnect = null;
    this.connectTarget = null;
    this.connecting = false;
  }

  // --- sessions / explorer ----------------------------------------------------

  async initExplorer(info: SessionInfo): Promise<void> {
    this.explorers[info.id] = {
      cwd: info.home,
      entries: [],
      loading: true,
      error: null,
      showHidden: false,
      selected: null,
      expanded: new SvelteSet<string>(),
      children: {},
      dropTarget: null,
    };
    await this.refreshExplorer(info.id);
  }

  /** Reloads the explorer's root listing (its `cwd`). Nested expanded nodes
   * are untouched — see `refreshDir` for refreshing just one directory. */
  async refreshExplorer(sessionId: string, path?: string): Promise<void> {
    const ex = this.explorers[sessionId];
    if (!ex) return;
    const target = path ?? ex.cwd;
    const navigated = target !== ex.cwd;
    ex.loading = true;
    ex.error = null;
    try {
      const entries = await api.listDir(sessionId, target);
      ex.cwd = target;
      ex.entries = entries;
      if (navigated) {
        // The tree root changed: nested expand/selection state no longer applies.
        ex.expanded.clear();
        ex.children = {};
        ex.selected = null;
      }
    } catch (err) {
      ex.error = errorMessage(err);
    } finally {
      ex.loading = false;
    }
  }

  navigateExplorer(sessionId: string, path: string): Promise<void> {
    return this.refreshExplorer(sessionId, path);
  }

  toggleHidden(sessionId: string): void {
    const ex = this.explorers[sessionId];
    if (ex) ex.showHidden = !ex.showHidden;
  }

  selectPath(sessionId: string, path: string | null): void {
    const ex = this.explorers[sessionId];
    if (ex) ex.selected = path;
  }

  /** Finds a `FileEntry` by path among the root listing or any loaded child node. */
  findEntry(sessionId: string, path: string): FileEntry | null {
    const ex = this.explorers[sessionId];
    if (!ex) return null;
    const root = ex.entries.find((e) => e.path === path);
    if (root) return root;
    for (const node of Object.values(ex.children)) {
      const found = node.entries?.find((e) => e.path === path);
      if (found) return found;
    }
    return null;
  }

  private async loadDirNode(sessionId: string, path: string): Promise<void> {
    const ex = this.explorers[sessionId];
    if (!ex) return;
    ex.children[path] = { entries: ex.children[path]?.entries ?? null, loading: true, error: null };
    try {
      const entries = await api.listDir(sessionId, path);
      ex.children[path] = { entries, loading: false, error: null };
    } catch (err) {
      ex.children[path] = { entries: null, loading: false, error: errorMessage(err) };
    }
  }

  async expandDir(sessionId: string, path: string): Promise<void> {
    const ex = this.explorers[sessionId];
    if (!ex) return;
    ex.expanded.add(path);
    if (!ex.children[path]) {
      await this.loadDirNode(sessionId, path);
    }
  }

  collapseDir(sessionId: string, path: string): void {
    this.explorers[sessionId]?.expanded.delete(path);
  }

  async toggleExpandDir(sessionId: string, path: string): Promise<void> {
    const ex = this.explorers[sessionId];
    if (!ex) return;
    if (ex.expanded.has(path)) {
      this.collapseDir(sessionId, path);
    } else {
      await this.expandDir(sessionId, path);
    }
  }

  /** Refreshes just the directory affected by a mutation (create/rename/
   * delete/upload): the root listing if it's the explorer's `cwd`, or a
   * loaded/expanded child node otherwise. Never collapses the rest of the tree. */
  async refreshDir(sessionId: string, dirPath: string): Promise<void> {
    const ex = this.explorers[sessionId];
    if (!ex) return;
    if (dirPath === ex.cwd) {
      await this.refreshExplorer(sessionId);
      return;
    }
    if (ex.expanded.has(dirPath) || ex.children[dirPath]) {
      await this.loadDirNode(sessionId, dirPath);
    }
  }

  // --- explorer file mutations (create/rename/delete/upload/copy) -----------

  async createFileIn(sessionId: string, dirPath: string): Promise<void> {
    const name = await this.ask({ title: "New file", input: {}, confirmLabel: "Create" });
    if (!name) return;
    try {
      await api.createFile(sessionId, join(dirPath, name));
      await this.refreshDir(sessionId, dirPath);
    } catch (err) {
      this.addToast("error", errorMessage(err));
    }
  }

  async createFolderIn(sessionId: string, dirPath: string): Promise<void> {
    const name = await this.ask({ title: "New folder", input: {}, confirmLabel: "Create" });
    if (!name) return;
    try {
      await api.createDir(sessionId, join(dirPath, name));
      await this.refreshDir(sessionId, dirPath);
    } catch (err) {
      this.addToast("error", errorMessage(err));
    }
  }

  async renameEntry(sessionId: string, entry: FileEntry, parentDir: string): Promise<void> {
    const current = basename(entry.path);
    const dot = current.lastIndexOf(".");
    const stemEnd = dot > 0 ? dot : current.length; // select the stem, not the extension
    const name = await this.ask({
      title: "Rename",
      input: { value: current, selectRange: [0, stemEnd] },
      confirmLabel: "Rename",
    });
    if (!name || name === current) return;
    try {
      await api.rename(sessionId, entry.path, join(parentDir, name));
      await this.refreshDir(sessionId, parentDir);
    } catch (err) {
      this.addToast("error", errorMessage(err));
    }
  }

  async deleteEntry(sessionId: string, entry: FileEntry, parentDir: string): Promise<void> {
    const recursive = entry.kind === "dir";
    const ok = await this.ask({
      title: "Delete",
      message: recursive
        ? `Delete "${entry.name}" and everything inside it?`
        : `Delete "${entry.name}"?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.remove(sessionId, entry.path, recursive);
      await this.refreshDir(sessionId, parentDir);
    } catch (err) {
      this.addToast("error", errorMessage(err));
    }
  }

  async copyPath(path: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(path);
      this.addToast("info", "Path copied");
    } catch {
      this.addToast("error", "Clipboard access denied");
    }
  }

  /** Uploads files dropped from Windows Explorer (or picked via "Upload
   * here…"). Directories are skipped with a toast — `upload` is files-only. */
  async uploadDroppedFiles(
    sessionId: string,
    localPaths: string[],
    remoteDir: string,
  ): Promise<void> {
    if (localPaths.length === 0) return;
    this.addToast("info", `Uploading ${localPaths.length} file${localPaths.length === 1 ? "" : "s"}…`);
    let succeeded = 0;
    const failures: string[] = [];
    for (const localPath of localPaths) {
      const name = localPath.replace(/\\/g, "/").split("/").pop() ?? localPath;
      try {
        await api.upload(sessionId, localPath, remoteDir);
        succeeded++;
      } catch (err) {
        if (isLikelyDirectoryError(err)) {
          this.addToast("info", "Folder upload not supported yet");
        } else {
          failures.push(`${name}: ${errorMessage(err)}`);
        }
      }
    }
    if (succeeded > 0) {
      this.addToast("success", `Uploaded ${succeeded} file${succeeded === 1 ? "" : "s"}`);
    }
    for (const failure of failures) this.addToast("error", failure);
    await this.refreshDir(sessionId, remoteDir);
  }

  setActiveSession(sessionId: string): void {
    if (this.sessions.some((s) => s.id === sessionId)) {
      this.activeSessionId = sessionId;
      this.sidebarView = "explorer";
    }
  }

  async disconnectSession(sessionId: string): Promise<void> {
    try {
      await api.disconnect(sessionId);
    } catch (err) {
      this.addToast("error", errorMessage(err));
    }
    this.dropSession(sessionId, "Disconnected");
  }

  /** Common cleanup for both a user-initiated disconnect and a server-side close. */
  private dropSession(sessionId: string, _reason: string): void {
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    const { [sessionId]: _removed, ...rest } = this.explorers;
    this.explorers = rest;
    this.tabs = this.tabs.filter((t) => t.sessionId !== sessionId);
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = this.sessions[0]?.id ?? null;
      if (!this.activeSessionId) this.sidebarView = "hosts";
    }
    if (this.activeTabId && !this.tabs.some((t) => t.id === this.activeTabId)) {
      this.activeTabId = this.tabs[0]?.id ?? null;
    }
  }

  handleSessionClosed(payload: SessionClosedEvent): void {
    if (!this.sessions.some((s) => s.id === payload.sessionId)) return;
    this.dropSession(payload.sessionId, payload.reason);
    this.addToast("error", `Session closed: ${payload.reason}`);
  }

  // --- editor tabs --------------------------------------------------------

  async openFile(sessionId: string, path: string): Promise<void> {
    const existing = this.tabs.find((t) => t.sessionId === sessionId && t.path === path);
    if (existing) {
      this.activeTabId = existing.id;
      return;
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
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    try {
      const content = await api.readFile(sessionId, path);
      const t = this.tabs.find((x) => x.id === tab.id);
      if (!t) return; // closed while loading
      t.doc = content.content;
      t.savedDoc = content.content;
      t.mtime = content.mtime;
      t.isBinary = content.isBinary;
    } catch (err) {
      const t = this.tabs.find((x) => x.id === tab.id);
      if (!t) return;
      t.error = errorMessage(err);
      t.tooLarge = isAppError(err) && err.kind === "TooLarge";
    } finally {
      const t = this.tabs.find((x) => x.id === tab.id);
      if (t) t.loading = false;
    }
  }

  forceOpenBinary(tabId: string): void {
    const t = this.tabs.find((x) => x.id === tabId);
    if (t) t.forceOpen = true;
  }

  async saveTab(tabId: string, overwrite = false): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    tab.saving = true;
    try {
      const newMtime = await api.writeFile(
        tab.sessionId,
        tab.path,
        tab.doc,
        overwrite ? undefined : tab.mtime,
      );
      tab.mtime = newMtime;
      tab.savedDoc = tab.doc;
      if (this.conflict?.tabId === tabId) this.conflict = null;
      this.addToast("success", `Saved ${basename(tab.path)}`);
    } catch (err) {
      if (isAppError(err) && err.kind === "Conflict") {
        this.conflict = { tabId, path: tab.path };
      } else if (isAppError(err) && err.kind === "PermissionDenied") {
        await this.trySudoSave(tab);
      } else {
        this.addToast("error", errorMessage(err));
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
    void this.saveTab(c.tabId, true);
  }

  /** Conflict dialog: discard local edits and reload the server copy. */
  async resolveConflictReload(): Promise<void> {
    const c = this.conflict;
    if (!c) return;
    this.conflict = null;
    const tab = this.tabs.find((t) => t.id === c.tabId);
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

  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
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
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    this.tabs.splice(idx, 1);
    if (this.activeTabId === tabId) {
      const neighbor = this.tabs[idx] ?? this.tabs[idx - 1];
      this.activeTabId = neighbor ? neighbor.id : null;
    }
  }
}

export const app = new AppState();
