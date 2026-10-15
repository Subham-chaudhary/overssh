<script lang="ts">
  // htop-style dashboard for one connected VM (§13.4.M). Data comes from
  // monitor.svelte.ts (one `sh` loop per session, parsed in Rust). Polling runs
  // only while this component is mounted.
  import { untrack } from "svelte";
  import { app } from "../../lib/stores.svelte";
  import {
    monitor,
    INTERVALS,
    HISTORY_LEN,
    fmtBytes,
    fmtShort,
    fmtRate,
    fmtUptime,
  } from "../../lib/monitor.svelte";
  import Meter from "./Meter.svelte";
  import Sparkline from "./Sparkline.svelte";
  import DiskUsage from "./DiskUsage.svelte";
  import CronEditor from "./CronEditor.svelte";
  import HtopView from "./HtopView.svelte";
  import ServicesView from "./services/ServicesView.svelte";
  import { systemd } from "../../lib/systemd/systemd.svelte";
  import { htopPrefs } from "./htopPrefs.svelte";
  import Loader from "../Loader.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import PauseIcon from "@lucide/svelte/icons/pause";
  import PlayIcon from "@lucide/svelte/icons/play";
  import NetworkIcon from "@lucide/svelte/icons/network";
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import ArrowUpIcon from "@lucide/svelte/icons/arrow-up";
  import ArrowDownIcon from "@lucide/svelte/icons/arrow-down";

  $effect(() => monitor.attachView());
  $effect(() => {
    // re-sync when the selection / session list / tab changes (only htop streams per-process data)
    void monitor.selectedId;
    void app.sessions.length;
    void monitor.tab;
    monitor.sync();
  });

  type MonTab = "overview" | "htop" | "services" | "disk" | "cron";
  const TABS: { id: MonTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "htop", label: "htop" },
    { id: "services", label: "Services" },
    { id: "disk", label: "Disk usage" },
    { id: "cron", label: "Cron" },
  ];
  const tab = $derived(monitor.tab);

  // Failed-units count on the Services tab (polled every 30 s while the Dashboard is open).
  $effect(() => {
    const sid = monitor.selectedId;
    return untrack(() => systemd.watchBadge(sid));
  });
  const failedUnits = $derived(systemd.failedCount(monitor.selectedId));

  const snap = $derived(monitor.viewSnapshot);
  const sessionId = $derived(monitor.selectedId);
  const session = $derived(app.sessions.find((s) => s.id === sessionId) ?? null);
  const hist = $derived(sessionId ? (monitor.history[sessionId] ?? []) : []);

  const memPct = $derived(snap && snap.mem.total ? (snap.mem.used * 100) / snap.mem.total : 0);
  const pctOf = (n: number, total: number) => (total ? (n * 100) / total : 0);

  // Overview only: Space pauses / resumes updates (the htop tab owns its own keys).
  function onKey(e: KeyboardEvent) {
    if (tab !== "overview") return;
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement || t.closest("[role=dialog]")) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.key !== " ") return;
    monitor.setPaused(!monitor.paused);
    e.preventDefault();
  }

  const rxTotal = $derived(snap?.net.reduce((a, n) => a + n.rxRate, 0) ?? 0);
  const txTotal = $derived(snap?.net.reduce((a, n) => a + n.txRate, 0) ?? 0);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="@container/mon flex h-full min-h-0 flex-col bg-background text-foreground outline-none"
  tabindex="0"
  role="region"
  aria-label="Dashboard"
  onkeydown={onKey}
  data-testid="monitor-view"
