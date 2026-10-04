<script lang="ts">
  // Stashes pane: list, apply, pop, drop.
  import { gitStore } from "$lib/git/git.svelte";
  import Pane from "./Pane.svelte";
  import IconButton from "./IconButton.svelte";
  import ArchiveIcon from "@lucide/svelte/icons/archive";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import CheckIcon from "@lucide/svelte/icons/check";
  import ArrowUpIcon from "@lucide/svelte/icons/arrow-up";
  import XIcon from "@lucide/svelte/icons/x";

  let open = $state(true);
</script>

<Pane title="Stashes" count={gitStore.stashes.length} bind:open testid="scm-stashes">
  {#snippet actions()}
    <IconButton title="Stash Changes…" testid="scm-stash-new" disabled={gitStore.changeCount === 0} onclick={() => void gitStore.stash()}>
      <PlusIcon />
    </IconButton>
  {/snippet}
  {#if gitStore.stashes.length === 0}
    <p class="px-4 py-1 text-[11px] text-muted-foreground">No stashes.</p>
  {:else}
    <div class="max-h-48 overflow-y-auto pb-1">
      {#each gitStore.stashes as s (s.ref)}
        <div
          class="group flex h-[22px] items-center gap-1 pr-1.5 pl-4 hover:bg-muted/50"
          data-testid="scm-stash-row"
          data-ref={s.ref}
          title="{s.ref}: {s.message}{s.when ? ` (${s.when.trim()})` : ''}"
        >
          <ArchiveIcon class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate">{s.message || s.ref}</span>
          <span class="hidden items-center gap-0.5 group-focus-within:flex group-hover:flex">
            <IconButton title="Apply Stash" testid="scm-stash-apply" onclick={() => void gitStore.stashApply(s.ref)}><CheckIcon /></IconButton>
            <IconButton title="Pop Stash" testid="scm-stash-pop" onclick={() => void gitStore.stashPop(s.ref)}><ArrowUpIcon /></IconButton>
            <IconButton title="Drop Stash" testid="scm-stash-drop" onclick={() => void gitStore.stashDrop(s.ref)}><XIcon /></IconButton>
          </span>
        </div>
      {/each}
    </div>
  {/if}
</Pane>
