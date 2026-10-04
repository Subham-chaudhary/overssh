<script lang="ts">
  // htop header: per-core CPU bars (user / nice / system / iowait), Mem + Swap
  // bars, tasks, load average and uptime. Wraps to one column when narrow.
  import type { MonitorSnapshot } from "../../lib/types";
  import { fmtShort, fmtUptime } from "../../lib/monitor.svelte";
  import Meter from "./Meter.svelte";

  let { snap }: { snap: MonitorSnapshot } = $props();

  const pctOf = (n: number, total: number) => (total ? (n * 100) / total : 0);
  const compact = $derived(snap.cores.length > 16);
  const seg = (c: MonitorSnapshot["cpu"]) => [
    { value: c.user, class: "bg-success", title: `user ${c.user.toFixed(1)}%` },
    { value: c.nice, class: "bg-chart-1", title: `nice ${c.nice.toFixed(1)}%` },
    { value: c.system, class: "bg-destructive", title: `system ${c.system.toFixed(1)}%` },
    { value: c.iowait + c.steal, class: "bg-muted-foreground", title: `iowait/steal ${(c.iowait + c.steal).toFixed(1)}%` },
  ];
</script>

<section
  class="grid flex-none gap-x-6 gap-y-2 border-b border-border px-4 py-2 @4xl/mon:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
  data-testid="htop-meters"
>
  <div class="min-w-0">
    <div class="mb-1 flex flex-wrap items-center justify-between gap-x-3 text-[10px] text-muted-foreground">
      <span class="font-semibold uppercase tracking-wide">CPU · {snap.cores.length} cores</span>
      <span class="flex flex-wrap gap-x-2">
        <span><i class="mr-1 inline-block size-2 rounded-sm bg-success"></i>user</span>
        <span><i class="mr-1 inline-block size-2 rounded-sm bg-chart-1"></i>nice</span>
        <span><i class="mr-1 inline-block size-2 rounded-sm bg-destructive"></i>system</span>
        <span><i class="mr-1 inline-block size-2 rounded-sm bg-muted-foreground"></i>iowait</span>
      </span>
    </div>
    <div
      class="grid max-h-40 gap-x-4 gap-y-0.5 overflow-y-auto"
      style={`grid-template-columns:repeat(auto-fill,minmax(min(${compact ? 150 : 200}px,100%),1fr))`}
    >
      <Meter testid="htop-cpu-total" label="All" height={compact ? "h-2" : "h-2.5"} segments={seg(snap.cpu)} text={`${snap.cpu.total.toFixed(1)}%`} />
      {#each snap.cores as c, i}
        <Meter testid="htop-cpu-core" label={String(i)} height={compact ? "h-2" : "h-2.5"} segments={seg(c)} text={`${c.total.toFixed(1)}%`} />
      {/each}
    </div>
  </div>
  <div class="min-w-0 space-y-0.5">
    <Meter
      testid="htop-mem"
      label="Mem"
      height="h-2.5"
      segments={[
        { value: pctOf(snap.mem.used, snap.mem.total), class: "bg-success", title: `used ${fmtShort(snap.mem.used)}` },
        { value: pctOf(snap.mem.buffers, snap.mem.total), class: "bg-chart-1", title: `buffers ${fmtShort(snap.mem.buffers)}` },
        { value: pctOf(snap.mem.cache, snap.mem.total), class: "bg-warning", title: `cache ${fmtShort(snap.mem.cache)}` },
      ]}
      text={`${fmtShort(snap.mem.used)}/${fmtShort(snap.mem.total)}`}
    />
    <Meter
      testid="htop-swap"
      label="Swp"
      height="h-2.5"
      segments={[{ value: pctOf(snap.mem.swapUsed, snap.mem.swapTotal), class: "bg-destructive" }]}
      text={snap.mem.swapTotal ? `${fmtShort(snap.mem.swapUsed)}/${fmtShort(snap.mem.swapTotal)}` : "none"}
    />
    <dl class="flex flex-wrap gap-x-4 gap-y-0.5 pt-1 font-mono text-[11px]">
      <div>
        <dt class="inline text-muted-foreground">Tasks </dt>
        <dd class="inline" data-testid="htop-tasks">{snap.tasks.total}, {snap.tasks.threads} thr; <span class="text-success">{snap.tasks.running} running</span></dd>
      </div>
      <div>
        <dt class="inline text-muted-foreground">Load </dt>
        <dd class="inline" data-testid="htop-load">{snap.load.map((l) => l.toFixed(2)).join(" ")}</dd>
      </div>
      <div>
        <dt class="inline text-muted-foreground">Uptime </dt>
        <dd class="inline" data-testid="htop-uptime">{fmtUptime(snap.uptime)}</dd>
      </div>
    </dl>
    <div class="flex flex-wrap gap-x-3 pl-10 text-[10px] text-muted-foreground">
      <span><i class="mr-1 inline-block size-2 rounded-sm bg-success"></i>used</span>
      <span><i class="mr-1 inline-block size-2 rounded-sm bg-chart-1"></i>buffers</span>
      <span><i class="mr-1 inline-block size-2 rounded-sm bg-warning"></i>cache</span>
    </div>
  </div>
</section>
