<script lang="ts">
  // Branches pane: local branches, remote branches, tags.
  import { settings } from "$lib/settings.svelte";
  import { gitStore } from "$lib/git/git.svelte";
  import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
  import Pane from "./Pane.svelte";
  import IconButton from "./IconButton.svelte";
  import GitBranchIcon from "@lucide/svelte/icons/git-branch";
  import CloudIcon from "@lucide/svelte/icons/cloud";
  import TagIcon from "@lucide/svelte/icons/tag";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import CheckIcon from "@lucide/svelte/icons/check";
  import ArrowUpIcon from "@lucide/svelte/icons/arrow-up";
  import ArrowDownIcon from "@lucide/svelte/icons/arrow-down";

  let open = $state(true);
  let showLocal = $state(true);
  let showRemote = $state(true);
  let showTags = $state(false);

  const refs = $derived(gitStore.refs);
  const current = $derived(gitStore.head.branch);
  const total = $derived(refs.local.length);
</script>

{#snippet sub(title: string, count: number, isOpen: boolean, toggle: () => void, testid: string)}
  <button
    type="button"
    class="flex h-5 w-full items-center gap-1 px-2 text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase outline-none hover:bg-muted/40"
    aria-expanded={isOpen}
    data-testid={testid}
    onclick={toggle}
  >
    <span>{isOpen ? "▾" : "▸"}</span>{title}<span class="font-normal normal-case">({count})</span>
  </button>
{/snippet}

<Pane title="Branches" count={total} bind:open testid="scm-branches">
  {#snippet actions()}
    <IconButton title="Create Branch…" testid="scm-create-branch" onclick={() => void gitStore.createBranch()}><PlusIcon /></IconButton>
    <IconButton title="Create Tag…" testid="scm-create-tag" onclick={() => void gitStore.createTag()}><TagIcon /></IconButton>
  {/snippet}

  <div class="max-h-72 overflow-y-auto pb-1" data-testid="scm-branch-list">
    {@render sub("Local", refs.local.length, showLocal, () => (showLocal = !showLocal), "scm-local-toggle")}
    {#if showLocal}
      {#each refs.local as b (b.name)}
        <ContextMenu.Root>
          <ContextMenu.Trigger class="block">
            <div
              role="button"
              tabindex="0"
              data-testid="scm-local-branch"
              data-name={b.name}
              data-current={b.current}
              title={b.upstream ? `${b.name} tracks ${b.upstream}${b.gone ? " (gone)" : ""}` : b.name}
              class="group flex h-[22px] cursor-default items-center gap-1 pr-2 pl-4 outline-none hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring"
              ondblclick={() => !b.current && void gitStore.checkout(b.name)}
              onkeydown={(e) => e.key === "Enter" && !b.current && void gitStore.checkout(b.name)}
            >
              {#if b.current}<CheckIcon class="size-3.5 shrink-0 text-success" />{:else}<GitBranchIcon class="size-3.5 shrink-0 text-muted-foreground" />{/if}
              <span class="min-w-0 truncate {b.current ? 'font-semibold' : ''}">{b.name}</span>
              {#if b.upstream}
                <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{b.upstream}{b.gone ? " (gone)" : ""}</span>
              {:else}
                <span class="flex-1"></span>
              {/if}
              {#if b.behind > 0}<span class="text-[11px] text-muted-foreground"><ArrowDownIcon class="inline size-3 align-[-2px]" />{b.behind}</span>{/if}
              {#if b.ahead > 0}<span class="text-[11px] text-muted-foreground"><ArrowUpIcon class="inline size-3 align-[-2px]" />{b.ahead}</span>{/if}
            </div>
          </ContextMenu.Trigger>
          <ContextMenu.Content>
            {#if !b.current}<ContextMenu.Item onclick={() => void gitStore.checkout(b.name)}>Checkout</ContextMenu.Item>{/if}
            <ContextMenu.Item onclick={() => void gitStore.createBranch({ from: b.name })}>Create Branch From…</ContextMenu.Item>
            <ContextMenu.Item onclick={() => void gitStore.renameBranch(b.name)}>Rename…</ContextMenu.Item>
            <ContextMenu.Separator />
            {#if !b.current}
              <ContextMenu.Item onclick={() => void gitStore.mergeInto(b.name)}>Merge into Current Branch</ContextMenu.Item>
              <ContextMenu.Item onclick={() => void gitStore.rebaseOnto(b.name)}>Rebase Current Branch onto This</ContextMenu.Item>
              <ContextMenu.Separator />
            {/if}
            {#if !b.upstream}
              <ContextMenu.Item onclick={() => void gitStore.publishBranch(b.name)}>Publish Branch</ContextMenu.Item>
            {/if}
            <ContextMenu.Item onclick={() => void gitStore.setUpstream(b.name)}>Set Upstream…</ContextMenu.Item>
            <ContextMenu.Item onclick={() => void gitStore.createTag(b.name)}>Create Tag Here…</ContextMenu.Item>
            {#if !b.current}
              <ContextMenu.Separator />
              <ContextMenu.Item variant="destructive" onclick={() => void gitStore.deleteBranch(b.name)}>Delete</ContextMenu.Item>
              <ContextMenu.Item variant="destructive" onclick={() => void gitStore.deleteBranch(b.name, true)}>Delete (Force)</ContextMenu.Item>
            {/if}
          </ContextMenu.Content>
        </ContextMenu.Root>
      {/each}
    {/if}

    {#if settings.git.showRemoteBranches}
      {@render sub("Remote", refs.remote.length, showRemote, () => (showRemote = !showRemote), "scm-remote-toggle")}
      {#if showRemote}
        {#each refs.remote as r (r.name)}
          <ContextMenu.Root>
            <ContextMenu.Trigger class="block">
              <div
                role="button"
                tabindex="0"
                data-testid="scm-remote-branch"
                data-name={r.name}
                title={r.name}
                class="flex h-[22px] cursor-default items-center gap-1 pr-2 pl-4 outline-none hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring"
                ondblclick={() => void gitStore.checkout(r.name, { remote: true })}
                onkeydown={(e) => e.key === "Enter" && void gitStore.checkout(r.name, { remote: true })}
              >
                <CloudIcon class="size-3.5 shrink-0 text-muted-foreground" />
                <span class="min-w-0 truncate">{r.name}</span>
              </div>
            </ContextMenu.Trigger>
            <ContextMenu.Content>
              <ContextMenu.Item onclick={() => void gitStore.checkout(r.name, { remote: true })}>Checkout (Track)</ContextMenu.Item>
              <ContextMenu.Item onclick={() => void gitStore.createBranch({ from: r.name })}>Create Branch From…</ContextMenu.Item>
              {#if current}
                <ContextMenu.Item onclick={() => void gitStore.setUpstream(current, r.name)}>Track from Current Branch</ContextMenu.Item>
              {/if}
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => void gitStore.mergeInto(r.name)}>Merge into Current Branch</ContextMenu.Item>
              <ContextMenu.Item onclick={() => void gitStore.rebaseOnto(r.name)}>Rebase Current Branch onto This</ContextMenu.Item>
              <ContextMenu.Separator />
              <ContextMenu.Item onclick={() => void gitStore.fetch({ remote: r.remote })}>Fetch {r.remote}</ContextMenu.Item>
              <ContextMenu.Item variant="destructive" onclick={() => void gitStore.deleteRemoteBranch(r.remote, r.short)}>
                Delete Remote Branch
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Root>
        {/each}
      {/if}
    {/if}

    {@render sub("Tags", refs.tags.length, showTags, () => (showTags = !showTags), "scm-tags-toggle")}
    {#if showTags}
      {#each refs.tags as t (t.name)}
        <ContextMenu.Root>
          <ContextMenu.Trigger class="block">
            <div
              role="button"
              tabindex="0"
              data-testid="scm-tag"
              data-name={t.name}
              title={t.subject ? `${t.name}: ${t.subject}` : t.name}
              class="flex h-[22px] cursor-default items-center gap-1 pr-2 pl-4 outline-none hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring"
              ondblclick={() => void gitStore.checkout(t.name, { detach: true })}
            >
              <TagIcon class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 truncate">{t.name}</span>
              <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{t.subject}</span>
            </div>
          </ContextMenu.Trigger>
          <ContextMenu.Content>
            <ContextMenu.Item onclick={() => void gitStore.checkout(t.name, { detach: true })}>Checkout (Detached)</ContextMenu.Item>
            <ContextMenu.Item onclick={() => void gitStore.createBranch({ from: t.name })}>Create Branch From…</ContextMenu.Item>
            <ContextMenu.Item onclick={() => void gitStore.pushTag(t.name)}>Push Tag</ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item variant="destructive" onclick={() => void gitStore.deleteTag(t.name)}>Delete Tag</ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Root>
      {/each}
    {/if}
  </div>
</Pane>
