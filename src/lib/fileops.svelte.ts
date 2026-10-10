// VS Code-style explorer file operations (docs/GUIDE.md §13.4.F): rename, move,
// delete, copy / cut / paste, duplicate and drag-move, each keeping open editor
// tabs and explorer state in sync. All backend I/O goes through lib/api.ts.
//
// Lives in its own module (not in `stores.svelte.ts`) so it can import `app`
// without a cycle; components call these functions directly.

import * as api from "./api";
import { isAppError } from "./api";
import { app, type Tab } from "./stores.svelte";
import { basename, dirname, join, validateEntryName } from "./paths";
import { languageName } from "./languages";
import type { FileEntry } from "./types";

export type ClipOp = "copy" | "cut";

/** The explorer's internal file clipboard (not the OS clipboard). */
export const fileClipboard = $state<{ sessionId: string | null; paths: string[]; op: ClipOp }>({
  sessionId: null,
  paths: [],
  op: "copy",
});

function errorMessage(err: unknown): string {
  return isAppError(err) ? err.message : String(err);
}

/** `path` is `dir` itself or lies below it. */
export function isInside(dir: string, path: string): boolean {
  const d = dir.replace(/\/+$/, "");
  return path === d || path.startsWith(`${d}/`);
}

function remap(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
  return null;
}

/** True while `path` is on the clipboard as a pending cut (dimmed in the tree). */
export function isCut(sessionId: string, path: string): boolean {
  return (
    fileClipboard.op === "cut" &&
    fileClipboard.sessionId === sessionId &&
    fileClipboard.paths.some((p) => isInside(p, path))
  );
}

async function pathExists(sessionId: string, path: string): Promise<boolean> {
  try {
    await api.stat(sessionId, path);
    return true;
  } catch (err) {
    if (isAppError(err) && err.kind === "NotFound") return false;
    throw err;
  }
}

/** "name copy.ext", "name copy 2.ext", … (VS Code naming; dirs and dotfiles have no extension). */
function copyName(name: string, n: number, isDir: boolean): string {
  const dot = name.lastIndexOf(".");
  const hasExt = !isDir && dot > 0;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : "";
  return `${stem} copy${n > 1 ? ` ${n}` : ""}${ext}`;
}

// --- selection -------------------------------------------------------------

/** Rows an action on `anchor` applies to: the whole multi-selection if `anchor`
 * is part of it, else just `anchor` (or the selected row when omitted). */
export function selectedPaths(sessionId: string, anchor?: string | null, pane?: number): string[] {
  const ex = app.paneState(sessionId, pane);
  if (!ex) return [];
  if (ex.multi.length > 1 && (anchor == null || ex.multi.includes(anchor))) return [...ex.multi];
  const one = anchor ?? ex.selected;
  return one ? [one] : [];
}

export function isRowSelected(sessionId: string, path: string, pane?: number): boolean {
  const ex = app.paneState(sessionId, pane);
  if (!ex) return false;
  return ex.selected === path || (ex.multi.length > 1 && ex.multi.includes(path));
}

function visibleRowPaths(pane?: number): string[] {
  const scope =
    pane === undefined
      ? document
      : (document.querySelector(`[data-explorer-pane="${pane}"]`) ?? document);
  return Array.from(scope.querySelectorAll<HTMLElement>('[role="treeitem"][data-parent]'))
    .map((r) => r.getAttribute("data-path"))
    .filter((p): p is string => !!p);
}

/** Handles Ctrl/Meta (toggle) and Shift (range) clicks. Returns true if the
 * click was a multi-select gesture (caller must not open/expand the row). */
