<script lang="ts">
  // Dashboard sidebar (§13.4.M): connected sessions with live mini CPU/MEM bars.
  // Click = choose which VM the main Dashboard view shows. Streams at a slow rate
  // while mounted (see monitor.svelte.ts sync()).
  import { app } from "../../lib/stores.svelte";
  import { monitor } from "../../lib/monitor.svelte";
  import ActivityIcon from "@lucide/svelte/icons/activity";

  $effect(() => monitor.attachSidebar());
  $effect(() => {
    // re-sync when the session list changes
    void app.sessions.length;
    monitor.sync();
  });
</script>

<div class="flex h-full flex-col text-sm">
  <div class="flex-none px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
    Dashboard
  </div>
  {#if app.sessions.length === 0}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground" data-testid="monitor-empty">
      <ActivityIcon class="size-6 opacity-60" />
      <p class="text-[12px]">No connected VMs. Connect a host to inspect its processes, CPU and memory.</p>
    </div>
  {:else}
    <ul class="min-h-0 flex-1 space-y-1 overflow-auto p-2">
      {#each app.sessions as s (s.id)}
        {@const snap = monitor.snapshots[s.id]}
        {@const memPct = snap && snap.mem.total ? (snap.mem.used * 100) / snap.mem.total : 0}
        <li>
          <button
            type="button"
            data-testid="monitor-session"
            data-session-id={s.id}
            class={`w-full rounded-md border px-2.5 py-2 text-left transition-colors hover:bg-accent ${monitor.selectedId === s.id ? "border-primary bg-accent" : "border-transparent"}`}
            onclick={() => {
              monitor.select(s.id);
              app.sidebarView = "monitor";
            }}
          >
            <div class="truncate text-[13px] font-medium text-foreground">{s.label}</div>
            <div class="truncate text-[11px] text-muted-foreground">{s.user}@{s.hostname}</div>
            {#if snap}
              <div class="mt-1.5 space-y-1 font-mono text-[10px] text-muted-foreground">
                <div class="flex items-center gap-1.5">
                  <span class="w-7">CPU</span>
                  <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div class={`h-full ${snap.cpu.total > 85 ? "bg-destructive" : snap.cpu.total > 60 ? "bg-warning" : "bg-success"}`} style={`width:${snap.cpu.total}%`}></div>
                  </div>
                  <span class="w-9 text-right tabular-nums">{snap.cpu.total.toFixed(0)}%</span>
                </div>
                <div class="flex items-center gap-1.5">
                  <span class="w-7">MEM</span>
                  <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div class={`h-full ${memPct > 90 ? "bg-destructive" : memPct > 75 ? "bg-warning" : "bg-chart-1"}`} style={`width:${memPct}%`}></div>
                  </div>
                  <span class="w-9 text-right tabular-nums">{memPct.toFixed(0)}%</span>
                </div>
              </div>
            {:else if monitor.errors[s.id]}
              <div class="mt-1 truncate text-[11px] text-destructive">{monitor.errors[s.id]}</div>
            {:else}
              <div class="mt-1 text-[11px] text-muted-foreground">Collecting…</div>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
