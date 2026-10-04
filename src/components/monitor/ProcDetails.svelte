<script lang="ts">
  // Detail drawer for the selected process (§14.4.H). Static facts come from the
  // snapshot row; cmdline / cwd / exe / env + fd counts / children are read from
  // /proc/<pid> on demand (proc_details) and fail soft on permission errors.
  import { untrack } from "svelte";
  import { monitor, fmtBytes, fmtCpuTime } from "../../lib/monitor.svelte";
  import type { MonProc, ProcDetails } from "../../lib/types";
  import { fmtElapsed, fmtStart } from "./htop";
  import { Button } from "$lib/components/ui/button/index.js";
  import XIcon from "@lucide/svelte/icons/x";
  import RefreshIcon from "@lucide/svelte/icons/refresh-cw";
  import SkullIcon from "@lucide/svelte/icons/skull";

  let {
    proc,
    procs,
    ts,
    paused,
    onSelect,
    onKill,
    onNice,
    onClose,
  }: {
    proc: MonProc;
    procs: MonProc[];
    ts: number;
    paused: boolean;
    onSelect: (pid: number) => void;
    onKill: () => void;
    onNice: (delta: number) => void;
    onClose: () => void;
  } = $props();

  let d = $state<ProcDetails | null>(null);
  let failed = $state(false);
  let loading = $state(false);
  let loadedPid = -1;
  let seq = 0;

  async function load(pid: number) {
    const mine = ++seq;
    loading = true;
    const r = await monitor.details(pid);
    if (mine !== seq) return;
    loading = false;
    failed = r === null;
    d = r;
    loadedPid = pid;
  }

  // Load when the selected pid changes (debounced so arrow-key scrolling stays cheap).
  $effect(() => {
    const pid = proc.pid;
    if (untrack(() => loadedPid) !== pid) d = null;
    const t = setTimeout(() => void load(pid), 150);
    return () => clearTimeout(t);
  });
  // Light auto-refresh while open and live.
  $effect(() => {
    if (paused) return;
    const pid = proc.pid;
    const t = setInterval(() => void load(pid), 5000);
    return () => clearInterval(t);
  });

  const denied = (n: number) => n < 0;
  const kids = $derived.by(() => {
    const fromSnap = procs.filter((p) => p.ppid === proc.pid && p.pid !== proc.pid && !p.thread).map((p) => p.pid);
    const fromProc = d?.exists ? d.children : [];
    return [...new Set([...fromSnap, ...fromProc])].sort((a, b) => a - b);
  });
  const nameOf = (pid: number) => procs.find((p) => p.pid === pid)?.command ?? "";
  const cmdline = $derived(d?.exists && d.cmdline ? d.cmdline : proc.args);
  const elapsed = $derived(proc.start ? ts / 1000 - proc.start : -1);
</script>