export function modifierSelect(
  sessionId: string,
  path: string,
  e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  pane?: number,
): boolean {
  const ex = app.paneState(sessionId, pane);
  if (!ex) return false;
  if (e.ctrlKey || e.metaKey) {
    const set = new Set(ex.multi.length > 0 ? ex.multi : ex.selected ? [ex.selected] : []);
    if (set.has(path)) set.delete(path);
    else set.add(path);
    ex.multi = [...set];
    ex.selected = path;
    return true;
  }
  if (e.shiftKey && ex.selected) {
    const rows = visibleRowPaths(pane);
    const a = rows.indexOf(ex.selected);
    const b = rows.indexOf(path);
    if (a < 0 || b < 0) return false;
    ex.multi = rows.slice(Math.min(a, b), Math.max(a, b) + 1);
    return true;
  }
  return false;
}

// --- keeping tabs and explorer state in sync ----------------------------------

/** After `from` was renamed/moved to `to` (file or directory): retargets every
 * open tab at or under it (keeping buffer, dirty state, undo history, cursor)
 * and rewrites explorer expanded/selected/children state. Does not refresh listings. */
export function retargetPaths(sessionId: string, from: string, to: string): void {
  const ws = app.workspaces[sessionId];
  if (!ws) return;

  // A tab already sitting on a destination path is stale (the move only succeeds
  // when the destination did not exist, e.g. a deleted-but-dirty tab): drop it.
  const moving = new Set(ws.tabs.filter((t) => remap(t.path, from, to) !== null).map((t) => t.id));
  for (const t of [...ws.tabs]) {
    if (moving.has(t.id)) continue;
    const clash = ws.tabs.some((m) => moving.has(m.id) && remap(m.path, from, to) === t.path);
    if (!clash) continue;
    const idx = ws.tabs.findIndex((x) => x.id === t.id);
    ws.tabs.splice(idx, 1);
    if (ws.activeTabId === t.id) ws.activeTabId = null;
  }
  for (const tab of ws.tabs) {
    const next = remap(tab.path, from, to);
    if (next === null) continue;
    tab.path = next;
    tab.language = languageName(next);
  }
  if (ws.activeTabId === null) {
    const moved = ws.tabs.find((t) => moving.has(t.id));
    if (moved) ws.activeTabId = moved.id;
  }

  for (const ex of ws.panes) {
    const wasExpanded = [...ex.expanded].filter((p) => remap(p, from, to) !== null);
    for (const p of wasExpanded) {
      ex.expanded.delete(p);
      ex.expanded.add(remap(p, from, to)!);
    }
    for (const key of Object.keys(ex.children)) {
      if (remap(key, from, to) !== null) delete ex.children[key];
    }
    if (ex.selected) ex.selected = remap(ex.selected, from, to) ?? ex.selected;
    ex.multi = ex.multi.map((p) => remap(p, from, to) ?? p);
    const cwd = remap(ex.cwd, from, to);
    if (cwd !== null) ex.cwd = cwd;
  }
}

/** Reloads every renamed-away-and-back expanded directory under `to`. */
async function reloadExpandedUnder(sessionId: string, to: string): Promise<void> {
  const ws = app.workspaces[sessionId];
  if (!ws) return;
  const dirs = new Set(ws.panes.flatMap((ex) => [...ex.expanded]).filter((p) => isInside(to, p)));
  for (const dir of dirs) {
    await app.refreshDir(sessionId, dir);
  }
}

/** After `path` was deleted: clean tabs at/under it close, dirty ones stay open
 * flagged `missing` (strike-through "(deleted)"; saving recreates the file). */
async function handleDeleted(sessionId: string, path: string): Promise<void> {
  const ws = app.workspaces[sessionId];
  if (!ws) return;
  const affected: Tab[] = ws.tabs.filter((t) => isInside(path, t.path));
  for (const tab of affected) {
    if (tab.doc !== tab.savedDoc) tab.missing = true;
    else await app.closeTab(tab.id);
  }
  for (const ex of ws.panes) {
    for (const p of [...ex.expanded]) if (isInside(path, p)) ex.expanded.delete(p);
    for (const key of Object.keys(ex.children)) if (isInside(path, key)) delete ex.children[key];
    if (ex.selected && isInside(path, ex.selected)) ex.selected = null;
    ex.multi = ex.multi.filter((p) => !isInside(path, p));
  }
  // A pane rooted at (or below) the deleted folder moves up to its parent.
  await Promise.all(
    ws.panes.map((ex, i) => (isInside(path, ex.cwd) ? app.navigateExplorer(sessionId, dirname(path), i) : undefined)),
  );
}

