<script lang="ts">
  // One section of the Changes pane: Merge Changes, Staged Changes or Changes.
  import { SvelteSet } from "svelte/reactivity";
  import { gitStore } from "$lib/git/git.svelte";
  import { buildChangeTree, treeFiles, type Change, type ChangeTreeNode } from "$lib/git/status";
  import ChangeRow from "./ChangeRow.svelte";
  import IconButton from "./IconButton.svelte";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import MinusIcon from "@lucide/svelte/icons/minus";
  import Undo2Icon from "@lucide/svelte/icons/undo-2";

  let { kind, title, items }: { kind: "merge" | "staged" | "changes"; title: string; items: Change[] } = $props();

  let open = $state(true);
  const collapsed = new SvelteSet<string>();
  const tree = $derived(gitStore.viewMode === "tree" ? buildChangeTree(items) : []);

  function toggle(path: string): void {
    if (collapsed.has(path)) collapsed.delete(path);
    else collapsed.add(path);
  }

  function stageNode(n: ChangeTreeNode): void {
    const files = treeFiles(n);
    if (kind === "staged") void gitStore.unstage(files);
    else void gitStore.stage(files);
  }
</script>

{#if items.length > 0}
  <div data-testid="scm-section-{kind}">
    <div class="group flex h-[22px] items-center gap-0.5 pr-1.5 pl-0.5 hover:bg-muted/40">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-0.5 text-left text-[11px] font-semibold outline-none"
        aria-expanded={open}
        onclick={() => (open = !open)}
      >
        {#if open}<ChevronDownIcon class="size-3.5 shrink-0" />{:else}<ChevronRightIcon class="size-3.5 shrink-0" />{/if}
        <span class="truncate">{title}</span>
      </button>
      <span class="hidden items-center gap-0.5 group-focus-within:flex group-hover:flex">
        {#if kind === "changes"}
          <IconButton title="Discard All Changes" testid="scm-discard-all" onclick={() => void gitStore.discardAll()}><Undo2Icon /></IconButton>
        {/if}
        {#if kind === "staged"}
          <IconButton title="Unstage All Changes" testid="scm-unstage-all" onclick={() => void gitStore.unstageAll()}><MinusIcon /></IconButton>
        {:else if kind === "changes"}
          <IconButton title="Stage All Changes" testid="scm-stage-all" onclick={() => void gitStore.stageAll()}><PlusIcon /></IconButton>
        {:else}
          <IconButton title="Mark All as Resolved" testid="scm-stage-merge" onclick={() => void gitStore.stage(items)}><PlusIcon /></IconButton>
        {/if}
      </span>
      <span class="min-w-4 rounded-full bg-muted px-1 text-center text-[10px] text-muted-foreground" data-testid="scm-count-{kind}">{items.length}</span>
    </div>
    {#if open}
      {#if gitStore.viewMode === "tree"}
        {@render nodes(tree, 0)}
      {:else}
        {#each items as c (c.path)}
          <ChangeRow change={c} {kind} />
        {/each}
      {/if}
    {/if}
  </div>
{/if}

{#snippet nodes(list: ChangeTreeNode[], depth: number)}
  {#each list as n (n.path + (n.change ? "#f" : "#d"))}
    {#if n.change}
      <ChangeRow change={n.change} {kind} {depth} showDir={false} />
    {:else}
      <div
        class="group flex h-[22px] items-center gap-0.5 pr-1.5 hover:bg-muted/50"
        style:padding-left="{4 + depth * 12}px"
        data-testid="scm-folder"
        data-path={n.path}
      >
        <button type="button" class="flex min-w-0 flex-1 items-center gap-0.5 text-left outline-none" onclick={() => toggle(n.path)}>
          {#if collapsed.has(n.path)}<ChevronRightIcon class="size-3.5 shrink-0" />{:else}<ChevronDownIcon class="size-3.5 shrink-0" />{/if}
          <span class="truncate">{n.name}</span>
        </button>
        <span class="hidden items-center gap-0.5 group-focus-within:flex group-hover:flex">
          {#if kind === "changes"}
            <IconButton title="Discard Folder Changes" onclick={() => void gitStore.discard(treeFiles(n))}><Undo2Icon /></IconButton>
          {/if}
          <IconButton title={kind === "staged" ? "Unstage Folder" : "Stage Folder"} onclick={() => stageNode(n)}>
            {#if kind === "staged"}<MinusIcon />{:else}<PlusIcon />{/if}
          </IconButton>
        </span>
      </div>
      {#if !collapsed.has(n.path)}
        {@render nodes(n.children, depth + 1)}
      {/if}
    {/if}
  {/each}
{/snippet}