<aside class="flex min-h-0 min-w-0 flex-col overflow-hidden border-border bg-card text-[11px]" data-testid="proc-details">
  <div class="flex flex-none items-center gap-2 border-b border-border px-3 py-1.5">
    <div class="min-w-0 flex-1">
      <div class="truncate text-[12px] font-semibold" data-testid="pd-title">{proc.command}{proc.thread ? " (thread)" : ""}</div>
      <div class="font-mono text-muted-foreground">PID {proc.pid} · PPID {proc.ppid}</div>
    </div>
    <Button variant="ghost" size="icon" class="size-6" title="Refresh details" onclick={() => void load(proc.pid)}>
      <RefreshIcon class={`size-3.5 ${loading ? "animate-spin" : ""}`} />
    </Button>
    <Button variant="ghost" size="icon" class="size-6" title="Close (Esc)" onclick={onClose} data-testid="pd-close"><XIcon class="size-3.5" /></Button>
  </div>

  <div class="min-h-0 flex-1 space-y-3 overflow-auto px-3 py-2">
    {#if failed}
      <p class="text-destructive" data-testid="pd-error">Could not read /proc/{proc.pid} (session busy or disconnected).</p>
    {:else if d && !d.exists}
      <p class="text-warning" data-testid="pd-gone">This process has exited.</p>
    {/if}

    <section>
      <div class="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Command line</div>
      <div class="max-h-24 overflow-auto break-all rounded bg-muted px-2 py-1 font-mono" data-testid="pd-cmdline">{cmdline}</div>
    </section>

    <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono">
      <dt class="text-muted-foreground">Exe</dt>
      <dd class="truncate" title={d?.exe} data-testid="pd-exe">{d ? (d.exe || (d.exists ? "unreadable" : "-")) : "…"}</dd>
      <dt class="text-muted-foreground">Cwd</dt>
      <dd class="truncate" title={d?.cwd} data-testid="pd-cwd">{d ? (d.cwd || (d.exists ? "unreadable" : "-")) : "…"}</dd>
      <dt class="text-muted-foreground">User</dt>
      <dd>{proc.user}{d?.uid ? ` (uid ${d.uid})` : ""}</dd>
      <dt class="text-muted-foreground">State</dt>
      <dd>{proc.state}</dd>
      <dt class="text-muted-foreground">Started</dt>
      <dd data-testid="pd-start">{proc.start ? `${fmtStart(proc.start, ts)} (${fmtElapsed(elapsed)} ago)` : "-"}</dd>
      <dt class="text-muted-foreground">CPU time</dt>
      <dd>{fmtCpuTime(proc.time)} · {proc.cpu.toFixed(1)}%</dd>
      <dt class="text-muted-foreground">Priority</dt>
      <dd>PRI {proc.pri} · NI {proc.ni}</dd>
      <dt class="text-muted-foreground">Memory</dt>
      <dd>VIRT {fmtBytes(proc.virt)} · RES {fmtBytes(proc.res)} · SHR {fmtBytes(proc.shr)} · {proc.mem.toFixed(1)}%</dd>
      {#if d?.exists}
        {#if d.vmPeak}<dt class="text-muted-foreground">Peak virt</dt><dd>{fmtBytes(d.vmPeak)}</dd>{/if}
        {#if d.vmSwap}<dt class="text-muted-foreground">Swapped</dt><dd>{fmtBytes(d.vmSwap)}</dd>{/if}
      {/if}
      <dt class="text-muted-foreground">Threads</dt>
      <dd data-testid="pd-threads">{d?.exists && d.threads ? d.threads : proc.threads}</dd>
      <dt class="text-muted-foreground">Environment</dt>
      <dd data-testid="pd-env">{d ? (denied(d.envCount) ? "permission denied" : `${d.envCount} variables`) : "…"}</dd>
      <dt class="text-muted-foreground">Open files</dt>
      <dd data-testid="pd-fds">{d ? (denied(d.fdCount) ? "permission denied" : String(d.fdCount)) : "…"}</dd>
      {#if d?.exists}
        <dt class="text-muted-foreground">Ctx switches</dt>
        <dd>{d.ctxVoluntary} voluntary · {d.ctxNonvoluntary} forced</dd>
        <dt class="text-muted-foreground">Disk I/O</dt>
        <dd>{denied(d.ioRead) ? "permission denied" : `${fmtBytes(d.ioRead)} read · ${fmtBytes(Math.max(0, d.ioWrite))} written`}</dd>
      {/if}
    </dl>

    <section>
      <div class="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Children ({kids.length})</div>
      <div class="flex flex-wrap gap-1" data-testid="pd-children">
        {#each kids.slice(0, 40) as pid (pid)}
          <button
            type="button"
            class="rounded border border-border px-1.5 py-0.5 font-mono hover:bg-accent"
            title={nameOf(pid)}
            onclick={() => onSelect(pid)}
          >{pid}{nameOf(pid) ? ` ${nameOf(pid)}` : ""}</button>
        {:else}
          <span class="text-muted-foreground">none</span>
        {/each}
        {#if kids.length > 40}<span class="text-muted-foreground">+{kids.length - 40} more</span>{/if}
      </div>
    </section>

    {#if d?.exists && d.fds.length}
      <section>
        <div class="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Open files (first {d.fds.length})</div>
        <ul class="space-y-0.5 font-mono" data-testid="pd-fdlist">
          {#each d.fds as f}<li class="truncate" title={f}>{f}</li>{/each}
        </ul>
      </section>
    {/if}
  </div>

  <div class="flex flex-none flex-wrap gap-1.5 border-t border-border px-3 py-1.5">
    <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-[11px] text-destructive" onclick={onKill} data-testid="pd-kill"><SkullIcon class="size-3" /> Signal…</Button>
    <Button variant="outline" size="sm" class="h-6 px-2 text-[11px]" onclick={() => onNice(-1)} title="Nice - (F7)">Nice −</Button>
    <Button variant="outline" size="sm" class="h-6 px-2 text-[11px]" onclick={() => onNice(1)} title="Nice + (F8)">Nice +</Button>
  </div>
</aside>
