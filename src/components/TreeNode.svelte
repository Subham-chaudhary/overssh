<script lang="ts">
  import { app } from "../lib/stores.svelte";
  import { isCut, isRowSelected, modifierSelect } from "../lib/fileops.svelte";
  import type { FileEntry } from "../lib/types";
  import TreeNode from "./TreeNode.svelte";
  import Loader from "./Loader.svelte";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import FileTypeIcon from "./FileTypeIcon.svelte";
  import CornerDownRightIcon from "@lucide/svelte/icons/corner-down-right";

  let {
    entry,
    sessionId,
    pane = 0,
    depth,
    parentDir,
    onOpenFile,
    onContextMenu,
  }: {
    entry: FileEntry;
    sessionId: string;
    /** Explorer pane (§15.3.S) whose expand/selection state this row shows. */
    pane?: number;
    depth: number;
    parentDir: string;
    onOpenFile: (path: string) => void;
    onContextMenu: (entry: FileEntry, parentDir: string, x: number, y: number) => void;
  } = $props();

  // Expand/selection/children state lives in the store (ExplorerState), keyed
  // by path, so a mutation only needs to refresh the affected node — see
  // `app.refreshDir` — instead of collapsing/rebuilding the whole tree.
  const ex = $derived(app.paneState(sessionId, pane));
  const isDir = $derived(
    entry.kind === "dir" || (entry.kind === "symlink" && entry.linkTargetIsDir === true),
  );
  const expanded = $derived(ex?.expanded.has(entry.path) ?? false);
  const node = $derived(ex?.children[entry.path]);
  const selected = $derived(isRowSelected(sessionId, entry.path, pane));
  const cut = $derived(isCut(sessionId, entry.path));
  const isDropTarget = $derived(isDir && ex?.dropTarget === entry.path);
  const visibleChildren = $derived(
    node?.entries ? (ex?.showHidden ? node.entries : node.entries.filter((c) => !c.isHidden)) : [],
  );

  function select(): void {
    app.selectPath(sessionId, entry.path, pane);
  }

  function onClick(e?: MouseEvent): void {
    if (e && modifierSelect(sessionId, entry.path, e, pane)) return;
    select();
    if (isDir) {
      void app.toggleExpandDir(sessionId, entry.path, pane);
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
    if (!selected) select();
    onContextMenu(entry, parentDir, e.clientX, e.clientY);
  }
</script>

<div>
  <div
    class={`relative flex h-[22px] cursor-pointer items-center gap-1 border border-transparent pr-1.5 text-[13px] whitespace-nowrap text-sidebar-foreground hover:bg-accent ${selected ? "bg-accent" : ""} ${isDropTarget ? "border-primary bg-accent" : ""} ${cut ? "opacity-50" : ""}`}
    style={`padding-left:${depth * 14 + 4}px`}
    role="treeitem"
    aria-expanded={isDir ? expanded : undefined}
    aria-selected={selected}
    tabindex="0"
    data-path={entry.path}
    data-parent={parentDir}
    data-dir={isDir}
    data-depth={depth}
    onclick={(e) => onClick(e)}
    ondblclick={onDblClick}
    onkeydown={rowKeydown}
    oncontextmenu={rowContextMenu}
  >
    {#each Array(depth) as _, i (i)}
      <span class="pointer-events-none absolute top-0 bottom-0 w-px bg-border/70" style={`left:${i * 14 + 11}px`}></span>
    {/each}
    {#if isDir}
      <ChevronRightIcon
        class={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-100 ${expanded ? "rotate-90" : ""}`}
      />
    {:else}
      <span class="inline-block size-3.5 shrink-0"></span>
    {/if}
    <span class="flex shrink-0 items-center text-muted-foreground">
      <FileTypeIcon name={entry.name} {isDir} isOpen={expanded} class="size-4" />
    </span>
    <span class="overflow-hidden text-ellipsis">{entry.name}</span>
    {#if entry.kind === "symlink"}
      <CornerDownRightIcon class="size-3 shrink-0 text-muted-foreground" />
    {/if}
  </div>
  {#if isDir && expanded}
    {#if node?.loading}
      <div class="py-0.5 text-[11px]" style={`padding-left:${(depth + 1) * 14 + 4}px`}>
        <Loader />
      </div>
    {:else if node?.error}
      <div
        class="py-0.5 text-[11px] text-destructive"
        style={`padding-left:${(depth + 1) * 14 + 4}px`}
      >
        {node.error}
      </div>
    {:else}
      {#each visibleChildren as child (child.path)}
        <TreeNode
          entry={child}
          {sessionId}
          {pane}
          depth={depth + 1}
          parentDir={entry.path}
          {onOpenFile}
          {onContextMenu}
        />
      {/each}
    {/if}
  {/if}
</div>
