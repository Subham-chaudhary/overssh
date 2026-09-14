<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { app } from "../lib/stores.svelte";
  import * as api from "../lib/api";
  import { dirname, isRoot } from "../lib/paths";
  import TreeNode from "./TreeNode.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import type { FileEntry } from "../lib/types";
  import type { UnlistenFn } from "@tauri-apps/api/event";

  let pathInput = $state("");
  let menu = $state<{ x: number; y: number; dirPath: string; entry: FileEntry | null } | null>(
    null,
  );
  let treeEl: HTMLDivElement | undefined = $state();

  const sessionId = $derived(app.activeSessionId);
  const explorer = $derived(app.activeExplorer);
  const rootEntries = $derived(
    explorer ? explorer.entries.filter((e) => explorer.showHidden || !e.isHidden) : [],
  );

  $effect(() => {
    if (explorer) pathInput = explorer.cwd;
  });

  function go(path: string): void {
    if (sessionId) void app.navigateExplorer(sessionId, path);
  }

  function submitPath(e: SubmitEvent): void {
    e.preventDefault();
    if (pathInput.trim()) go(pathInput.trim());
  }

  function up(): void {
    if (explorer && !isRoot(explorer.cwd)) go(dirname(explorer.cwd));
  }

  function refresh(): void {
    if (sessionId) void app.refreshExplorer(sessionId);
  }

  function toggleHidden(): void {
    if (sessionId) app.toggleHidden(sessionId);
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
    menu = { x: e.clientX, y: e.clientY, dirPath: explorer.cwd, entry: null };
  }

  // --- keyboard navigation (active only while the tree has focus) -----------

  function treeRows(): HTMLElement[] {
    return Array.from(treeEl?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);
  }

  function focusRow(row: HTMLElement | undefined): void {
    if (!row || !sessionId) return;
    row.focus();
    app.selectPath(sessionId, row.getAttribute("data-path"));
  }

  function treeKeydown(e: KeyboardEvent): void {
    if (!sessionId || !explorer) return;
    const rows = treeRows();
    if (rows.length === 0) return;
    const idx = rows.findIndex((r) => r.getAttribute("data-path") === explorer.selected);

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
          void app.expandDir(sessionId, path);
        }
        break;
      }
      case "ArrowLeft": {
        if (idx < 0) break;
        e.preventDefault();
        const row = rows[idx];
        const path = row.getAttribute("data-path");
        if (row.getAttribute("data-dir") === "true" && path && explorer.expanded.has(path)) {
          app.collapseDir(sessionId, path);
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
      case "C": {
        if ((e.ctrlKey || e.metaKey) && idx >= 0) {
          e.preventDefault();
          const path = rows[idx].getAttribute("data-path");
          if (path) void app.copyPath(path);
        }
        break;
      }
    }
  }

  async function requestRename(row: HTMLElement): Promise<void> {
    const path = row.getAttribute("data-path");
    const parent = row.getAttribute("data-parent");
    if (!sessionId || !path || parent === null) return;
    const entry = app.findEntry(sessionId, path);
    if (entry) await app.renameEntry(sessionId, entry, parent);
  }

  async function requestDelete(row: HTMLElement): Promise<void> {
    const path = row.getAttribute("data-path");
    const parent = row.getAttribute("data-parent");
    if (!sessionId || !path || parent === null) return;
    const entry = app.findEntry(sessionId, path);
    if (entry) await app.deleteEntry(sessionId, entry, parent);
  }

  // --- drag-and-drop upload from Windows Explorer ----------------------------

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
    if (e.type === "enter" || e.type === "over") {
      explorer.dropTarget = resolveDropDir(e.position.x, e.position.y);
    } else if (e.type === "leave") {
      explorer.dropTarget = null;
    } else if (e.type === "drop") {
      const dir = resolveDropDir(e.position.x, e.position.y) ?? explorer.cwd;
      explorer.dropTarget = null;
      void app.uploadDroppedFiles(sessionId, e.paths, dir);
    }
  }

  let unlistenDrop: UnlistenFn | undefined;
  onMount(() => {
    void api.onDragDrop(onDragDropEvent).then((fn) => {
      unlistenDrop = fn;
    });
  });
  onDestroy(() => {
    unlistenDrop?.();
  });
