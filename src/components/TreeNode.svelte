<script lang="ts">
  import { app } from "../lib/stores.svelte";
  import type { FileEntry } from "../lib/types";
  import TreeNode from "./TreeNode.svelte";

  let {
    entry,
    sessionId,
    depth,
    parentDir,
    onOpenFile,
    onContextMenu,
  }: {
    entry: FileEntry;
    sessionId: string;
    depth: number;
    parentDir: string;
    onOpenFile: (path: string) => void;
    onContextMenu: (entry: FileEntry, parentDir: string, x: number, y: number) => void;
  } = $props();

  // Expand/selection/children state lives in the store (ExplorerState), keyed
  // by path, so a mutation only needs to refresh the affected node — see
  // `app.refreshDir` — instead of collapsing/rebuilding the whole tree.
  const ex = $derived(app.explorers[sessionId]);
  const isDir = $derived(
    entry.kind === "dir" || (entry.kind === "symlink" && entry.linkTargetIsDir === true),
  );
  const expanded = $derived(ex?.expanded.has(entry.path) ?? false);
  const node = $derived(ex?.children[entry.path]);
  const selected = $derived(ex?.selected === entry.path);
  const isDropTarget = $derived(isDir && ex?.dropTarget === entry.path);
  const visibleChildren = $derived(
    node?.entries ? (ex?.showHidden ? node.entries : node.entries.filter((c) => !c.isHidden)) : [],
  );

  function select(): void {
    app.selectPath(sessionId, entry.path);
  }

  function onClick(): void {
    select();
    if (isDir) {
      void app.toggleExpandDir(sessionId, entry.path);
    } else {
      onOpenFile(entry.path);
    }
  }

  function onDblClick(): void {
    if (!isDir) onOpenFile(entry.path);
  }

  function rowKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  }

  function rowContextMenu(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    select();
    onContextMenu(entry, parentDir, e.clientX, e.clientY);
  }
</script>

<div class="node">
  <div
    class="row"
    class:selected
    class:drop-target={isDropTarget}
    style={`padding-left:${depth * 14 + 6}px`}
    role="treeitem"
    aria-expanded={isDir ? expanded : undefined}
    aria-selected={selected}
    tabindex="0"
    data-path={entry.path}
    data-parent={parentDir}
    data-dir={isDir}
    data-depth={depth}
    onclick={onClick}
    ondblclick={onDblClick}
    onkeydown={rowKeydown}
    oncontextmenu={rowContextMenu}
  >
    {#if isDir}
      <span class="arrow" class:open={expanded}>▸</span>
    {:else}
      <span class="arrow spacer"></span>
    {/if}
    <span class="icon" aria-hidden="true">
      {#if isDir}
        <svg viewBox="0 0 16 16" width="13" height="13">
          <path
            fill="currentColor"
            d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.379a1.5 1.5 0 0 1 1.06.44l.622.62A1.5 1.5 0 0 0 8.62 3.5H13.5A1.5 1.5 0 0 1 15 5v6.5A1.5 1.5 0 0 1 13.5 13h-11A1.5 1.5 0 0 1 1 11.5v-8Z"
          />
        </svg>
      {:else}
        <svg viewBox="0 0 16 16" width="13" height="13">
          <path fill="currentColor" opacity="0.85" d="M4 1.5A1.5 1.5 0 0 1 5.5 0H9l4 4v10.5A1.5 1.5 0 0 1 11.5 16h-6A1.5 1.5 0 0 1 4 14.5v-13Z" />
          <path fill="currentColor" opacity="0.5" d="M9 0v3.5A1.5 1.5 0 0 0 10.5 5H14L9 0Z" />
        </svg>
      {/if}
    </span>
    <span class="name">{entry.name}</span>
    {#if entry.kind === "symlink"}<span class="hint">→</span>{/if}
  </div>
  {#if isDir && expanded}
    {#if node?.loading}
      <div class="state muted" style={`padding-left:${(depth + 1) * 14 + 6}px`}>Loading…</div>
    {:else if node?.error}
      <div class="state error" style={`padding-left:${(depth + 1) * 14 + 6}px`}>{node.error}</div>
    {:else}
      {#each visibleChildren as child (child.path)}
        <TreeNode
          entry={child}
          {sessionId}
          depth={depth + 1}
          parentDir={entry.path}
          {onOpenFile}
          {onContextMenu}
        />
      {/each}
    {/if}
  {/if}
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px 2px 0;
    cursor: pointer;
    white-space: nowrap;
    color: var(--fg);
    border: 1px solid transparent;
  }
  .row:hover {
    background: var(--bg-hover);
  }
  .row.selected {
    background: var(--bg-active);
    color: var(--fg-strong);
  }
  .row.drop-target {
    border-color: var(--accent);
    background: var(--bg-hover);
  }
  .arrow {
    width: 12px;
    flex: none;
    display: inline-block;
    font-size: 9px;
    color: var(--muted);
    transition: transform 0.1s ease;
  }
  .arrow.open {
    transform: rotate(90deg);
  }
  .arrow.spacer {
    visibility: hidden;
  }
  .icon {
    flex: none;
    display: inline-flex;
    color: var(--accent);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hint {
    color: var(--muted);
    font-size: 10px;
  }
  .state {
    padding-top: 2px;
    padding-bottom: 2px;
    font-size: 11px;
  }
  .muted {
    color: var(--muted);
  }
  .error {
    color: var(--danger);
  }
</style>
