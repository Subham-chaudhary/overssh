<script lang="ts">
  // Quick branch picker ("Git: Checkout to…", click on the branch name).
  import { settings } from "$lib/settings.svelte";
  import { gitStore } from "$lib/git/git.svelte";
  import * as Command from "$lib/components/ui/command/index.js";
  import GitBranchIcon from "@lucide/svelte/icons/git-branch";
  import CloudIcon from "@lucide/svelte/icons/cloud";
  import TagIcon from "@lucide/svelte/icons/tag";
  import PlusIcon from "@lucide/svelte/icons/plus";

  let query = $state("");

  $effect(() => {
    if (gitStore.pickerOpen) query = "";
  });

  function done(fn: () => void): void {
    gitStore.pickerOpen = false;
    fn();
  }
</script>

<Command.Dialog bind:open={gitStore.pickerOpen} title="Checkout to…" description="Pick a branch or tag to check out">
  <Command.Input placeholder="Select a branch or tag to checkout" bind:value={query} data-testid="scm-picker-input" />
  <Command.List>
    <Command.Empty>No matching branch or tag.</Command.Empty>
    <Command.Group heading="Actions">
      <Command.Item value="__create" onSelect={() => done(() => void gitStore.createBranch())}>
        <PlusIcon class="size-4" /> Create new branch…
      </Command.Item>
      <Command.Item value="__create_from" onSelect={() => done(() => void gitStore.createBranch({ from: gitStore.head.branch ?? undefined }))}>
        <PlusIcon class="size-4" /> Create new branch from current…
      </Command.Item>
    </Command.Group>
    <Command.Group heading="Branches">
      {#each gitStore.refs.local as b (b.name)}
        <Command.Item value={`local:${b.name}`} onSelect={() => done(() => !b.current && void gitStore.checkout(b.name))}>
          <GitBranchIcon class="size-4" />
          <span>{b.name}</span>
          {#if b.current}<span class="ml-auto text-[11px] text-muted-foreground">current</span>{/if}
        </Command.Item>
      {/each}
    </Command.Group>
    {#if settings.git.showRemoteBranches && gitStore.refs.remote.length > 0}
      <Command.Group heading="Remote branches">
        {#each gitStore.refs.remote as r (r.name)}
          <Command.Item value={`remote:${r.name}`} onSelect={() => done(() => void gitStore.checkout(r.name, { remote: true }))}>
            <CloudIcon class="size-4" /> {r.name}
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}
    {#if gitStore.refs.tags.length > 0}
      <Command.Group heading="Tags">
        {#each gitStore.refs.tags as t (t.name)}
          <Command.Item value={`tag:${t.name}`} onSelect={() => done(() => void gitStore.checkout(t.name, { detach: true }))}>
            <TagIcon class="size-4" /> {t.name}
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}
  </Command.List>
</Command.Dialog>
