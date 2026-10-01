<script lang="ts">
  // Recordings browser + player (§13.4.T2). Opened from the palette
  // ("Terminal: Show Recordings") or the Recording settings group.
  import * as api from "../../lib/api";
  import { app } from "../../lib/stores.svelte";
  import { settings } from "../../lib/settings.svelte";
  import { terminalStore } from "../../lib/terminal.svelte";
  import type { RecInfo } from "../../lib/types";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import PlayIcon from "@lucide/svelte/icons/play";
  import FolderOpenIcon from "@lucide/svelte/icons/folder-open";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import RecordingPlayer from "./RecordingPlayer.svelte";
  import { formatClock } from "./cast";

  let items = $state<RecInfo[]>([]);
  let loading = $state(false);
  let current = $state<{ info: RecInfo; text: string } | null>(null);

  function fmtSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  function fail(err: unknown): void {
    app.addToast("error", api.isAppError(err) ? err.message : String(err));
  }

  async function refresh(): Promise<void> {
    loading = true;
    try {
      items = await api.recList(settings.terminal.recording.directory);
    } catch (err) {
      fail(err);
    } finally {
      loading = false;
    }
  }

  async function play(info: RecInfo): Promise<void> {
    try {
      current = { info, text: await api.recRead(info.path) };
    } catch (err) {
      fail(err);
    }
  }

  async function remove(info: RecInfo): Promise<void> {
    const ok = await app.ask({
      title: "Delete recording",
      message: `Delete ${info.name}? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.recDelete(info.path);
      await refresh();
    } catch (err) {
      fail(err);
    }
  }

  $effect(() => {
    if (terminalStore.showRecordings) {
      current = null;
      void refresh();
    }
  });
</script>

<Dialog.Root bind:open={terminalStore.showRecordings}>
  <Dialog.Content class="flex h-[560px] max-h-[85vh] w-full !max-w-4xl flex-col overflow-hidden" data-testid="recordings-dialog">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        {#if current}
          <Button variant="ghost" size="icon" class="size-6" aria-label="Back to recordings" data-testid="rec-back" onclick={() => (current = null)}>
            <ArrowLeftIcon class="size-4" />
          </Button>
          <span class="truncate">{current.info.name}</span>
        {:else}
          Terminal recordings
        {/if}
      </Dialog.Title>
    </Dialog.Header>

    {#if current}
      {#key current.info.path}
        <RecordingPlayer text={current.text} />
      {/key}
    {:else}
      <div class="min-h-0 flex-1 overflow-y-auto">
        {#if items.length === 0}
          <div class="p-6 text-center text-sm text-muted-foreground" data-testid="rec-empty">
            {loading ? "Loading..." : "No recordings yet."}
          </div>
        {:else}
          <table class="w-full text-[13px]">
            <thead class="text-left text-[11px] text-muted-foreground uppercase">
              <tr><th class="py-1">Host</th><th>Date</th><th>Duration</th><th>Size</th><th></th></tr>
            </thead>
            <tbody>
              {#each items as info (info.path)}
                <tr class="border-t border-border/60" data-testid="rec-row" data-name={info.name}>
                  <td class="py-1.5 pr-2">{info.host}</td>
                  <td class="pr-2">{new Date(info.startedAt * 1000).toLocaleString()}</td>
                  <td class="pr-2 tabular-nums">{formatClock(info.duration)}</td>
                  <td class="pr-2 tabular-nums">{fmtSize(info.size)}</td>
                  <td class="text-right whitespace-nowrap">
                    <Button variant="ghost" size="icon" class="size-7" aria-label="Play" data-testid="rec-play" onclick={() => play(info)}><PlayIcon class="size-3.5" /></Button>
                    <Button variant="ghost" size="icon" class="size-7" aria-label="Show in folder" data-testid="rec-reveal" onclick={() => api.recReveal(info.path).catch(fail)}><FolderOpenIcon class="size-3.5" /></Button>
                    <Button variant="ghost" size="icon" class="size-7" aria-label="Delete" data-testid="rec-delete" onclick={() => remove(info)}><Trash2Icon class="size-3.5" /></Button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
