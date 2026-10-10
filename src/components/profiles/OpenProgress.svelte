<script lang="ts">
  // Progress / report card for "open profile" (docs/GUIDE.md §15.3.P). A floating card, not a
  // modal: the password / host-key prompt of a host that is being connected must stay usable.
  import { app } from "../../lib/stores.svelte";
  import { cancelOpen, dismissRun, restoreState, type EntryProgress } from "../../lib/profiles/restore.svelte";
  import Loader from "../Loader.svelte";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import CircleXIcon from "@lucide/svelte/icons/circle-x";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import XIcon from "@lucide/svelte/icons/x";
  import MinusIcon from "@lucide/svelte/icons/minus";
  import ClockIcon from "@lucide/svelte/icons/clock";

  const run = $derived(restoreState.run);
  const running = $derived(run?.status === "running");
  const problems = $derived(run ? run.entries.reduce((n, e) => n + e.issues.length, 0) : 0);

  function status(e: EntryProgress): string {
    if (e.state === "connecting") {
      return app.pendingConnect ? "Waiting for your answer…" : e.detail || "Connecting…";
    }
    if (e.state === "restoring") return e.detail || "Restoring…";
    if (e.state === "pending") return "Waiting";
    if (e.state === "skipped") return "Skipped";
    if (e.state === "failed") return "Failed";
    const bits: string[] = [];
    if (e.reused) bits.push("already connected");
    if (e.files.total) bits.push(`${e.files.done}/${e.files.total} files`);
    if (e.terminals.total) bits.push(`${e.terminals.done}/${e.terminals.total} terminals`);
    if (e.forwards.total) bits.push(`${e.forwards.done}/${e.forwards.total} tunnels`);
    return bits.join(", ") || "Done";
  }

  // A clean run closes itself after a moment; a run with problems stays until dismissed.
  $effect(() => {
    if (!run || run.status !== "done" || problems > 0 || run.notes.length > 0) return;
    const t = setTimeout(dismissRun, 3500);
    return () => clearTimeout(t);
  });
</script>

{#if run}
  <div
    class="motion-slide fixed right-3 bottom-9 z-40 w-[360px] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
    data-testid="profile-progress"
    data-status={run.status}
    role="status"
    aria-live="polite"
  >
    <div class="flex items-center gap-2 border-b border-border px-3 py-2">
      {#if running}<Loader delay={0} />{:else if problems > 0}<TriangleAlertIcon class="size-4 text-amber-500" />{:else}<CircleCheckIcon class="size-4 text-emerald-500" />{/if}
      <span class="min-w-0 flex-1 truncate text-[13px] font-semibold" data-testid="profile-progress-title">
        {running ? "Opening" : run.status === "cancelled" ? "Cancelled" : "Opened"} “{run.profileName}”
      </span>
      {#if running}
        <button type="button" class="rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground" data-testid="profile-progress-cancel" onclick={cancelOpen}>Cancel</button>
      {:else}
        <button type="button" class="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close" data-testid="profile-progress-close" onclick={dismissRun}><XIcon class="size-3.5" /></button>
      {/if}
    </div>
    <ul class="max-h-[50vh] overflow-y-auto py-1">
      {#each run.entries as e (e.entryId)}
        <li class="px-3 py-1.5" data-testid="profile-progress-entry" data-state={e.state} data-label={e.label}>
          <div class="flex items-center gap-2 text-[13px]">
            {#if e.state === "done"}<CircleCheckIcon class="size-3.5 flex-none text-emerald-500" />
            {:else if e.state === "partial"}<TriangleAlertIcon class="size-3.5 flex-none text-amber-500" />
            {:else if e.state === "failed"}<CircleXIcon class="size-3.5 flex-none text-destructive" />
            {:else if e.state === "skipped"}<MinusIcon class="size-3.5 flex-none text-muted-foreground" />
            {:else if e.state === "pending"}<ClockIcon class="size-3.5 flex-none text-muted-foreground" />
            {:else}<Loader delay={0} />{/if}
            <span class="min-w-0 flex-1 truncate font-medium">{e.label}</span>
            <span class="flex-none text-[11px] text-muted-foreground" data-testid="profile-progress-status">{status(e)}</span>
          </div>
          {#if e.issues.length > 0}
            <ul class="mt-1 ml-5.5 flex flex-col gap-0.5" data-testid="profile-progress-issues">
              {#each e.issues as msg, i (i)}
                <li class="text-[11px] break-words text-destructive/90" data-testid="profile-progress-issue">{msg}</li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
    {#if run.notes.length > 0}
      <div class="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        {#each run.notes as n, i (i)}<div>{n}</div>{/each}
      </div>
    {/if}
  </div>
{/if}
