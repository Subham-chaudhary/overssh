<script lang="ts">
  // Status indicator (progress ring + count), jobs popover and the one-per-job
  // conflict prompt (docs/GUIDE.md §13.4.S). Mounted once from App.svelte.
  import {
    activeCount,
    cancelJob,
    clearFinished,
    formatBytes,
    formatEta,
    fraction,
    isActive,
    overallFraction,
    removeJob,
    resolveConflict,
    retryJob,
    transfers,
  } from "../../lib/transfers.svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import ArrowUpDownIcon from "@lucide/svelte/icons/arrow-up-down";
  import XIcon from "@lucide/svelte/icons/x";
  import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";

  const active = $derived(activeCount());
  const frac = $derived(overallFraction());
  const R = 9;
  const C = 2 * Math.PI * R;

  const kindLabel = { upload: "Upload", download: "Download", copy: "VM to VM" } as const;

  function stateText(j: (typeof transfers.jobs)[number]): string {
    switch (j.state) {
      case "scanning":
        return "Scanning…";
      case "running":
        return `${formatBytes(j.bytesDone)} / ${formatBytes(j.bytesTotal)} · ${j.filesDone}/${j.filesTotal} files · ${formatBytes(j.rateBps)}/s ${formatEta(j.etaSecs)}`;
      case "done":
        return `Done · ${j.filesDone} files · ${formatBytes(j.bytesDone)}${j.skipped ? ` · ${j.skipped} skipped` : ""}`;
      case "cancelled":
        return "Cancelled";
      case "error":
        return j.error ?? "Failed";
    }
  }
</script>

{#if transfers.jobs.length > 0}
  <div class="fixed right-3 bottom-[28px] z-[250] flex flex-col items-end gap-1.5" data-testid="transfers-host">
    {#if transfers.open}
      <div
        class="w-[380px] max-w-[calc(100vw-1.5rem)] rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg"
        data-testid="transfers-panel"
      >
        <div class="mb-1.5 flex items-center justify-between px-1">
          <span class="text-[12px] font-medium">Transfers</span>
          <button
            type="button"
            class="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            disabled={transfers.jobs.every(isActive)}
            onclick={clearFinished}
            data-testid="transfers-clear">Clear finished</button
          >
        </div>
        <div class="flex max-h-[min(50vh,24rem)] flex-col gap-1.5 overflow-x-hidden overflow-y-auto">
          {#each transfers.jobs as j (j.id)}
            <div class="rounded-sm border border-border p-1.5" data-testid="transfer-job" data-state={j.state}>
              <div class="flex items-center gap-1.5">
                <span class="min-w-0 flex-1 truncate text-[12px]" title={j.label}>
                  <span class="text-muted-foreground">{kindLabel[j.kind]}</span> {j.label}
                </span>
                {#if isActive(j)}
                  <button
                    type="button"
                    class="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label="Cancel transfer"
                    data-testid="transfer-cancel"
                    onclick={() => cancelJob(j.id)}><XIcon class="size-3.5" /></button
                  >
                {:else}
                  {#if j.state !== "done"}
                    <button
                      type="button"
                      class="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label="Retry transfer"
                      data-testid="transfer-retry"
                      onclick={() => void retryJob(j.id)}><RotateCwIcon class="size-3.5" /></button
                    >
                  {/if}
                  <button
                    type="button"
                    class="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label="Dismiss"
                    onclick={() => removeJob(j.id)}><XIcon class="size-3.5" /></button
                  >
                {/if}
              </div>
              <div class="my-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  class={`h-full ${j.state === "error" ? "bg-destructive" : j.state === "cancelled" ? "bg-muted-foreground" : "bg-primary"} ${j.state === "scanning" ? "animate-pulse motion-reduce:animate-none" : ""}`}
                  style={`width:${j.state === "scanning" ? 100 : Math.round(fraction(j) * 100)}%`}
                  data-testid="transfer-bar"
                ></div>
              </div>
              <div class="truncate text-[11px] text-muted-foreground" title={stateText(j)} data-testid="transfer-status">
                {stateText(j)}
              </div>
              {#if j.state === "running" && j.currentPath}
                <div class="truncate text-[10px] text-muted-foreground/70" title={j.currentPath}>{j.currentPath}</div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
    <button
      type="button"
      class="flex h-7 items-center gap-1.5 rounded-full border border-border bg-popover px-2 text-[11px] text-popover-foreground shadow-md hover:bg-accent"
      aria-label="Transfers"
      data-testid="transfers-indicator"
      onclick={() => (transfers.open = !transfers.open)}
    >
      {#if active > 0}
        <svg width="22" height="22" viewBox="0 0 22 22" class="-rotate-90">
          <circle cx="11" cy="11" r={R} fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="2.5" />
          <circle
            cx="11"
            cy="11"
            r={R}
            fill="none"
            stroke="var(--primary)"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-dasharray={C}
            stroke-dashoffset={C * (1 - frac)}
          />
        </svg>
        <span>{active} active</span>
      {:else}
        <ArrowUpDownIcon class="size-3.5" />
        <span>{transfers.jobs.length} transfer{transfers.jobs.length === 1 ? "" : "s"}</span>
      {/if}
    </button>
  </div>
{/if}

{#if transfers.conflict}
  <Dialog.Root open={true} onOpenChange={(o) => !o && void resolveConflict("cancel")}>
    <Dialog.Content class="sm:max-w-md" showCloseButton={false} data-testid="transfer-conflict">
      <Dialog.Header>
        <Dialog.Title>File already exists</Dialog.Title>
        <Dialog.Description class="break-all">
          {transfers.conflict.path} already exists. The choice applies to every clash in this transfer.
        </Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer>
        <Button variant="outline" onclick={() => void resolveConflict("cancel")}>Cancel</Button>
        <Button variant="outline" onclick={() => void resolveConflict("skip")}>Skip</Button>
        <Button variant="outline" onclick={() => void resolveConflict("newer")}>Overwrite if newer</Button>
        <Button onclick={() => void resolveConflict("overwrite")}>Overwrite</Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}
