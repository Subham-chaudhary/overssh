<script lang="ts">
  // Fixed-position menu at the cursor (docs/GUIDE.md §3 item 3). Kept as a
  // plain Tailwind-styled popup rather than shadcn's trigger-anchored
  // `context-menu` primitive: the menu is opened programmatically at an
  // arbitrary point (tree row right-click, or the tree background), which
  // doesn't map cleanly onto a `ContextMenu.Trigger`-wrapped element per row.
  import { save, open } from "@tauri-apps/plugin-dialog";
    import { isAppError } from "../lib/api";
  import { app } from "../lib/stores.svelte";
  import { terminalStore } from "../lib/terminal.svelte";
  import { basename, dirname, isRoot } from "../lib/paths";
  import { startDownload, startUpload } from "../lib/transfers.svelte";
  import {
    canPaste,
    copyToClipboard,
    deleteEntries,
    duplicateEntry,
    pasteClipboard,
    renameEntry,
    redoFileOp,
    redoLabel,
    selectedPaths,
    undoFileOp,
    undoLabel,
  } from "../lib/fileops.svelte";
  import type { FileEntry } from "../lib/types";
  import FilePlusIcon from "@lucide/svelte/icons/file-plus";
  import FolderPlusIcon from "@lucide/svelte/icons/folder-plus";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import ScissorsIcon from "@lucide/svelte/icons/scissors";
  import ClipboardPasteIcon from "@lucide/svelte/icons/clipboard-paste";
  import CopyPlusIcon from "@lucide/svelte/icons/copy-plus";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import UploadIcon from "@lucide/svelte/icons/upload";
  import SquareTerminalIcon from "@lucide/svelte/icons/square-terminal";
  import FolderRootIcon from "@lucide/svelte/icons/folder-input";
  import ArrowUpIcon from "@lucide/svelte/icons/arrow-up";
  import InfoIcon from "@lucide/svelte/icons/info";
  import SquareSplitVerticalIcon from "@lucide/svelte/icons/square-split-vertical";

  let {
    sessionId,
    x,
    y,
    dirPath,
    entry,
    pane,
    onClose,
    onInfo,
  }: {
    sessionId: string;
    x: number;
    y: number;
    dirPath: string;
    entry: FileEntry | null;
    /** Explorer pane the menu was opened in (§15.3.S); omitted = the focused pane. */
    pane?: number;
    onClose: () => void;
    /** Opens the Info (Properties) dialog for these paths (mounted by Explorer). */
    onInfo?: (paths: string[]) => void;
  } = $props();

  function fail(err: unknown): void {
    app.addToast("error", isAppError(err) ? err.message : String(err));
  }

  /** Snapshots the props, then closes. Closing unmounts this component, and
   * the parent's props are gone afterwards (reading them throws), so every
   * handler must take what it needs *before* calling `onClose()`. */
  function close(): { sessionId: string; dirPath: string; entry: FileEntry | null } {
    const snap = { sessionId, dirPath, entry };
    onClose();
    return snap;
  }

  /** Where "New file/folder" lands: inside a directory row, next to a file row. */
  function newTargetDir(): string {
    return entry && isDirTarget() ? entry.path : dirPath;
  }

  async function newFile(): Promise<void> {
    const dir = newTargetDir();
    const s = close();
    await app.createFileIn(s.sessionId, dir);
  }

  async function newFolder(): Promise<void> {
    const dir = newTargetDir();
    const s = close();
    await app.createFolderIn(s.sessionId, dir);
  }

  async function doRename(): Promise<void> {
    const s = close();
    if (!s.entry) return;
    await renameEntry(s.sessionId, s.entry, s.dirPath);
  }

  async function doDelete(): Promise<void> {
    const s = close();
    if (!s.entry) return;
    await deleteEntries(s.sessionId, selectedPaths(s.sessionId, s.entry.path, pane));
  }

  function doCopyFiles(op: "copy" | "cut"): void {
    const s = close();
    if (!s.entry) return;
    copyToClipboard(s.sessionId, selectedPaths(s.sessionId, s.entry.path, pane), op);
  }

  async function doPaste(): Promise<void> {
    if (!canPaste(sessionId)) return;
    const dir = newTargetDir();
    const s = close();
    await pasteClipboard(s.sessionId, dir, pane);
  }

  async function doUndo(): Promise<void> {
    const s = close();
    await undoFileOp(s.sessionId);
  }

  async function doRedo(): Promise<void> {
    const s = close();
    await redoFileOp(s.sessionId);
  }

  async function doDuplicate(): Promise<void> {
    const s = close();
    if (!s.entry) return;
    for (const p of selectedPaths(s.sessionId, s.entry.path, pane)) await duplicateEntry(s.sessionId, p);
  }

  function doRefresh(): void {
    const s = close();
    void app.refreshDir(s.sessionId, s.dirPath);
  }

  /** The explorer's current root, which "Go Up" moves one level above. */
  const cwd = $derived(app.paneState(sessionId, pane)?.cwd ?? dirPath);
  const canGoUp = $derived(!isRoot(cwd));

  /** "Set as Explorer Root": like `cd` into the folder (single folder row only). */
  function setAsRoot(): void {
    const s = close();
    if (!s.entry) return;
    void app.navigateExplorer(s.sessionId, s.entry.path, pane);
  }

  /** "Open in Other Pane": roots the other Explorer pane at this folder (splits first if needed). */
  function openInOtherPane(): void {
    const s = close();
    if (!s.entry) return;
    void app.openInOtherPane(s.sessionId, s.entry.path, pane);
  }

  /** "Go Up": like `cd ..` for the explorer root. */
  function goUp(): void {
    const target = dirname(cwd);
    const s = close();
    void app.navigateExplorer(s.sessionId, target, pane);
  }

  function showInfo(): void {
    const s = close();
    const paths = s.entry ? selectedPaths(s.sessionId, s.entry.path, pane) : [s.dirPath];
    onInfo?.(paths);
  }

  async function copyPath(): Promise<void> {
    const s = close();
    await app.copyPath(s.entry?.path ?? s.dirPath);
  }

  /** True for the empty-space menu (`entry === null`, targets the current
   * explorer cwd) and for directory/directory-symlink rows — never for a
   * plain file row. Drives "Open Terminal Here" (docs/GUIDE.md §12 item 4). */
  function isDirTarget(): boolean {
    if (!entry) return true;
    return entry.kind === "dir" || (entry.kind === "symlink" && entry.linkTargetIsDir === true);
  }

  async function openTerminalHere(): Promise<void> {
    const s = close();
    const target = s.entry ? s.entry.path : s.dirPath;
    try {
      await terminalStore.openNew(s.sessionId, { cwd: target, title: basename(target) });
    } catch (err) {
      fail(err);
    }
  }

  /** One file: save dialog (pick the name). Folders or several items: pick a folder. */
  async function doDownload(): Promise<void> {
    if (!entry) return;
    const s = close();
    const paths = selectedPaths(s.sessionId, s.entry!.path, pane);
    const single = paths.length === 1 && s.entry!.kind === "file";
    try {
      if (single) {
        const target = await save({ defaultPath: s.entry!.name });
        if (!target) return;
        const norm = target.split("\\").join("/");
        const cut = norm.lastIndexOf("/");
        const dir = cut > 0 ? target.slice(0, cut) : ".";
        await startDownload(s.sessionId, paths, dir, norm.slice(cut + 1), "overwrite");
      } else {
        const dir = await open({ directory: true, multiple: false, title: "Download to folder" });
        if (!dir || Array.isArray(dir)) return;
        await startDownload(s.sessionId, paths, dir);
      }
    } catch (err) {
      fail(err);
    }
  }

  // Placement: open at the cursor, flip left/up when the menu would cross the
  // right/bottom edge, then clamp into the viewport. Hidden until measured so
  // it never flashes at the unflipped spot.
  const EDGE = 4;
  let menuEl: HTMLDivElement | undefined = $state();
  let pos = $state<{ left: number; top: number; maxH: number } | null>(null);

  function place(): void {
    if (!menuEl) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxH = vh - EDGE * 2;
    const w = menuEl.offsetWidth;
    // scrollHeight is the full content height even while max-height clips it,
    // but excludes the borders; add them back.
    const border = menuEl.offsetHeight - menuEl.clientHeight;
    const h = Math.min(menuEl.scrollHeight + border, maxH);
    let left = x + w > vw - EDGE ? x - w : x;
    let top = y + h > vh - EDGE ? y - h : y;
    left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
    top = Math.max(EDGE, Math.min(top, vh - h - EDGE));
    pos = { left, top, maxH };
  }

  $effect(() => {
    void x;
    void y;
    place();
  });

  /** Moves the menu under <body>. The sidebar is a CSS size container
   * (`@container/side`), which implies layout containment: it becomes the
   * containing block for `position: fixed` children and its overflow-hidden
   * clips them, so in place the menu is offset and cut off at the edges. */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  async function doUpload(folders: boolean): Promise<void> {
    const s = close();
    const dest = s.entry && s.entry.kind === "dir" ? s.entry.path : s.dirPath;
    let selection: string | string[] | null;
    try {
      selection = await open(folders ? { directory: true, multiple: true } : { multiple: true });
    } catch (err) {
      fail(err);
      return;
    }
    if (!selection) return;
    const localPaths = Array.isArray(selection) ? selection : [selection];
    await startUpload(s.sessionId, localPaths, dest);
  }