</script>

<div class="explorer">
  {#if app.sessions.length > 1}
    <div class="session-picker">
      <select
        value={app.activeSessionId}
        onchange={(e) => app.setActiveSession((e.currentTarget as HTMLSelectElement).value)}
      >
        {#each app.sessions as s (s.id)}
          <option value={s.id}>{s.label}</option>
        {/each}
      </select>
    </div>
  {/if}

  {#if sessionId && explorer}
    <div class="toolbar">
      <button type="button" title="Up a directory" onclick={up} disabled={isRoot(explorer.cwd)}
        >⬆</button
      >
      <form class="path-form" onsubmit={submitPath}>
        <input type="text" bind:value={pathInput} spellcheck="false" aria-label="Path" />
      </form>
      <button type="button" title="Refresh" onclick={refresh}>⟳</button>
      <button
        type="button"
        title="Toggle hidden files"
        class="toggle"
        class:active={explorer.showHidden}
        onclick={toggleHidden}
      >
        •
      </button>
      <button type="button" title="Disconnect" class="danger-btn" onclick={disconnect}>⏻</button>
    </div>

    <div
      class="tree"
      role="tree"
      tabindex="0"
      class:drop-target={explorer.dropTarget === explorer.cwd}
      bind:this={treeEl}
      onkeydown={treeKeydown}
      oncontextmenu={onBackgroundContextMenu}
    >
      {#if explorer.loading}
        <div class="state muted">Loading…</div>
      {:else if explorer.error}
        <div class="state error">{explorer.error}</div>
      {:else if rootEntries.length === 0}
        <div class="state muted">Empty directory.</div>
      {:else}
        {#each rootEntries as entry (entry.path)}
          <TreeNode
            {entry}
            sessionId={sessionId}
            depth={0}
            parentDir={explorer.cwd}
            onOpenFile={openFile}
            onContextMenu={onEntryContextMenu}
          />
        {/each}
      {/if}
    </div>
  {:else}
    <div class="state muted">Not connected.</div>
  {/if}
</div>

{#if menu && sessionId}
  <ContextMenu
    sessionId={sessionId}
    x={menu.x}
    y={menu.y}
    dirPath={menu.dirPath}
    entry={menu.entry}
    onClose={() => (menu = null)}
  />
{/if}

<style>
  .explorer {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .session-picker {
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
  }
  .session-picker select {
    width: 100%;
    background: var(--bg-alt);
    color: var(--fg-strong);
    border: 1px solid var(--border);
    padding: 4px 6px;
    border-radius: 3px;
    font: inherit;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .toolbar button {
    background: transparent;
    border: 1px solid transparent;
    color: var(--fg);
    padding: 3px 6px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    flex: none;
  }
  .toolbar button:hover {
    background: var(--bg-hover);
  }
  .toolbar button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .toolbar button.toggle.active {
    color: var(--accent);
    border-color: var(--accent);
  }
  .toolbar button.danger-btn:hover {
    color: var(--danger);
  }
  .path-form {
    flex: 1;
    min-width: 0;
  }
  .path-form input {
    width: 100%;
    background: var(--bg-alt);
    border: 1px solid var(--border);
    color: var(--fg-strong);
    padding: 4px 6px;
    border-radius: 3px;
    font: inherit;
    font-size: 12px;
  }
  .tree {
    flex: 1;
    overflow: auto;
    min-height: 0;
    padding: 4px 0;
    outline: none;
  }
  .tree.drop-target {
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
  }
  .state {
    padding: 12px 10px;
    font-size: 12px;
  }
  .muted {
    color: var(--muted);
  }
  .error {
    color: var(--danger);
  }
</style>