// --- undo / redo ---------------------------------------------------------------
// Per-session stacks of file operations. Rename/move undo = move back; copy and
// create undo = remove (redo = copy again / restore the captured content); delete
// undo = recreate from an in-memory snapshot (text files only, size-capped).

interface FileOp {
  label: string;
  undo(): Promise<void>;
  redo(): Promise<void>;
}

const MAX_UNDO = 50;
const stacks = new Map<string, { undo: FileOp[]; redo: FileOp[] }>();
let stackVersion = $state(0); // bumps so undoLabel()/redoLabel() are reactive

function stackOf(sessionId: string) {
  let s = stacks.get(sessionId);
  if (!s) stacks.set(sessionId, (s = { undo: [], redo: [] }));
  return s;
}

function pushOp(sessionId: string, op: FileOp): void {
  const s = stackOf(sessionId);
  s.undo.push(op);
  if (s.undo.length > MAX_UNDO) s.undo.shift();
  s.redo.length = 0;
  stackVersion++;
}

export function undoLabel(sessionId: string): string | null {
  void stackVersion;
  const s = stacks.get(sessionId);
  return s && s.undo.length > 0 ? s.undo[s.undo.length - 1].label : null;
}

export function redoLabel(sessionId: string): string | null {
  void stackVersion;
  const s = stacks.get(sessionId);
  return s && s.redo.length > 0 ? s.redo[s.redo.length - 1].label : null;
}

export async function undoFileOp(sessionId: string): Promise<void> {
  const s = stackOf(sessionId);
  const op = s.undo.pop();
  stackVersion++;
  if (!op) return;
  try {
    await op.undo();
    s.redo.push(op);
    app.addToast("info", `Undid: ${op.label}`);
  } catch (err) {
    app.addToast("error", `Cannot undo "${op.label}": ${errorMessage(err)}`);
  }
  stackVersion++;
}

export async function redoFileOp(sessionId: string): Promise<void> {
  const s = stackOf(sessionId);
  const op = s.redo.pop();
  stackVersion++;
  if (!op) return;
  try {
    await op.redo();
    s.undo.push(op);
    app.addToast("info", `Redid: ${op.label}`);
  } catch (err) {
    app.addToast("error", `Cannot redo "${op.label}": ${errorMessage(err)}`);
  }
  stackVersion++;
}

async function refreshParents(sessionId: string, ...paths: string[]): Promise<void> {
  for (const dir of new Set(paths.map(dirname))) await app.refreshDir(sessionId, dir);
}

async function movePath(sessionId: string, from: string, to: string): Promise<void> {
  await api.rename(sessionId, from, to);
  retargetPaths(sessionId, from, to);
  await refreshParents(sessionId, from, to);
  await reloadExpandedUnder(sessionId, to);
}

async function removePath(sessionId: string, path: string, isDir: boolean): Promise<void> {
  await api.remove(sessionId, path, isDir);
  await handleDeleted(sessionId, path);
  await refreshParents(sessionId, path);
}

interface Snap {
  name: string;
  kind: "file" | "dir";
  content: string;
  children: Snap[];
}

/** In-memory copy of a file/folder for undoing a delete. Throws for binary,
 * non-UTF-8, symlink/special or oversized content (then the delete is not undoable). */
