<script lang="ts">
  // Source Control sidebar (docs/GUIDE.md §14). Owner: agent G1.
  import { onMount } from "svelte";
  import { gitStore } from "$lib/git/git.svelte";
  import { app } from "$lib/stores.svelte";
  import RepoSetup from "./scm/RepoSetup.svelte";
  import SyncBar from "./scm/SyncBar.svelte";
  import CommitBox from "./scm/CommitBox.svelte";
  import ChangeSection from "./scm/ChangeSection.svelte";
  import Pane from "./scm/Pane.svelte";
  import BranchesPane from "./scm/BranchesPane.svelte";
  import StashPane from "./scm/StashPane.svelte";
  import BranchPicker from "./scm/BranchPicker.svelte";
  import XIcon from "@lucide/svelte/icons/x";

  let changesOpen = $state(true);

  onMount(() => {
    gitStore.activated = true;
    // Status also refreshes on window focus and after every action; this catches edits made in the terminal.
    const timer = setInterval(() => {
      if (gitStore.state === "ready" && gitStore.busy === null && document.visibilityState === "visible") {
        void gitStore.refresh();
      }
    }, 20_000);
    return () => clearInterval(timer);
  });

  const OP_TEXT: Record<string, string> = {
    rebase: "A rebase is in progress. Resolve conflicts, stage the files, then Continue.",
    am: "Applying patches (git am) is in progress. Resolve conflicts, stage the files, then Continue.",
    "cherry-pick": "A cherry-pick is in progress. Resolve conflicts, stage the files, then Continue.",
    revert: "A revert is in progress. Resolve conflicts, stage the files, then Continue.",
  };
  const opBtn =
    "rounded-sm border border-warning/40 px-1.5 py-px text-[11px] text-foreground hover:bg-warning/20 disabled:pointer-events-none disabled:opacity-50";
  const op = $derived(gitStore.operation);
  const busy = $derived(gitStore.busy !== null);

  async function opAction(action: "--continue" | "--skip" | "--abort"): Promise<void> {
    const o = gitStore.operation;
    if (!o || o === "merge" || gitStore.busy !== null) return;
    if (action === "--abort") {
      const ok = await app.ask({
        title: "Abort",
        message: `Abort the ${o === "am" ? "patch application" : o} and go back to the state before it started?`,
        confirmLabel: "Abort",
        danger: true,
      });
      if (!ok) return;
    }
    if (o === "rebase") await gitStore.rebaseControl(action);
    else await gitStore.sequenceControl(o, action);
  }

  const scmState = $derived(gitStore.state);
  const groups = $derived(gitStore.groups);
  const ready = $derived(scmState === "ready");
</script>

<div class="flex h-full min-h-0 flex-col text-[12px]" data-testid="scm-view" data-state={scmState}>
  <div class="flex h-8 flex-none items-center px-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
    Source Control
  </div>

  {#if !ready}
    <RepoSetup />
  {:else}
    <SyncBar />
    {#if gitStore.lastError}
      <div class="mx-2 mb-1.5 flex items-start gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px]" data-testid="scm-error" role="alert">
        <div class="min-w-0 flex-1">
          <div class="font-medium text-destructive">{gitStore.lastError.label} failed</div>
          <div class="max-h-32 overflow-y-auto break-words whitespace-pre-wrap text-foreground/90">{gitStore.lastError.message}</div>
        </div>
        <button type="button" class="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Dismiss error" onclick={() => gitStore.dismissError()}>
          <XIcon class="size-3.5" />
        </button>
      </div>
    {/if}
    <div class="min-h-0 flex-1 overflow-y-auto" data-testid="scm-scroll">
      {#if op && op !== "merge"}
        <div class="mx-2 mb-1.5 rounded-md bg-warning/15 px-2 py-1 text-[11px] text-warning" data-testid="scm-operation" data-op={op}>
          <div>{OP_TEXT[op]}</div>
          <div class="mt-1 flex flex-wrap gap-1">
            <button type="button" class={opBtn} disabled={busy || gitStore.groups.merge.length > 0} title={gitStore.groups.merge.length > 0 ? "Resolve and stage the conflicted files first" : ""} data-testid="scm-op-continue" onclick={() => void opAction("--continue")}>Continue</button>
            <button type="button" class={opBtn} disabled={busy} data-testid="scm-op-skip" onclick={() => void opAction("--skip")}>Skip</button>
            <button type="button" class={opBtn} disabled={busy} data-testid="scm-op-abort" onclick={() => void opAction("--abort")}>Abort</button>
          </div>
        </div>
      {:else if gitStore.merging}
        <div class="mx-2 mb-1.5 rounded-md bg-warning/15 px-2 py-1 text-[11px] text-warning" data-testid="scm-merging">
          A merge is in progress. Resolve conflicts, stage the files, then commit.
          <button type="button" class="{opBtn} ml-1" disabled={busy} data-testid="scm-op-abort" onclick={() => void gitStore.abortMerge()}>Abort Merge</button>
        </div>
      {/if}
      <Pane title="Changes" count={gitStore.changeCount} bind:open={changesOpen} testid="scm-changes">
        {#if !gitStore.loaded}
          <p class="px-3 py-1 text-[11px] text-muted-foreground">Loading…</p>
        {:else}
          <CommitBox />
          <ChangeSection kind="merge" title="Merge Changes" items={groups.merge} />
          <ChangeSection kind="staged" title="Staged Changes" items={groups.staged} />
          <ChangeSection kind="changes" title="Changes" items={groups.changes} />
          {#if gitStore.changeCount === 0}
            <p class="px-3 py-1 text-[11px] text-muted-foreground" data-testid="scm-clean">No changes. The working tree is clean.</p>
          {/if}
        {/if}
      </Pane>
      <BranchesPane />
      <StashPane />
    </div>
  {/if}
</div>

<BranchPicker />
