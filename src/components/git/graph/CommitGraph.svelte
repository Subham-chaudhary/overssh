<script lang="ts">
  // Virtualized commit graph list with ref badges and the commit / badge context menu
  // (docs/GUIDE.md §14.4.G2).
  import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
  import Loader from "../../Loader.svelte";
  import GraphCell, { LANE_W, ROW_H } from "./GraphCell.svelte";
  import RefBadge from "./RefBadge.svelte";
  import { layoutGraph, UNCOMMITTED, withUncommitted, type GraphRow } from "../../../lib/git/graph";
  import { formatAbsolute, formatRelative, matchesQuery, shortSha, type GitCommit, type GitRef } from "../../../lib/git/log";
  import {
    checkoutDetached,
    checkoutRef,
    cherryPick,
    copyText,
    createBranchAt,
    createTagAt,
    deleteRef,
    mergeRef,
    resetTo,
    revertCommit,
  } from "./actions";
  import type { GraphData } from "./graphData.svelte";

  let {
    data,
    selected,
    query,
    width,
    onselect,
  }: {
    data: GraphData;
    /** Selected commit sha, `UNCOMMITTED`, or null. */
    selected: string | null;
    query: string;
    /** Width of the whole page, for hiding columns. */
    width: number;
    onselect: (sha: string) => void;
  } = $props();

  interface Item {
    sha: string;
    row: GraphRow;
    commit: GitCommit | null;
  }

  const filtering = $derived(query.trim() !== "");
  const hasUncommitted = $derived(data.dirty.length > 0 && data.headSha !== null && data.commits.some((c) => c.sha === data.headSha));

  const layout = $derived(
    layoutGraph(hasUncommitted ? withUncommitted(data.commits, data.headSha as string) : data.commits),
  );

  const items = $derived.by((): Item[] => {
    const out: Item[] = [];
    const offset = hasUncommitted ? 1 : 0;
    if (hasUncommitted && !filtering) out.push({ sha: UNCOMMITTED, row: layout.rows[0], commit: null });
    data.commits.forEach((c, i) => {
      if (!filtering || matchesQuery(c, query)) out.push({ sha: c.sha, row: layout.rows[i + offset], commit: c });
    });
    return out;
  });

  const graphW = $derived(Math.min(Math.max(layout.maxLanes, 1), 10) * LANE_W + 8);
  const showAuthor = $derived(width >= 560);
  const showDate = $derived(width >= 440);

  let scroller: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let viewH = $state(400);
  const OVERSCAN = 8;
  const start = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN));
  const end = $derived(Math.min(items.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN));
  const visible = $derived(items.slice(start, end));

  // Keep the selected row in view when the selection changes.
  $effect(() => {
    const sel = selected;
    if (!sel || !scroller) return;
    const idx = items.findIndex((i) => i.sha === sel);
    if (idx < 0) return;
    const top = idx * ROW_H;
    const st = scroller.scrollTop;
    if (top < st) scroller.scrollTop = top;
    else if (top + ROW_H > st + scroller.clientHeight) scroller.scrollTop = top + ROW_H - scroller.clientHeight;
  });

  function onKey(e: KeyboardEvent): void {
    if (items.length === 0) return;
    const cur = items.findIndex((i) => i.sha === selected);
    let next = -1;
    if (e.key === "ArrowDown") next = Math.min(items.length - 1, cur + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, cur < 0 ? 0 : cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "PageDown") next = Math.min(items.length - 1, Math.max(0, cur) + Math.floor(viewH / ROW_H));
    else if (e.key === "PageUp") next = Math.max(0, Math.max(0, cur) - Math.floor(viewH / ROW_H));
    else return;
    e.preventDefault();
    onselect(items[next].sha);
  }

  // --- context menu ------------------------------------------------------------
  let ctx = $state<{ commit: GitCommit | null; ref: GitRef | null }>({ commit: null, ref: null });

  function onRowContext(e: MouseEvent, item: Item): void {
    const badge = (e.target as HTMLElement).closest<HTMLElement>("[data-ref-name]");
    const ref = badge && item.commit ? (item.commit.refs.find((r) => r.name === badge.dataset.refName && r.kind === badge.dataset.refKind) ?? null) : null;
    ctx = { commit: item.commit, ref };
  }

  const isMerge = $derived((ctx.commit?.parents.length ?? 0) > 1);
  const refIsCurrent = $derived(ctx.ref?.current === true);