async function capture(
  sessionId: string,
  path: string,
  budget = { bytes: 5_000_000, files: 400 },
): Promise<Snap> {
  const st = await api.stat(sessionId, path);
  const name = basename(path);
  if (st.kind === "dir") {
    const children: Snap[] = [];
    for (const child of await api.listDir(sessionId, path)) {
      children.push(await capture(sessionId, child.path, budget));
    }
    return { name, kind: "dir", content: "", children };
  }
  if (st.kind !== "file") throw new Error("symlinks and special files cannot be restored");
  budget.bytes -= st.size;
  budget.files -= 1;
  if (budget.bytes < 0 || budget.files < 0) throw new Error("too large to keep for undo");
  const file = await api.readFile(sessionId, path);
  if (file.isBinary || file.content.includes("�")) {
    throw new Error("binary content cannot be restored");
  }
  return { name, kind: "file", content: file.content, children: [] };
}

async function restoreSnap(sessionId: string, path: string, snap: Snap): Promise<void> {
  if (snap.kind === "dir") {
    await api.createDir(sessionId, path);
    for (const child of snap.children) await restoreSnap(sessionId, join(path, child.name), child);
    return;
  }
  const mtime = await api.writeFile(sessionId, path, snap.content);
  const tab = app.workspaces[sessionId]?.tabs.find((t) => t.path === path);
  if (tab) {
    tab.missing = false; // a deleted-but-dirty tab is backed by a real file again
    tab.mtime = mtime;
  }
}

async function restoreAt(sessionId: string, path: string, snap: Snap): Promise<void> {
  if (await pathExists(sessionId, path)) throw new Error(`${path} already exists`);
  await restoreSnap(sessionId, path, snap);
  await refreshParents(sessionId, path);
}

/** Records a freshly created file/folder (hooked from `app.createFileIn/FolderIn`). */
app.onEntryCreated = (sessionId, path, kind) => {
  let snap: Snap | null = null;
  pushOp(sessionId, {
    label: `Create ${basename(path)}`,
    async undo() {
      snap = await capture(sessionId, path).catch(() => null);
      await removePath(sessionId, path, kind === "dir");
    },
    async redo() {
      if (snap) await restoreAt(sessionId, path, snap);
      else {
        if (kind === "dir") await api.createDir(sessionId, path);
        else await api.createFile(sessionId, path);
        await refreshParents(sessionId, path);
      }
    },
  });
};

// --- rename / delete -------------------------------------------------------------

export async function renameEntry(sessionId: string, entry: FileEntry, parentDir: string): Promise<void> {
  const current = basename(entry.path);
  const dot = current.lastIndexOf(".");
  const stemEnd = dot > 0 ? dot : current.length; // select the stem, not the extension
  const name = (
    await app.ask({
      title: "Rename",
      input: { value: current, selectRange: [0, stemEnd], validate: (v) => validateEntryName(v) },
      confirmLabel: "Rename",
    })
  )?.trim();
  if (!name || name === current) return;
  const bad = validateEntryName(name);
  if (bad) {
    app.addToast("error", bad);
    return;
  }
  if (!app.workspaces[sessionId]) return; // disconnected while the dialog was open
  const to = join(parentDir, name);
  try {
    await api.rename(sessionId, entry.path, to);
  } catch (err) {
    app.addToast("error", errorMessage(err));
    return;
  }
  retargetPaths(sessionId, entry.path, to);
  await app.refreshDir(sessionId, parentDir);
  await reloadExpandedUnder(sessionId, to);
  app.selectPath(sessionId, to);
  const from = entry.path;
  pushOp(sessionId, {
    label: `Rename ${current} to ${name}`,
    undo: () => movePath(sessionId, to, from),
    redo: () => movePath(sessionId, from, to),
  });
}

export async function deleteEntry(sessionId: string, entry: FileEntry, parentDir: string): Promise<void> {
  void parentDir;
  await deleteEntries(sessionId, [entry.path]);
}

