<script lang="ts">
  // Repo header: branch name (opens the branch picker), ahead/behind, Sync / Publish, Fetch / Pull / Push.
  import { app } from "$lib/stores.svelte";
  import { settings } from "$lib/settings.svelte";
  import { gitStore } from "$lib/git/git.svelte";
  import { basename } from "$lib/paths";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import IconButton from "./IconButton.svelte";
  import GitBranchIcon from "@lucide/svelte/icons/git-branch";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import ArrowUpDownIcon from "@lucide/svelte/icons/arrow-up-down";
  import ArrowUpIcon from "@lucide/svelte/icons/arrow-up";
  import ArrowDownIcon from "@lucide/svelte/icons/arrow-down";
  import CloudDownloadIcon from "@lucide/svelte/icons/cloud-download";
  import CloudUploadIcon from "@lucide/svelte/icons/cloud-upload";
  import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
  import ListIcon from "@lucide/svelte/icons/list";
  import ListTreeIcon from "@lucide/svelte/icons/list-tree";
  import LoaderIcon from "@lucide/svelte/icons/loader-circle";

  const head = $derived(gitStore.head);
  const busy = $derived(gitStore.busy !== null);
  const repoName = $derived(gitStore.repo ? basename(gitStore.repo) : "");
  const manual = $derived(gitStore.sessionId ? gitStore.manualPaths[gitStore.sessionId] !== undefined : false);

  async function openRepository(): Promise<void> {
    const p = await app.ask({
      title: "Open Repository",
      message: "Folder on the VM that is (or is inside) a git repository",
      input: { value: gitStore.repo ?? gitStore.startDir },
      confirmLabel: "Open",
    });
    if (p?.trim()) await gitStore.detect(p.trim());
  }
</script>

<div class="flex flex-col gap-1 px-2 py-1.5" data-testid="scm-syncbar">
  <div class="flex items-center gap-1">
    <button
      type="button"
      class="flex min-w-0 items-center gap-1 rounded-sm px-1 py-0.5 text-[12px] font-medium outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
      title="Switch branch"
      data-testid="scm-branch"
      onclick={() => (gitStore.pickerOpen = true)}
    >
      <GitBranchIcon class="size-3.5 shrink-0" />
      <span class="truncate" data-testid="scm-branch-name">{head.branch ?? (head.sha ? `(${head.sha.slice(0, 7)})` : "(no commits)")}</span>
    </button>
    {#if head.upstream}
      <span class="shrink-0 text-[11px] text-muted-foreground" data-testid="scm-ahead-behind" title="{head.ahead} ahead, {head.behind} behind {head.upstream}">
        {#if head.behind > 0}<ArrowDownIcon class="inline size-3 align-[-2px]" />{head.behind}{/if}
        {#if head.ahead > 0}<ArrowUpIcon class="inline size-3 align-[-2px]" />{head.ahead}{/if}
      </span>
    {/if}
    <span class="min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground" title={gitStore.repo ?? ""}>{repoName}</span>
    {#if busy}
      <span class="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground" data-testid="scm-busy">
        <LoaderIcon class="size-3 animate-spin" />{gitStore.busy}
      </span>
    {/if}
  </div>

  <div class="flex items-center gap-1">
    {#if head.branch && !head.upstream}
      <button
        type="button"
        disabled={busy}
        class="inline-flex h-6 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-2 text-[12px] font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        data-testid="scm-publish"
        onclick={() => void gitStore.push()}
      >
        <CloudUploadIcon class="size-3.5" /><span class="truncate">Publish Branch</span>
      </button>
    {:else if head.upstream}
      <button
        type="button"
        disabled={busy}
        class="inline-flex h-6 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-2 text-[12px] font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        data-testid="scm-sync"
        title="Sync changes: pull, then push"
        onclick={() => void gitStore.sync()}
      >
        <ArrowUpDownIcon class="size-3.5" />
        <span class="truncate">Sync{#if head.behind > 0 || head.ahead > 0} {head.behind}&darr; {head.ahead}&uarr;{/if}</span>
      </button>
    {:else}
      <span class="flex-1"></span>
    {/if}
    <IconButton title="Fetch" testid="scm-fetch" disabled={busy} onclick={() => void gitStore.fetch()}><CloudDownloadIcon /></IconButton>
    <IconButton title="Pull" testid="scm-pull" disabled={busy || !head.upstream} onclick={() => void gitStore.pull()}><ArrowDownIcon /></IconButton>
    <IconButton title="Push" testid="scm-push" disabled={busy || !head.branch} onclick={() => void gitStore.push()}><ArrowUpIcon /></IconButton>
    <IconButton title="Refresh" testid="scm-refresh" onclick={() => void gitStore.refresh(true)}><RefreshCwIcon /></IconButton>
    <IconButton
      title={gitStore.viewMode === "tree" ? "View as List" : "View as Tree"}
      testid="scm-view-toggle"
      onclick={() => gitStore.setViewMode(gitStore.viewMode === "tree" ? "list" : "tree")}
    >
      {#if gitStore.viewMode === "tree"}<ListIcon />{:else}<ListTreeIcon />{/if}
    </IconButton>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        aria-label="More Actions"
        title="More Actions"
        data-testid="scm-more"
      >
        <EllipsisIcon class="size-3.5" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="min-w-52">
        <DropdownMenu.Item onclick={() => void gitStore.pull()} disabled={!head.upstream}>Pull{settings.git.pullRebase ? " (Rebase)" : ""}</DropdownMenu.Item>
        <DropdownMenu.Item onclick={() => void gitStore.push()}>Push</DropdownMenu.Item>
        <DropdownMenu.Item onclick={() => void gitStore.push({ force: true })} disabled={!head.upstream}>Push (Force with Lease)</DropdownMenu.Item>
        <DropdownMenu.Item onclick={() => void gitStore.sync()} disabled={!head.upstream}>Sync</DropdownMenu.Item>
        <DropdownMenu.Item onclick={() => void gitStore.fetch()}>Fetch</DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item data-testid="scm-stash" onclick={() => void gitStore.stash()}>Stash</DropdownMenu.Item>
        <DropdownMenu.Item onclick={() => void gitStore.stash({ includeUntracked: true })}>Stash (Include Untracked)</DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onclick={() => void gitStore.createBranch()}>Create Branch…</DropdownMenu.Item>
        <DropdownMenu.Item onclick={() => void gitStore.createTag()}>Create Tag…</DropdownMenu.Item>
        <DropdownMenu.Item onclick={() => void gitStore.addRemote()}>Add Remote…</DropdownMenu.Item>
        {#if gitStore.merging}
          <DropdownMenu.Separator />
          <DropdownMenu.Item variant="destructive" data-testid="scm-abort-merge" onclick={() => void gitStore.abortMerge()}>Abort Merge</DropdownMenu.Item>
        {/if}
        <DropdownMenu.Separator />
        <DropdownMenu.Item onclick={() => void gitStore.rebaseControl("--continue")}>Continue Rebase</DropdownMenu.Item>
        <DropdownMenu.Item onclick={() => void gitStore.rebaseControl("--abort")}>Abort Rebase</DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item data-testid="scm-open-repository" onclick={() => void openRepository()}>Open Repository…</DropdownMenu.Item>
        {#if manual}
          <DropdownMenu.Item onclick={() => void gitStore.detect("")}>Use Explorer Folder</DropdownMenu.Item>
        {/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
</div>