</script>

<div class="flex h-full min-h-0 flex-col text-[12px]" data-testid="commit-graph">
  <div class="flex h-6 flex-none items-center border-b border-border bg-sidebar px-2 text-[11px] text-muted-foreground select-none">
    <div style={`width:${graphW}px`} class="shrink-0">Graph</div>
    <div class="min-w-0 flex-1 px-1">Description</div>
    {#if showAuthor}<div class="w-[130px] shrink-0 px-1">Author</div>{/if}
    {#if showDate}<div class="w-[100px] shrink-0 px-1">Date</div>{/if}
    <div class="w-[60px] shrink-0 px-1 text-right">Commit</div>
  </div>

  <ContextMenu.Root>
    <ContextMenu.Trigger class="block min-h-0 flex-1">
      <div
        bind:this={scroller}
        bind:clientHeight={viewH}
        class="h-full overflow-auto outline-none"
        role="listbox"
        aria-label="Commits"
        tabindex="0"
        data-testid="commit-list"
        onscroll={(e) => (scrollTop = (e.currentTarget as HTMLDivElement).scrollTop)}
        onkeydown={onKey}
      >
        <div class="relative" style={`height:${items.length * ROW_H}px`}>
          {#each visible as item, k (item.sha)}
            {@const i = start + k}
            {@const c = item.commit}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
            <div
              role="option"
              aria-selected={selected === item.sha}
              data-testid={c ? "git-row" : "git-row-uncommitted"}
              data-sha={item.sha}
              class={[
                "absolute inset-x-0 flex cursor-default items-center px-2 select-none",
                selected === item.sha ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
              ]}
              style={`top:${i * ROW_H}px;height:${ROW_H}px`}
              onclick={() => onselect(item.sha)}
              oncontextmenu={(e) => onRowContext(e, item)}
            >
              <div style={`width:${graphW}px`} class="shrink-0 overflow-hidden">
                <GraphCell row={item.row} width={graphW} head={c !== null && c.sha === data.headSha} hollow={c === null} plain={filtering} />
              </div>
              <div class="flex min-w-0 flex-1 items-center gap-1.5 px-1">
                {#if c}
                  {#each c.refs as r (r.kind + r.name)}
                    <RefBadge ref={r} />
                  {/each}
                  <span class="truncate" title={c.subject}>{c.subject}</span>
                {:else}
                  <span class="truncate italic text-muted-foreground">Uncommitted Changes ({data.dirty.length})</span>
                {/if}
              </div>
              {#if showAuthor}
                <div class="w-[130px] shrink-0 truncate px-1 text-muted-foreground" title={c ? `${c.authorName} <${c.authorEmail}>` : undefined}>
                  {c?.authorName ?? ""}
                </div>
              {/if}
              {#if showDate}
                <div class="w-[100px] shrink-0 truncate px-1 text-muted-foreground" title={c ? formatAbsolute(c.authorDate) : undefined}>
                  {c ? formatRelative(c.authorDate) : ""}
                </div>
              {/if}
              <div class="w-[60px] shrink-0 px-1 text-right font-mono text-[11px] text-muted-foreground">{c ? shortSha(c.sha) : "*"}</div>
            </div>
          {/each}
        </div>

        {#if items.length === 0}
          <div class="flex items-center justify-center p-6 text-muted-foreground" data-testid="graph-empty">
            {#if !data.loaded}
              <Loader label="Loading commits" />
            {:else if filtering}
              No commits match "{query.trim()}".
            {:else if data.error}
              {data.error}
            {:else}
              No commits yet.
            {/if}
          </div>
        {/if}
      </div>
    </ContextMenu.Trigger>

    <ContextMenu.Content class="min-w-52" data-testid="commit-menu">
      {#if !ctx.commit}
        <ContextMenu.Item disabled>No actions for uncommitted changes</ContextMenu.Item>
      {:else}
        {#if ctx.ref}
          {@const ref = ctx.ref}
          <ContextMenu.Label class="text-[11px]">{ref.kind === "head" ? "HEAD" : ref.name}</ContextMenu.Label>
          {#if !refIsCurrent}
            <ContextMenu.Item data-testid="ref-checkout" onclick={() => void checkoutRef(ref, data.localBranches)}>
              Checkout {ref.kind === "tag" ? "Tag (detached)" : "Branch"}
            </ContextMenu.Item>
          {/if}
          {#if (ref.kind === "branch" || ref.kind === "remote") && !refIsCurrent}
            <ContextMenu.Item data-testid="ref-merge" onclick={() => void mergeRef(ref)}>Merge into Current Branch</ContextMenu.Item>
          {/if}
          {#if (ref.kind === "branch" && !refIsCurrent) || ref.kind === "tag"}
            <ContextMenu.Item variant="destructive" data-testid="ref-delete" onclick={() => void deleteRef(ref)}>
              Delete {ref.kind === "tag" ? "Tag" : "Branch"}
            </ContextMenu.Item>
          {/if}
          <ContextMenu.Item onclick={() => void copyText(ref.name, ref.kind === "tag" ? "tag name" : "branch name")}>
            Copy {ref.kind === "tag" ? "Tag" : "Branch"} Name
          </ContextMenu.Item>
          <ContextMenu.Separator />
        {/if}
        {@const commit = ctx.commit}
        <ContextMenu.Item data-testid="ctx-checkout" onclick={() => void checkoutDetached(commit.sha)}>Checkout (Detached HEAD)</ContextMenu.Item>
        <ContextMenu.Item data-testid="ctx-branch" onclick={() => void createBranchAt(commit.sha)}>Create Branch Here...</ContextMenu.Item>
        <ContextMenu.Item data-testid="ctx-tag" onclick={() => void createTagAt(commit.sha)}>Create Tag Here...</ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item data-testid="ctx-cherry-pick" onclick={() => void cherryPick(commit.sha, isMerge)}>Cherry-pick</ContextMenu.Item>
        <ContextMenu.Item data-testid="ctx-revert" onclick={() => void revertCommit(commit.sha, isMerge)}>Revert</ContextMenu.Item>
        <ContextMenu.Sub>
          <ContextMenu.SubTrigger data-testid="ctx-reset">Reset Current Branch to Here</ContextMenu.SubTrigger>
          <ContextMenu.SubContent>
            <ContextMenu.Item data-testid="ctx-reset-soft" onclick={() => void resetTo(commit.sha, "soft")}>Soft (keep changes staged)</ContextMenu.Item>
            <ContextMenu.Item data-testid="ctx-reset-mixed" onclick={() => void resetTo(commit.sha, "mixed")}>Mixed (keep changes unstaged)</ContextMenu.Item>
            <ContextMenu.Item variant="destructive" data-testid="ctx-reset-hard" onclick={() => void resetTo(commit.sha, "hard")}>Hard (discard changes)</ContextMenu.Item>
          </ContextMenu.SubContent>
        </ContextMenu.Sub>
        <ContextMenu.Separator />
        <ContextMenu.Item data-testid="ctx-copy-sha" onclick={() => void copyText(commit.sha, "SHA")}>Copy SHA</ContextMenu.Item>
        <ContextMenu.Item data-testid="ctx-copy-subject" onclick={() => void copyText(commit.subject, "subject")}>Copy Subject</ContextMenu.Item>
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Root>

  {#if data.hasMore}
    <div class="flex h-8 flex-none items-center justify-center gap-2 border-t border-border bg-sidebar text-[12px]">
      <span class="text-muted-foreground">{data.commits.length} commits loaded</span>
      <button
        type="button"
        class="rounded-md border border-border bg-secondary px-2 py-0.5 text-secondary-foreground hover:opacity-90 disabled:opacity-50"
        disabled={data.loading}
        data-testid="graph-load-more"
        onclick={() => data.loadMore()}
      >
        Load more
      </button>
    </div>
  {/if}
</div>