export async function deleteEntries(
  sessionId: string,
  paths: string[],
  opts?: { title?: string; message?: string; confirmLabel?: string },
): Promise<void> {
  const ws = app.workspaces[sessionId];
  if (!ws || paths.length === 0) return;
  const entries = paths.map((p) => ({ path: p, entry: app.findEntry(sessionId, p) }));
  const isDir = (e: FileEntry | null) => e?.kind === "dir";
  const dirty = ws.tabs.filter(
    (t) => t.doc !== t.savedDoc && paths.some((p) => isInside(p, t.path)),
  ).length;
  const what =
    paths.length === 1
      ? `"${basename(paths[0])}"${isDir(entries[0].entry) ? " and everything inside it" : ""}`
      : `${paths.length} items`;
  const warn =
    dirty > 0
      ? ` ${dirty} open file${dirty === 1 ? " has" : "s have"} unsaved changes; ${dirty === 1 ? "it stays" : "they stay"} open and saving recreates the file.`
      : "";
  const ok = await app.ask({
    title: opts?.title ?? "Delete",
    message: opts?.message ? `${opts.message}${warn}` : `Delete ${what}?${warn}`,
    confirmLabel: opts?.confirmLabel ?? "Delete",
    danger: true,
  });
  if (!ok) return;
  const parents = new Set<string>();
  const deleted: { path: string; isDir: boolean; snap: Snap | null }[] = [];
  let uncapturable: string | null = null;
  for (const { path, entry } of entries) {
    let snap: Snap | null = null;
    try {
      snap = await capture(sessionId, path);
    } catch (err) {
      uncapturable = errorMessage(err);
    }
    try {
      await api.remove(sessionId, path, isDir(entry));
    } catch (err) {
      app.addToast("error", errorMessage(err));
      continue;
    }
    parents.add(dirname(path));
    deleted.push({ path, isDir: isDir(entry), snap });
    await handleDeleted(sessionId, path);
  }
  for (const dir of parents) await app.refreshDir(sessionId, dir);
  if (deleted.length > 0) {
    if (uncapturable) app.addToast("info", `Deleted. Undo will skip some items: ${uncapturable}`);
    pushOp(sessionId, {
      label:
        deleted.length === 1 ? `Delete ${basename(deleted[0].path)}` : `Delete ${deleted.length} items`,
      async undo() {
        for (const d of [...deleted].reverse()) {
          if (!d.snap) throw new Error(`${basename(d.path)} was not kept for undo`);
          await restoreAt(sessionId, d.path, d.snap);
        }
      },
      async redo() {
        for (const d of deleted) await removePath(sessionId, d.path, d.isDir);
      },
    });
  }
}

// --- copy / cut / paste / move ----------------------------------------------------

export function copyToClipboard(sessionId: string, paths: string[], op: ClipOp): void {
  if (paths.length === 0) return;
  fileClipboard.sessionId = sessionId;
  fileClipboard.paths = [...paths];
  fileClipboard.op = op;
  app.addToast("info", `${op === "cut" ? "Cut" : "Copied"} ${paths.length === 1 ? basename(paths[0]) : `${paths.length} items`}`);
}

export function canPaste(_sessionId: string): boolean {
  // Items from another session are pasted as a VM-to-VM transfer job (§13.4.S).
  return fileClipboard.paths.length > 0 && fileClipboard.sessionId !== null;
}

export async function pasteClipboard(sessionId: string, destDir: string, pane?: number): Promise<void> {
  if (fileClipboard.paths.length === 0) return;
  const paths = [...fileClipboard.paths];
  const op = fileClipboard.op;
  if (fileClipboard.sessionId !== sessionId) {
    const src = fileClipboard.sessionId;
    if (!src || !app.sessions.some((s) => s.id === src)) {
      app.addToast("error", "The source session is no longer connected");
      return;
    }
    const { startCopy } = await import("./transfers.svelte");
    await startCopy(src, paths, sessionId, destDir, op === "cut");
    if (op === "cut") {
      fileClipboard.paths = [];
      fileClipboard.sessionId = null;
    }
    return;
  }
  await transferEntries(sessionId, paths, destDir, op === "cut" ? "move" : "copy", pane);
  if (op === "cut") {
    fileClipboard.paths = [];
    fileClipboard.sessionId = null;
  }
}

