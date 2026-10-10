<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { app } from "../lib/stores.svelte";
  import * as api from "../lib/api";
  import { basename, dirname, isRoot } from "../lib/paths";
  import {
    copyToClipboard,
    deleteEntries,
    isInside,
    pasteClipboard,
    redoFileOp,
    renameEntry,
    selectedPaths,
    transferEntries,
    undoFileOp,
  } from "../lib/fileops.svelte";
  import TreeNode from "./TreeNode.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import FileInfoDialog from "./FileInfoDialog.svelte";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import type { FileEntry } from "../lib/types";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import CornerLeftUpIcon from "@lucide/svelte/icons/corner-left-up";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import FilePlusIcon from "@lucide/svelte/icons/file-plus";
  import FolderPlusIcon from "@lucide/svelte/icons/folder-plus";
  import EyeIcon from "@lucide/svelte/icons/eye";
  import EyeOffIcon from "@lucide/svelte/icons/eye-off";
  import PowerIcon from "@lucide/svelte/icons/power";
  import ArrowUpIcon from "@lucide/svelte/icons/arrow-up";
  import HouseIcon from "@lucide/svelte/icons/house";
  import SquareSplitVerticalIcon from "@lucide/svelte/icons/square-split-vertical";
  import PanelTopCloseIcon from "@lucide/svelte/icons/panel-top-close";

  // One explorer pane (§15.3.S). `Explorer.svelte` mounts one, or two stacked when split.
  let { pane, split = false }: { pane: number; split?: boolean } = $props();

  let pathInput = $state("");
  let menu = $state<{ x: number; y: number; dirPath: string; entry: FileEntry | null } | null>(
    null,
  );
  let treeEl: HTMLDivElement | undefined = $state();
  /** Paths shown in the Info (Properties) dialog, or null when closed. */
  let infoPaths = $state<string[] | null>(null);

  const sessionId = $derived(app.activeSessionId);
  const explorer = $derived(sessionId ? app.paneState(sessionId, pane) : undefined);
  const isActivePane = $derived(
    !!sessionId && (app.workspaces[sessionId]?.activePane ?? 0) === pane,
  );

  /** Pointer or keyboard focus inside this pane makes it the focused one. */
  function activate(): void {
    if (sessionId) app.setActivePane(sessionId, pane);
  }

  function toggleSplit(): void {
    if (!sessionId) return;
    if (split) app.closeExplorerSplit(sessionId, pane);
    else void app.splitExplorer(sessionId);
  }
  const rootEntries = $derived(
    explorer ? explorer.entries.filter((e) => explorer.showHidden || !e.isHidden) : [],
  );

  $effect(() => {
    if (explorer) pathInput = explorer.cwd;
  });

  function go(path: string): void {
    if (sessionId) void app.navigateExplorer(sessionId, path, pane);
  }

  function submitPath(e: SubmitEvent): void {
    e.preventDefault();
    if (pathInput.trim()) go(pathInput.trim());
  }

  /** Header "Go to parent folder" (also Alt+Up and the context menu's "Go Up"). */
  function goUp(): void {
    if (explorer && !isRoot(explorer.cwd)) go(dirname(explorer.cwd));
  }

  function goHome(): void {
    const home = app.activeSession?.home;
    if (home) go(home);
  }

  function refresh(): void {
    if (sessionId) void app.refreshExplorer(sessionId, undefined, pane);
  }

  function newEntry(kind: "file" | "folder"): void {
    if (!sessionId) return;
    const dir = app.newEntryDir(sessionId, pane);
    if (!dir) return;
    if (kind === "file") void app.createFileIn(sessionId, dir);
    else void app.createFolderIn(sessionId, dir);
  }

  function toggleHidden(): void {
    if (sessionId) app.toggleHidden(sessionId, pane);
  }

  function disconnect(): void {
    if (sessionId) void app.disconnectSession(sessionId);
  }

  function openFile(path: string): void {
    if (sessionId) void app.openFile(sessionId, path);
  }

  function onEntryContextMenu(entry: FileEntry, parentDir: string, x: number, y: number): void {
    menu = { x, y, dirPath: parentDir, entry };
  }

  function onBackgroundContextMenu(e: MouseEvent): void {
    if (e.target !== e.currentTarget || !explorer) return;
    e.preventDefault();
    // Without this the menu's own `<svelte:window oncontextmenu>` (mounted while
    // this event is still bubbling) would close it again immediately.
    e.stopPropagation();
    menu = { x: e.clientX, y: e.clientY, dirPath: explorer.cwd, entry: null };
  }

  // --- keyboard navigation (active only while the tree has focus) -----------

  function treeRows(): HTMLElement[] {
    return Array.from(treeEl?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);
  }

  function focusRow(row: HTMLElement | undefined): void {
    if (!row || !sessionId) return;
    row.focus();
    app.selectPath(sessionId, row.getAttribute("data-path"), pane);
  }

  function treeKeydown(e: KeyboardEvent): void {
    if (!sessionId || !explorer) return;
    const rows = treeRows();
    if (rows.length === 0) return;
    const idx = rows.findIndex((r) => r.getAttribute("data-path") === explorer.selected);

    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        goUp();
        return;
      }
      if (e.key === "Enter" && explorer.selected) {
        e.preventDefault();
        infoPaths = selectedPaths(sessionId, explorer.selected, pane);
        return;
      }
    }

    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        focusRow(rows[idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1)]);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        focusRow(rows[idx <= 0 ? 0 : idx - 1]);
        break;
      }
      case "ArrowRight": {
        if (idx < 0) break;
        e.preventDefault();
        const row = rows[idx];
        const path = row.getAttribute("data-path");
        if (row.getAttribute("data-dir") !== "true" || !path) break;
        if (explorer.expanded.has(path)) {
          const depth = Number(row.getAttribute("data-depth"));
          const child = rows[idx + 1];
          if (child && Number(child.getAttribute("data-depth")) > depth) focusRow(child);
        } else {
          void app.expandDir(sessionId, path, pane);
        }
        break;
      }
      case "ArrowLeft": {
        if (idx < 0) break;
        e.preventDefault();
        const row = rows[idx];
        const path = row.getAttribute("data-path");
        if (row.getAttribute("data-dir") === "true" && path && explorer.expanded.has(path)) {
          app.collapseDir(sessionId, path, pane);
        } else {
          const parent = row.getAttribute("data-parent");
          focusRow(rows.find((r) => r.getAttribute("data-path") === parent));
        }
        break;
      }
      case "F2": {
        if (idx < 0) break;
        e.preventDefault();
        void requestRename(rows[idx]);
        break;
      }
      case "Delete": {
        if (idx < 0) break;
        e.preventDefault();
        void requestDelete(rows[idx]);
        break;
      }
      case "c":
      case "C":
      case "x":
      case "X": {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) break;
        const path = explorer.selected;
        if (!path || idx < 0) break;
        e.preventDefault();
        if (e.shiftKey && e.key.toLowerCase() === "c") {
          void app.copyPath(path); // Ctrl+Shift+C: copy the path text
        } else {
          copyToClipboard(sessionId, selectedPaths(sessionId, undefined, pane), e.key.toLowerCase() === "x" ? "cut" : "copy");
        }
        break;
      }
      case "z":
      case "Z":
      case "y":
      case "Y": {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) break;
        e.preventDefault();
        const key = e.key.toLowerCase();
        const run = key === "y" || e.shiftKey ? redoFileOp : undoFileOp;
        void run(sessionId).then(keepTreeFocus);
        break;
      }
      case "v":
      case "V": {
        if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) break;
        e.preventDefault();
        const dir = app.newEntryDir(sessionId, pane);
        if (dir) void pasteClipboard(sessionId, dir, pane).then(keepTreeFocus);
        break;
      }
    }
  }

  /** Rows are re-rendered after a file op, which drops focus to <body>; hand it
   * back to the tree so the next shortcut (e.g. a second Ctrl+Z) still works. */
  function keepTreeFocus(): void {
    const active = document.activeElement;
    if (!active || active === document.body) treeEl?.focus();
  }

  async function requestRename(row: HTMLElement): Promise<void> {
    const path = row.getAttribute("data-path");
    const parent = row.getAttribute("data-parent");
    if (!sessionId || !path || parent === null) return;
    const entry = app.findEntry(sessionId, path);
    if (entry) await renameEntry(sessionId, entry, parent);
  }

  async function requestDelete(row: HTMLElement): Promise<void> {
    const path = row.getAttribute("data-path");
    const parent = row.getAttribute("data-parent");
    if (!sessionId || !path || parent === null) return;
    await deleteEntries(sessionId, selectedPaths(sessionId, path, pane));
  }

  // --- drag-and-drop inside the tree (pointer based) -----------------------------
  // Tauri's `dragDropEnabled` (needed for uploads from Windows Explorer) swallows
  // HTML5 drag events in the webview, so moving rows uses plain pointer events.
  // Dropping on a folder moves; holding Ctrl copies.

  const DRAG_THRESHOLD = 5;
  let drag: { x: number; y: number; paths: string[]; active: boolean } | null = null;
  let dropPane: number | null = null;
  let swallowClick = false;
  let dragGhost = $state<{ x: number; y: number; label: string; copy: boolean } | null>(null);

  /** Folder under the pointer in whichever pane (this one or the other) it is over. */
  function dragTarget(clientX: number, clientY: number): { pane: number; dir: string } | null {
    if (!sessionId) return null;
    const el = document.elementFromPoint(clientX, clientY);
    if (!(el instanceof Element)) return null;
    const host = el.closest<HTMLElement>("[data-explorer-pane]");
    if (!host) return null;
    const p = Number(host.getAttribute("data-explorer-pane"));
    const ex = app.paneState(sessionId, p);
    const tree = host.querySelector('[role="tree"]');
    if (!ex || !tree || !tree.contains(el)) return null;
    const row = el.closest<HTMLElement>('[role="treeitem"][data-path]');
    if (!row) return { pane: p, dir: ex.cwd };
    if (!row.hasAttribute("data-parent")) return null; // the ".." row
    const dir =
      row.getAttribute("data-dir") === "true" ? row.getAttribute("data-path") : row.getAttribute("data-parent");
    return dir ? { pane: p, dir } : null;
  }

  function validDrop(dest: string | null, paths: string[], copy: boolean): dest is string {
    if (!dest) return false;
    if (paths.some((p) => isInside(p, dest))) return false; // into itself
    if (!copy && paths.every((p) => dirname(p) === dest)) return false; // no-op move
    return true;
  }

  function clearDropTargets(): void {
    const ws = sessionId ? app.workspaces[sessionId] : undefined;
    for (const p of ws?.panes ?? []) p.dropTarget = null;
    dropPane = null;
  }

  function onTreePointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !sessionId || !explorer) return;
    const row = (e.target as Element).closest<HTMLElement>('[role="treeitem"][data-parent]');
    const path = row?.getAttribute("data-path");
    if (!row || !path) return;
    drag = { x: e.clientX, y: e.clientY, paths: selectedPaths(sessionId, path, pane), active: false };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    window.addEventListener("keydown", onDragKey, true);
  }

  function onDragMove(e: PointerEvent): void {
    if (!drag || !explorer || !sessionId) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD) return;
      drag.active = true;
      explorer.dragPaths = drag.paths;
    }
    const copy = e.ctrlKey || e.metaKey;
    const target = dragTarget(e.clientX, e.clientY);
    clearDropTargets();
    if (target && validDrop(target.dir, drag.paths, copy)) {
      const ex = app.paneState(sessionId, target.pane);
      if (ex) ex.dropTarget = target.dir;
      dropPane = target.pane;
    }
    dragGhost = {
      x: e.clientX + 12,
      y: e.clientY + 12,
      label: drag.paths.length === 1 ? basename(drag.paths[0]) : `${drag.paths.length} items`,
      copy,
    };
  }

  function endDrag(): void {
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    window.removeEventListener("keydown", onDragKey, true);
    if (explorer) explorer.dragPaths = null;
    clearDropTargets();
    dragGhost = null;
    drag = null;
  }

  function onDragKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && drag) {
      if (drag.active) swallowClick = true;
      endDrag();
    }
  }

  function onDragEnd(e: PointerEvent): void {
    const d = drag;
    const toPane = dropPane;
    const dest =
      d?.active && toPane !== null && sessionId ? (app.paneState(sessionId, toPane)?.dropTarget ?? null) : null;
    if (d?.active) {
      swallowClick = true;
      setTimeout(() => (swallowClick = false), 100);
    }
    endDrag();
    if (d && dest && sessionId && toPane !== null) {
      void transferEntries(sessionId, d.paths, dest, e.ctrlKey || e.metaKey ? "copy" : "move", toPane);
    }
  }

  function onTreeClickCapture(e: MouseEvent): void {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  }

  // --- drag-and-drop upload from Windows Explorer ----------------------------

  /** The pane (this one or the other) a physical drop position is over: its index,
   * or null when the point is outside every pane. */
  function paneAt(physicalX: number, physicalY: number): number | null {
    const ratio = window.devicePixelRatio || 1;
    const el = document.elementFromPoint(physicalX / ratio, physicalY / ratio);
    const host = el instanceof Element ? el.closest<HTMLElement>("[data-explorer-pane]") : null;
    return host ? Number(host.getAttribute("data-explorer-pane")) : null;
  }

  /** Only the pane under the cursor handles the drop (outside any pane: the focused pane). */
  function ownsDrop(physicalX: number, physicalY: number): boolean {
    const at = paneAt(physicalX, physicalY);
    return at === null ? isActivePane : at === pane;
  }

  /** Resolves the drop target directory from a physical drop position: the
   * nearest tree row under the cursor (a file row's parent, a dir row itself),
   * or the explorer's current root if the drop lands on empty tree space. */
  function resolveDropDir(physicalX: number, physicalY: number): string | null {
    if (!explorer) return null;
    const ratio = window.devicePixelRatio || 1;
    const el = document.elementFromPoint(physicalX / ratio, physicalY / ratio);
    const row = el instanceof Element ? el.closest<HTMLElement>("[data-path]") : null;
    if (!row) return explorer.cwd;
    return row.getAttribute("data-dir") === "true"
      ? row.getAttribute("data-path")
      : row.getAttribute("data-parent");
  }

  function onDragDropEvent(e: api.DragDropEvent): void {
    if (!sessionId || !explorer) return;
    if (e.type === "leave") {
      explorer.dropTarget = null;
      return;
    }
    const mine = ownsDrop(e.position.x, e.position.y);
    if (e.type === "enter" || e.type === "over") {
      explorer.dropTarget = mine ? resolveDropDir(e.position.x, e.position.y) : null;
    } else if (e.type === "drop") {
      explorer.dropTarget = null;
      if (!mine) return;
      const dir = resolveDropDir(e.position.x, e.position.y) ?? explorer.cwd;
      void app.uploadDroppedFiles(sessionId, e.paths, dir);
    }
  }

  let unlistenDrop: UnlistenFn | undefined;
  let destroyed = false;
  onMount(() => {
    api
      .onDragDrop(onDragDropEvent)
      .then((fn) => {
        // Unmounted before the listener was registered (fast view switch): a
        // leaked listener would upload every later drop a second time.
        if (destroyed) fn();
        else unlistenDrop = fn;
      })
      .catch((err) => console.error("drag-drop listener failed", err));
  });
  onDestroy(() => {
    destroyed = true;
    endDrag();
    unlistenDrop?.();
  });
