<script lang="ts">
  // CPU / memory / network / block IO of one container. Samples come from the shared
  // `docker stats` stream (dockerStore.stats), kept as a short history.
  import { dockerStore } from "$lib/docker/docker.svelte";
  import { formatBytes, isRunning, type Container, type StatSample } from "$lib/docker/parse";
  import Sparkline from "../monitor/Sparkline.svelte";
  import Meter from "../monitor/Meter.svelte";

  let { c }: { c: Container } = $props();

  const series = $derived(dockerStore.statsFor(c));
  const hist = $derived(series?.hist ?? []);
  const cur = $derived(series?.latest);

  /** Bytes per second between consecutive cumulative samples. */
  function rates(pick: (s: StatSample) => number): number[] {
    const out: number[] = [];
    for (let i = 1; i < hist.length; i++) {
      const dt = (hist[i].t - hist[i - 1].t) / 1000;
      out.push(dt > 0 ? Math.max(0, (pick(hist[i]) - pick(hist[i - 1])) / dt) : 0);
    }
    return out;
  }

  const cpuHist = $derived(hist.map((s) => s.cpu));
  const memHist = $derived(hist.map((s) => s.memUsed));
  const rx = $derived(rates((s) => s.netRx));
  const tx = $derived(rates((s) => s.netTx));
  const rd = $derived(rates((s) => s.blockRead));
  const wr = $derived(rates((s) => s.blockWrite));
  const last = (a: number[]) => (a.length ? a[a.length - 1] : 0);
  const memPct = $derived(cur && cur.memLimit > 0 ? (cur.memUsed * 100) / cur.memLimit : (cur?.memPerc ?? 0));
</script>

<div class="h-full overflow-auto p-3" data-testid="docker-stats">
  {#if !isRunning(c)}
    <p class="text-muted-foreground">Stats are available while the container is running.</p>
  {:else if !cur}
    <p class="text-muted-foreground" data-testid="docker-stats-wait">Waiting for the first sample…</p>
  {:else}
    <div class="grid gap-3 @2xl/main:grid-cols-2">
      <section class="rounded-md border border-border p-2" data-testid="docker-stat-cpu">
        <div class="mb-1 flex items-baseline justify-between"><span class="text-[11px] font-semibold text-muted-foreground uppercase">CPU</span><span class="font-mono text-sm tabular-nums" data-testid="docker-stat-cpu-value">{cur.cpu.toFixed(1)}%</span></div>
        <div class="h-14 text-chart-1"><Sparkline data={cpuHist} max={100} /></div>
      </section>
      <section class="rounded-md border border-border p-2" data-testid="docker-stat-mem">
        <div class="mb-1 flex items-baseline justify-between"><span class="text-[11px] font-semibold text-muted-foreground uppercase">Memory</span><span class="font-mono text-sm tabular-nums">{formatBytes(cur.memUsed)}{cur.memLimit ? ` / ${formatBytes(cur.memLimit)}` : ""}</span></div>
        <div class="h-14 text-chart-2"><Sparkline data={memHist} max={cur.memLimit || undefined} /></div>
        <div class="mt-1"><Meter label="MEM" segments={[{ value: memPct, class: memPct > 90 ? "bg-destructive" : memPct > 75 ? "bg-warning" : "bg-chart-2" }]} text={`${memPct.toFixed(1)}%`} /></div>
      </section>
      <section class="rounded-md border border-border p-2" data-testid="docker-stat-net">
        <div class="mb-1 flex items-baseline justify-between"><span class="text-[11px] font-semibold text-muted-foreground uppercase">Network</span><span class="font-mono text-[11px] tabular-nums">down {formatBytes(last(rx))}/s · up {formatBytes(last(tx))}/s</span></div>
        <div class="h-12 text-chart-3"><Sparkline data={rx} /></div>
        <div class="h-12 text-chart-4"><Sparkline data={tx} /></div>
        <div class="mt-1 font-mono text-[11px] text-muted-foreground">total in {formatBytes(cur.netRx)} · out {formatBytes(cur.netTx)}</div>
      </section>
      <section class="rounded-md border border-border p-2" data-testid="docker-stat-io">
        <div class="mb-1 flex items-baseline justify-between"><span class="text-[11px] font-semibold text-muted-foreground uppercase">Disk IO</span><span class="font-mono text-[11px] tabular-nums">read {formatBytes(last(rd))}/s · write {formatBytes(last(wr))}/s</span></div>
        <div class="h-12 text-chart-3"><Sparkline data={rd} /></div>
        <div class="h-12 text-chart-4"><Sparkline data={wr} /></div>
        <div class="mt-1 font-mono text-[11px] text-muted-foreground">total read {formatBytes(cur.blockRead)} · written {formatBytes(cur.blockWrite)} · {cur.pids} PIDs</div>
      </section>
    </div>
  {/if}
</div>