export async function duplicateEntry(sessionId: string, path: string): Promise<void> {
  await transferEntries(sessionId, [path], dirname(path), "copy");
}

/** Moves or copies `sources` into `destDir`. A move that would overwrite fails
 * for that item (toast); a copy that clashes gets VS Code naming. Retargets open
 * tabs for moves and reveals/selects the results. */
export async function transferEntries(
  sessionId: string,
  sources: string[],
  destDir: string,
  op: "move" | "copy",
  /** Pane that shows the destination (expanded and selected afterwards); default: the focused one. */
  pane?: number,
): Promise<void> {
  const ex = app.paneState(sessionId, pane);
  if (!ex) return;
  // Drop sources whose ancestor is also being transferred.
  const items = sources.filter((s) => !sources.some((o) => o !== s && isInside(o, s)));
  const refresh = new Set<string>([destDir]);
  const results: string[] = [];
  const moved: { from: string; to: string }[] = [];
  const copied: { from: string; to: string; isDir: boolean }[] = [];
  for (const src of items) {
    const name = basename(src);
    if (isInside(src, destDir)) {
      app.addToast("error", `Cannot ${op} "${name}" into itself`);
      continue;
    }
    try {
      if (op === "move") {
        if (dirname(src) === destDir) continue; // already there
        const to = join(destDir, name);
        if (await pathExists(sessionId, to)) {
          app.addToast("error", `"${name}" already exists in ${destDir}`);
          continue;
        }
        await api.rename(sessionId, src, to);
        retargetPaths(sessionId, src, to);
        refresh.add(dirname(src));
        results.push(to);
        moved.push({ from: src, to });
      } else {
        const srcEntry = app.findEntry(sessionId, src);
        const isDir = srcEntry?.kind === "dir";
        let to = join(destDir, name);
        for (let n = 1; await pathExists(sessionId, to); n++) {
          to = join(destDir, copyName(name, n, isDir));
        }
        await api.copyPath(sessionId, src, to);
        results.push(to);
        copied.push({ from: src, to, isDir });
      }
    } catch (err) {
      app.addToast("error", errorMessage(err));
    }
  }
  const what = (n: number, p: string) => (n === 1 ? basename(p) : `${n} items`);
  if (moved.length > 0) {
    pushOp(sessionId, {
      label: `Move ${what(moved.length, moved[0].from)}`,
      async undo() {
        for (const m of [...moved].reverse()) await movePath(sessionId, m.to, m.from);
      },
      async redo() {
        for (const m of moved) await movePath(sessionId, m.from, m.to);
      },
    });
  }
  if (copied.length > 0) {
    pushOp(sessionId, {
      label: `Copy ${what(copied.length, copied[0].from)}`,
      async undo() {
        for (const c of [...copied].reverse()) await removePath(sessionId, c.to, c.isDir);
      },
      async redo() {
        for (const c of copied) await api.copyPath(sessionId, c.from, c.to);
        await refreshParents(sessionId, ...copied.map((c) => c.to));
      },
    });
  }
  for (const dir of refresh) await app.refreshDir(sessionId, dir);
  const cur = app.paneState(sessionId, pane);
  if (cur && destDir !== cur.cwd && !cur.expanded.has(destDir)) await app.expandDir(sessionId, destDir, pane);
  if (op === "move") for (const to of results) await reloadExpandedUnder(sessionId, to);
  if (cur && results.length > 0) {
    if (results.length === 1) app.selectPath(sessionId, results[0], pane);
    else {
      cur.selected = results[0];
      cur.multi = results;
    }
  }
}
