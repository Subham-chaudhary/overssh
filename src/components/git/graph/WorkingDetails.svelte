<script lang="ts">
  // Details pane for the "Uncommitted Changes" row (docs/GUIDE.md §14.4.G2).
  import FileTypeIcon from "../../FileTypeIcon.svelte";
  import XIcon from "@lucide/svelte/icons/x";
  import type { WorkingChange } from "../../../lib/git/diff";

  let {
    changes,
    onclose,
    onpick,
  }: { changes: readonly WorkingChange[]; onclose: () => void; onpick: (c: WorkingChange) => void } = $props();

  const staged = $derived(changes.filter((c) => c.staged));
  const unstaged = $derived(changes.filter((c) => !c.staged));
  const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
</script>

{#snippet group(title: string, list: readonly WorkingChange[])}
  {#if list.length}
    <div class="bg-sidebar px-3 py-1 text-[11px] text-muted-foreground">{title} ({list.length})</div>
    {#each list as c (`${c.staged}:${c.path}`)}
      <button
        type="button"
        class="flex w-full items-center gap-1.5 px-3 py-[3px] text-left hover:bg-accent/50"
        data-testid="working-file"
        data-path={c.path}
        data-staged={c.staged}
        onclick={() => onpick(c)}
      >
        <span class="w-3 shrink-0 text-center font-mono text-[11px] font-semibold text-amber-600 dark:text-amber-400">{c.letter}</span>
        <FileTypeIcon name={nameOf(c.path)} class="size-4 shrink-0" />
        <span class="shrink-0">{nameOf(c.path)}</span>
        <span class="min-w-0 flex-1 truncate text-muted-foreground">{dirOf(c.path)}</span>
      </button>
    {/each}
  {/if}
{/snippet}

<div class="flex h-full min-h-0 flex-col bg-background text-[12px]" data-testid="working-details">
  <div class="flex h-7 flex-none items-center gap-1 border-b border-border bg-sidebar px-2">
    <span class="flex-1 truncate text-[11px] text-muted-foreground">Uncommitted Changes</span>
    <button
      type="button"
      class="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      aria-label="Close details"
      data-testid="details-close"
      onclick={onclose}><XIcon class="size-3.5" /></button
    >
  </div>
  <div class="min-h-0 flex-1 overflow-auto">
    {@render group("Staged Changes", staged)}
    {@render group("Changes", unstaged)}
    {#if changes.length === 0}
      <p class="p-3 text-muted-foreground">Working tree clean.</p>
    {/if}
  </div>
</div>