>
  {#if !session}
    <div class="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground" data-testid="monitor-view-empty">
      <ActivityIcon class="size-8 opacity-60" />
      <p class="text-sm font-medium text-foreground">No VM connected</p>
      <p class="text-[12px]">Connect to a host to see its live htop-style dashboard.</p>
    </div>
  {:else}
    <!-- Header -->
    <header class="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <ActivityIcon class="size-4 text-primary" />
          <h2 class="truncate text-sm font-semibold" data-testid="monitor-title">{snap?.host.hostname || session.label}</h2>
          {#if monitor.paused}
            <span class="rounded bg-warning/20 px-1.5 text-[10px] font-semibold uppercase text-warning">Paused</span>
          {/if}
        </div>
        <div class="truncate text-[11px] text-muted-foreground">
          {session.user}@{session.hostname}{#if snap} · {snap.host.os || "Linux"} · {snap.host.kernel} · {snap.host.arch}{/if}
        </div>
      </div>
      {#if snap && !(tab === "htop" && htopPrefs.meters)}
        <dl class="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px]">
          <div><dt class="inline text-muted-foreground">Uptime </dt><dd class="inline">{fmtUptime(snap.uptime)}</dd></div>
          <div><dt class="inline text-muted-foreground">Load </dt><dd class="inline" data-testid="monitor-load">{snap.load.map((l) => l.toFixed(2)).join(" ")}</dd></div>
          <div><dt class="inline text-muted-foreground">Tasks </dt><dd class="inline">{snap.tasks.total}, {snap.tasks.threads} thr, {snap.tasks.running} running</dd></div>
        </dl>
      {/if}
      <div class="ml-auto flex flex-wrap items-center gap-2">
        {#if app.sessions.length > 1}
          <Select.Root type="single" value={sessionId ?? ""} onValueChange={(v) => v && monitor.select(v)}>
            <Select.Trigger class="h-7 w-36 text-[12px]">{session.label}</Select.Trigger>
            <Select.Content>
              {#each app.sessions as s (s.id)}
                <Select.Item value={s.id} label={s.label}>{s.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        {/if}
        <Select.Root type="single" value={String(monitor.intervalMs)} onValueChange={(v) => v && monitor.setInterval(Number(v))}>
          <Select.Trigger class="h-7 w-24 text-[12px]" aria-label="Refresh interval" data-testid="monitor-interval">{monitor.intervalMs / 1000}s</Select.Trigger>
          <Select.Content>
            {#each INTERVALS as ms}
              <Select.Item value={String(ms)} label={`${ms / 1000}s`}>{ms / 1000}s</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-[12px]" onclick={() => monitor.setPaused(!monitor.paused)} data-testid="monitor-pause">
          {#if monitor.paused}<PlayIcon class="size-3.5" /> Resume{:else}<PauseIcon class="size-3.5" /> Pause{/if}
        </Button>
      </div>
    </header>

    <div class="flex flex-none gap-1 border-b border-border px-3 pt-1" role="tablist" aria-label="Dashboard sections" data-testid="monitor-tabs">
      {#each TABS as t (t.id)}
        <button
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          class={`-mb-px border-b-2 px-3 py-1.5 text-[12px] font-medium ${tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          data-testid={`monitor-tab-${t.id}`}
          onclick={() => (monitor.tab = t.id)}
        >{t.label}{#if t.id === "services" && failedUnits > 0}<span class="ml-1.5 rounded-full bg-destructive px-1.5 py-px text-[10px] font-semibold leading-none text-white" title={`${failedUnits} failed unit${failedUnits === 1 ? "" : "s"}`} data-testid="svc-failed-badge">{failedUnits}</span>{/if}</button>
      {/each}
    </div>

    {#if tab === "disk"}
      {#key session.id}
        <DiskUsage sessionId={session.id} home={session.home} disks={snap?.disks ?? []} />
      {/key}
    {:else if tab === "cron"}
      {#key session.id}
        <CronEditor sessionId={session.id} />
      {/key}
    {:else if tab === "htop"}
      {#key session.id}
        <HtopView />
      {/key}
    {:else if tab === "services"}
      {#key session.id}
        <ServicesView />
      {/key}
    {:else if !snap}
      <div class="flex flex-1 items-center justify-center">
        {#if monitor.errors[session.id]}
          <p class="text-sm text-destructive">{monitor.errors[session.id]}</p>
        {:else}
          <Loader label="Collecting stats…" size="lg" />
        {/if}
      </div>
    {:else}
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <!-- Meters -->
        <section class="grid flex-none gap-x-6 gap-y-3 border-b border-border px-4 py-3 @4xl/mon:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div>
            <div class="mb-1.5 flex items-center justify-between text-[11px]">
              <span class="font-semibold uppercase tracking-wide text-muted-foreground">CPU · {snap.cores.length} cores</span>
              <span class="flex gap-2 text-[10px] text-muted-foreground">
                <span><i class="mr-1 inline-block size-2 rounded-sm bg-success"></i>user</span>
                <span><i class="mr-1 inline-block size-2 rounded-sm bg-chart-1"></i>nice</span>
                <span><i class="mr-1 inline-block size-2 rounded-sm bg-destructive"></i>system</span>
                <span><i class="mr-1 inline-block size-2 rounded-sm bg-muted-foreground"></i>iowait</span>
              </span>
            </div>
            <div class="grid gap-x-4 gap-y-1" style="grid-template-columns:repeat(auto-fill,minmax(min(220px,100%),1fr))">
              <Meter
                testid="cpu-total"
                label="All"
                segments={[
                  { value: snap.cpu.user, class: "bg-success" },
                  { value: snap.cpu.nice, class: "bg-chart-1" },
                  { value: snap.cpu.system, class: "bg-destructive" },
                  { value: snap.cpu.iowait + snap.cpu.steal, class: "bg-muted-foreground" },
                ]}
                text={`${snap.cpu.total.toFixed(1)}%`}
              />
              {#each snap.cores as c, i}
                <Meter
                  testid="cpu-core"
                  label={String(i)}
                  segments={[
                    { value: c.user, class: "bg-success", title: `user ${c.user.toFixed(1)}%` },
                    { value: c.nice, class: "bg-chart-1", title: `nice ${c.nice.toFixed(1)}%` },
                    { value: c.system, class: "bg-destructive", title: `system ${c.system.toFixed(1)}%` },
                    { value: c.iowait + c.steal, class: "bg-muted-foreground", title: `iowait/steal ${(c.iowait + c.steal).toFixed(1)}%` },
                  ]}
                  text={`${c.total.toFixed(1)}%`}
                />
              {/each}
            </div>
          </div>
          <div class="space-y-1">
            <div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Memory</div>
            <Meter
              testid="mem-meter"
              label="Mem"
              segments={[
                { value: pctOf(snap.mem.used, snap.mem.total), class: "bg-success", title: `used ${fmtBytes(snap.mem.used)}` },
                { value: pctOf(snap.mem.buffers, snap.mem.total), class: "bg-chart-1", title: `buffers ${fmtBytes(snap.mem.buffers)}` },
                { value: pctOf(snap.mem.cache, snap.mem.total), class: "bg-warning", title: `cache ${fmtBytes(snap.mem.cache)}` },
              ]}
              text={`${fmtShort(snap.mem.used)}/${fmtShort(snap.mem.total)}`}
            />
            <Meter
              testid="swap-meter"
              label="Swp"
              segments={[{ value: pctOf(snap.mem.swapUsed, snap.mem.swapTotal), class: "bg-destructive" }]}
              text={snap.mem.swapTotal ? `${fmtShort(snap.mem.swapUsed)}/${fmtShort(snap.mem.swapTotal)}` : "none"}
            />
            <div class="flex gap-3 pl-10 text-[10px] text-muted-foreground">
              <span><i class="mr-1 inline-block size-2 rounded-sm bg-success"></i>used</span>
              <span><i class="mr-1 inline-block size-2 rounded-sm bg-chart-1"></i>buffers</span>
              <span><i class="mr-1 inline-block size-2 rounded-sm bg-warning"></i>cache</span>
              <span class="ml-auto">avail {fmtBytes(snap.mem.available)}</span>
            </div>
          </div>
        </section>

        <!-- History + disks/net -->
        <section class="grid flex-none gap-3 border-b border-border px-4 py-3 @lg/mon:grid-cols-2 @5xl/mon:grid-cols-4">
          {#each [
            { id: "cpu", label: "CPU", cls: "text-success", data: hist.map((h) => h.cpu), max: 100, now: `${snap.cpu.total.toFixed(1)}%` },
            { id: "mem", label: "Memory", cls: "text-chart-1", data: hist.map((h) => h.mem), max: 100, now: `${memPct.toFixed(1)}%` },
            { id: "rx", label: "Net ↓", cls: "text-chart-4", data: hist.map((h) => h.rx), max: 0, now: fmtRate(rxTotal) },
            { id: "tx", label: "Net ↑", cls: "text-chart-3", data: hist.map((h) => h.tx), max: 0, now: fmtRate(txTotal) },
          ] as c (c.id)}
            <div class="rounded-md border border-border bg-card p-2" data-testid={`spark-${c.id}`}>
              <div class="flex items-baseline justify-between text-[11px]">
                <span class="text-muted-foreground">{c.label}</span>
                <span class="font-mono tabular-nums">{c.now}</span>
              </div>
              <div class={`mt-1 h-12 ${c.cls}`}><Sparkline data={c.data} max={c.max} /></div>
              <div class="mt-0.5 text-right text-[9px] text-muted-foreground">last {Math.min(hist.length, HISTORY_LEN)} samples</div>
            </div>
          {/each}
        </section>

        <section class="grid flex-none gap-x-6 gap-y-3 border-b border-border px-4 py-3 @2xl/mon:grid-cols-2">
          <div class="space-y-1.5">
            <div class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Disks</div>
            {#each snap.disks as d (d.mount)}
              <Meter
                testid="disk-row"
                label=""
                height="h-2.5"
                segments={[{ value: d.percent, class: d.percent > 90 ? "bg-destructive" : d.percent > 75 ? "bg-warning" : "bg-chart-1" }]}
                text={`${d.percent.toFixed(0)}% ${fmtShort(d.used)}/${fmtShort(d.total)}`}
              />
              <div class="-mt-1 truncate pl-10 font-mono text-[10px] text-muted-foreground">{d.mount} <span class="opacity-60">({d.filesystem})</span></div>
            {:else}
              <p class="text-[11px] text-muted-foreground">No disk info.</p>
            {/each}
          </div>
          <div class="space-y-1">
            <div class="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"><NetworkIcon class="size-3" /> Network</div>
            {#each snap.net as n (n.name)}
              <div class="flex items-center gap-3 font-mono text-[11px]" data-testid="net-row">
                <span class="w-20 truncate text-muted-foreground">{n.name}</span>
                <span class="flex w-28 items-center gap-1 tabular-nums text-chart-4"><ArrowDownIcon class="size-3" />{fmtRate(n.rxRate)}</span>
                <span class="flex w-28 items-center gap-1 tabular-nums text-chart-3"><ArrowUpIcon class="size-3" />{fmtRate(n.txRate)}</span>
                <span class="hidden text-muted-foreground @4xl/mon:inline">total {fmtBytes(n.rxBytes)} / {fmtBytes(n.txBytes)}</span>
              </div>
            {:else}
              <p class="text-[11px] text-muted-foreground">No interfaces.</p>
            {/each}
          </div>
        </section>

      </div>
    {/if}
  {/if}
</div>
