<script lang="ts">
  // Timers list (`systemctl list-timers --all`) for the Services tab (§15.3.V).
  import { untrack } from "svelte";
  import { systemd } from "../../../lib/systemd/systemd.svelte";
  import { fmtRelUsec, fmtUsec } from "../../../lib/systemd/model";
  import Loader from "../../Loader.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import RefreshIcon from "@lucide/svelte/icons/refresh-cw";
  import PlayIcon from "@lucide/svelte/icons/play";

  let { sessionId, query, onOpen }: { sessionId: string; query: string; onOpen: (unit: string) => void } = $props();

  const user = $derived(systemd.prefs.user);
  const st = $derived(systemd.timers[`${sessionId}|${user ? "u" : "s"}`]);
  const rows = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const all = st?.rows ?? [];
    return q ? all.filter((t) => `${t.unit} ${t.activates}`.toLowerCase().includes(q)) : all;
  });
  const now = Date.now();

  $effect(() => {
    void user;
    untrack(() => void systemd.loadTimers(sessionId));
  });
</script>

<section class="flex min-h-0 min-w-0 flex-1 flex-col px-4 pb-2 pt-2" data-testid="svc-timers-view">
  <div class="mb-1 flex flex-none items-center gap-2 text-[11px] text-muted-foreground">
    <span data-testid="svc-timers-count">{rows.length} timers</span>
    <Button variant="ghost" size="icon" class="size-6" title="Reload" onclick={() => void systemd.loadTimers(sessionId)}>
      <RefreshIcon class={`size-3.5 ${st?.loading ? "animate-spin" : ""}`} />
    </Button>
  </div>
  {#if st?.error}
    <p class="text-sm text-destructive" data-testid="svc-timers-error">{st.error}</p>
  {:else if !st || (st.loading && st.rows.length === 0)}
    <div class="flex flex-1 items-center justify-center"><Loader label="Loading timers…" size="lg" /></div>
  {:else}
    <div class="min-h-0 flex-1 overflow-auto rounded-md border border-border">
      <table class="w-full border-collapse font-mono text-[11px]">
        <thead class="sticky top-0 z-10 bg-muted">
          <tr class="h-6 text-left text-muted-foreground">
            <th class="px-2 font-semibold">Timer</th>
            <th class="hidden px-2 font-semibold @lg/mon:table-cell">Activates</th>
            <th class="px-2 font-semibold">Next</th>
            <th class="hidden px-2 font-semibold @2xl/mon:table-cell">Last</th>
            <th class="w-8"></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as t (t.unit)}
            <tr class="h-6 cursor-default hover:bg-accent/60" data-testid="svc-timer-row" data-unit={t.unit} ondblclick={() => onOpen(t.activates)}>
              <td class="max-w-0 truncate px-2" title={t.unit}>{t.unit}</td>
              <td class="hidden max-w-0 truncate px-2 @lg/mon:table-cell" title={t.activates}>{t.activates}</td>
              <td class="px-2 tabular-nums">{#if t.next || t.last}{t.next ? `${fmtUsec(t.next)} · ${fmtRelUsec(t.next, now)}` : "n/a"}{:else}{t.text}{/if}</td>
              <td class="hidden px-2 tabular-nums @2xl/mon:table-cell">{t.last ? fmtUsec(t.last) : t.next || !t.text ? "n/a" : ""}</td>
              <td class="px-1">
                <Button variant="ghost" size="icon" class="size-5" title={`Run ${t.activates} now`} onclick={() => void systemd.act(sessionId, "start", t.activates)} data-testid="svc-timer-run">
                  <PlayIcon class="size-3" />
                </Button>
              </td>
            </tr>
          {:else}
            <tr><td colspan="5" class="px-2 py-6 text-center text-muted-foreground" data-testid="svc-timers-none">No timers.</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