</script>

<svelte:window
  onclick={onClose}
  oncontextmenu={onClose}
  onkeydown={(e) => {
    if (e.key === "Escape") onClose();
  }}
  onresize={onClose}
/>

<div
  bind:this={menuEl}
  use:portal
  class="fixed z-[300] flex min-w-[170px] flex-col gap-0.5 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg"
  style={pos
    ? `left:${pos.left}px; top:${pos.top}px; max-height:${pos.maxH}px;`
    : `left:${x}px; top:${y}px; visibility:hidden;`}
  role="menu"
>
  <button
    type="button"
    role="menuitem"
    class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
    onclick={newFile}><FilePlusIcon class="size-3.5" /> New file<span class="ml-auto pl-4 text-[11px] text-muted-foreground">Ctrl+N</span></button
  >
  <button
    type="button"
    role="menuitem"
    class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
    onclick={newFolder}><FolderPlusIcon class="size-3.5" /> New folder<span class="ml-auto pl-4 text-[11px] text-muted-foreground">Ctrl+Shift+N</span></button
  >
  <div class="my-0.5 h-px bg-border"></div>
  {#if entry}
    <button
      type="button"
      role="menuitem"
      class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
      onclick={() => doCopyFiles("cut")}><ScissorsIcon class="size-3.5" /> Cut<span class="ml-auto pl-4 text-[11px] text-muted-foreground">Ctrl+X</span></button
    >
    <button
      type="button"
      role="menuitem"
      class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
      onclick={() => doCopyFiles("copy")}><CopyIcon class="size-3.5" /> Copy<span class="ml-auto pl-4 text-[11px] text-muted-foreground">Ctrl+C</span></button
    >
  {/if}
  <button
    type="button"
    role="menuitem"
    disabled={!canPaste(sessionId)}
    class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
    onclick={doPaste}><ClipboardPasteIcon class="size-3.5" /> Paste<span class="ml-auto pl-4 text-[11px] text-muted-foreground">Ctrl+V</span></button
  >
  {#if entry}
    <button
      type="button"
      role="menuitem"
      class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
      onclick={doDuplicate}><CopyPlusIcon class="size-3.5" /> Duplicate</button
    >
    <div class="my-0.5 h-px bg-border"></div>
    <button
      type="button"
      role="menuitem"
      class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
      onclick={doRename}><PencilIcon class="size-3.5" /> Rename<span class="ml-auto pl-4 text-[11px] text-muted-foreground">F2</span></button
    >
    <button
      type="button"
      role="menuitem"
      class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] text-destructive hover:bg-destructive/10"
      onclick={doDelete}><Trash2Icon class="size-3.5" /> Delete<span class="ml-auto pl-4 text-[11px] text-muted-foreground">Del</span></button
    >
  {/if}
  {#if undoLabel(sessionId) || redoLabel(sessionId)}
    <div class="my-0.5 h-px bg-border"></div>
    {#if undoLabel(sessionId)}
      <button
        type="button"
        role="menuitem"
        class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
        onclick={doUndo}>Undo {undoLabel(sessionId)}<span class="ml-auto pl-4 text-[11px] text-muted-foreground">Ctrl+Z</span></button
      >
    {/if}
    {#if redoLabel(sessionId)}
      <button
        type="button"
        role="menuitem"
        class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
        onclick={doRedo}>Redo {redoLabel(sessionId)}<span class="ml-auto pl-4 text-[11px] text-muted-foreground">Ctrl+Shift+Z</span></button
      >
    {/if}
  {/if}
  <div class="my-0.5 h-px bg-border"></div>
  <button
    type="button"
    role="menuitem"
    class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
    onclick={doRefresh}><RefreshCwIcon class="size-3.5" /> Refresh<span class="ml-auto pl-4 text-[11px] text-muted-foreground">F5</span></button
  >
  <button
    type="button"
    role="menuitem"
    class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
    onclick={copyPath}><CopyIcon class="size-3.5" /> Copy path</button
  >
  {#if entry && isDirTarget()}
    <button
      type="button"
      role="menuitem"
      class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
      onclick={setAsRoot}><FolderRootIcon class="size-3.5" /> Set as Explorer Root</button
    >
    <button
      type="button"
      role="menuitem"
      class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
      data-testid="ctx-open-other-pane"
      onclick={openInOtherPane}><SquareSplitVerticalIcon class="size-3.5" /> Open in Other Pane</button
    >
  {/if}
  {#if canGoUp}
    <button
      type="button"
      role="menuitem"
      class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
      onclick={goUp}
      ><ArrowUpIcon class="size-3.5" /> Go Up<span class="ml-auto pl-4 text-[11px] text-muted-foreground">Alt+Up</span></button
    >
  {/if}
  {#if isDirTarget()}
    <button
      type="button"
      role="menuitem"
      class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
      onclick={() => void openTerminalHere()}
      ><SquareTerminalIcon class="size-3.5" /> Open Terminal Here</button
    >
  {/if}
  {#if entry}
    <button
      type="button"
      role="menuitem"
      class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
      onclick={doDownload}><DownloadIcon class="size-3.5" /> Download…</button
    >
  {/if}
  <button
    type="button"
    role="menuitem"
    class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
    onclick={() => void doUpload(false)}><UploadIcon class="size-3.5" /> Upload files here…</button
  >
  <button
    type="button"
    role="menuitem"
    class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
    onclick={() => void doUpload(true)}><UploadIcon class="size-3.5" /> Upload folder here…</button
  >
  {#if onInfo}
    <div class="my-0.5 h-px bg-border"></div>
    <button
      type="button"
      role="menuitem"
      class="flex items-center gap-2 rounded-sm px-2 py-1 text-left text-[12px] hover:bg-accent"
      onclick={showInfo}
      ><InfoIcon class="size-3.5" /> Info<span class="ml-auto pl-4 text-[11px] text-muted-foreground">Alt+Enter</span></button
    >
  {/if}
</div>