</script>

<div
  class={`relative flex h-full min-h-0 min-w-0 flex-1 flex-col ${split && isActivePane ? "shadow-[inset_2px_0_0_var(--primary)]" : ""}`}
  data-explorer-pane={pane}
  data-active={isActivePane}
  data-testid="explorer-pane"
  onpointerdowncapture={activate}
  onfocusin={activate}
  role="presentation"
>
  {#if sessionId && explorer}
    <div class="flex flex-none flex-col gap-0.5 border-b border-border px-1.5 py-1">
      <div class="flex items-center gap-0.5">
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              onclick={goUp}
              disabled={isRoot(explorer.cwd)}
              aria-label="Go to parent folder"
              data-testid="explorer-go-up"
            >
              <ArrowUpIcon class="size-3.5" />
            </button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>Go to parent folder (Alt+Up)</Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              onclick={goHome}
              aria-label="Go to home folder"
              data-testid="explorer-go-home"
            >
              <HouseIcon class="size-3.5" />
            </button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>Go to home folder</Tooltip.Content>
      </Tooltip.Root>
      <form class="min-w-0 flex-1" onsubmit={submitPath}>
        <input
          type="text"
          class="h-6 w-full rounded-sm border border-transparent bg-transparent px-1.5 text-[12px] text-foreground hover:border-border focus:border-ring focus:bg-background focus:outline-none"
          bind:value={pathInput}
          spellcheck="false"
          aria-label="Path"
        />
      </form>
      </div>
      <div class="flex items-center gap-0.5">
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              onclick={() => newEntry("file")}
              aria-label="New file"
            >
              <FilePlusIcon class="size-3.5" />
            </button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>New file (Ctrl+N)</Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              onclick={() => newEntry("folder")}
              aria-label="New folder"
            >
              <FolderPlusIcon class="size-3.5" />
            </button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>New folder (Ctrl+Shift+N)</Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              onclick={refresh}
              aria-label="Refresh"
            >
              <RefreshCwIcon class="size-3.5" />
            </button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>Refresh (F5)</Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class={`flex size-6 items-center justify-center rounded-sm hover:bg-accent hover:text-foreground ${explorer.showHidden ? "text-primary" : "text-muted-foreground"}`}
              onclick={toggleHidden}
              aria-label="Toggle hidden files"
            >
              {#if explorer.showHidden}<EyeIcon class="size-3.5" />{:else}<EyeOffIcon class="size-3.5" />{/if}
            </button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>Toggle hidden files</Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class={`flex size-6 items-center justify-center rounded-sm hover:bg-accent hover:text-foreground ${split ? "text-primary" : "text-muted-foreground"}`}
              onclick={toggleSplit}
              aria-label={split ? "Close split" : "Split explorer"}
              aria-pressed={split}
              data-testid="explorer-split"
            >
              {#if split}<PanelTopCloseIcon class="size-3.5" />{:else}<SquareSplitVerticalIcon class="size-3.5" />{/if}
            </button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>{split ? "Close split (keep this pane)" : "Split explorer"}</Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onclick={disconnect}
              aria-label="Disconnect"
            >
              <PowerIcon class="size-3.5" />
            </button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content>Disconnect</Tooltip.Content>
      </Tooltip.Root>
      </div>
    </div>

    <div
      class={`min-h-0 flex-1 overflow-auto py-1 outline-none ${explorer.dropTarget === explorer.cwd ? "outline-2 -outline-offset-2 outline-dashed outline-primary" : ""} ${explorer.dragPaths ? "select-none" : ""}`}
      role="tree"
      tabindex="0"
      bind:this={treeEl}
      onkeydown={treeKeydown}
      onpointerdown={onTreePointerDown}
      onclickcapture={onTreeClickCapture}
      oncontextmenu={onBackgroundContextMenu}
    >
      {#if !isRoot(explorer.cwd)}
        {@const parentPath = dirname(explorer.cwd)}
        <div
          class={`relative flex h-[22px] cursor-pointer items-center gap-1 pr-1.5 pl-[4px] text-[13px] text-sidebar-foreground hover:bg-accent ${explorer.selected === parentPath ? "bg-accent" : ""}`}
          role="treeitem"
          aria-label="Go to parent directory"
          aria-selected={explorer.selected === parentPath}
          tabindex="0"
          data-path={parentPath}
          data-parent={null}
          data-dir="false"
          data-depth={0}
          data-testid="explorer-up-row"
          onclick={() => go(parentPath)}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              go(parentPath);
            }
          }}
        >
          <CornerLeftUpIcon class="size-3.5 shrink-0 text-muted-foreground" />
          <span>..</span>
        </div>
      {/if}
      {#if explorer.loading}
        <div class="px-2.5 py-2 text-[12px] text-muted-foreground">Loading…</div>
      {:else if explorer.error}
        <div class="px-2.5 py-2 text-[12px] text-destructive">{explorer.error}</div>
      {:else if rootEntries.length === 0}
        <div class="px-2.5 py-2 text-[12px] text-muted-foreground">Empty directory.</div>
      {:else}
        {#each rootEntries as entry (entry.path)}
          <TreeNode
            {entry}
            sessionId={sessionId}
            {pane}
            depth={0}
            parentDir={explorer.cwd}
            onOpenFile={openFile}
            onContextMenu={onEntryContextMenu}
          />
        {/each}
      {/if}
    </div>
  {:else}
    <div class="px-2.5 py-2 text-[12px] text-muted-foreground">Not connected.</div>
  {/if}
</div>

{#if dragGhost}
  <div
    class="pointer-events-none fixed z-[400] rounded-sm border border-border bg-popover px-2 py-0.5 text-[12px] text-popover-foreground shadow-md"
    style={`left:${dragGhost.x}px; top:${dragGhost.y}px;`}
    data-testid="drag-ghost"
  >
    {dragGhost.copy ? "+ " : ""}{dragGhost.label}
  </div>
{/if}

{#if menu && sessionId}
  <ContextMenu
    sessionId={sessionId}
    x={menu.x}
    y={menu.y}
    dirPath={menu.dirPath}
    entry={menu.entry}
    {pane}
    onClose={() => (menu = null)}
    onInfo={(paths) => (infoPaths = paths)}
  />
{/if}

{#if infoPaths && sessionId}
  <FileInfoDialog {sessionId} paths={infoPaths} onClose={() => (infoPaths = null)} />
{/if}
