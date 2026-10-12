<script lang="ts">
  // Details drawer for one unit (§15.3.V): properties, unit file, journal, dependencies, timers.
  import { clipboardWrite } from "$lib/clipboard";
  import { untrack } from "svelte";
  import * as api from "../../../lib/api";
  import { app } from "../../../lib/stores.svelte";
  import { systemd, errText } from "../../../lib/systemd/systemd.svelte";
  import { dotClass, fmtMem, fmtRelUsec, fmtUsec, isFailed, parseDeps, unescapeUnit, type DepNode } from "../../../lib/systemd/model";
  import type { SvcRow, SystemdAction, SystemdProp } from "../../../lib/systemd/types";
  import JournalTail from "./JournalTail.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import XIcon from "@lucide/svelte/icons/x";
  import RefreshIcon from "@lucide/svelte/icons/refresh-cw";
  import PlayIcon from "@lucide/svelte/icons/play";
  import SquareIcon from "@lucide/svelte/icons/square";
  import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import CopyIcon from "@lucide/svelte/icons/copy";

  type DTab = "props" | "file" | "journal" | "deps" | "timers";

  let {
    sessionId,
    row,
    user,
    canSudo,
    tab = $bindable("props"),
    onClose,
    onNavigate,
  }: {
    sessionId: string;
    row: SvcRow;
    user: boolean;
    canSudo: boolean;
    tab?: DTab;
    onClose: () => void;
    onNavigate: (unit: string) => void;
  } = $props();

  const TABS: { id: DTab; label: string }[] = [
    { id: "props", label: "Properties" },
    { id: "file", label: "Unit file" },
    { id: "journal", label: "Journal" },
    { id: "deps", label: "Dependencies" },
    { id: "timers", label: "Timers" },
  ];

  let props = $state<SystemdProp[]>([]);
  let propsErr = $state("");
  let propsLoading = $state(false);
  let loadedUnit = "";
  let fileText = $state("");
  let fileErr = $state("");
  let fileLoading = $state(false);
  let depsReverse = $state(false);
  let depsRaw = $state("");
  let depsNodes = $state<DepNode[]>([]);
  let depsErr = $state("");
  let depsLoading = $state(false);

  const prop = (k: string) => props.find((p) => p.key === k)?.value ?? "";
  const fragment = $derived(prop("FragmentPath"));
  const busy = $derived(systemd.busy[row.unit]);
  const unescaped = $derived(unescapeUnit(row.unit));
  const enabledNow = $derived(["enabled", "enabled-runtime", "alias"].includes(row.enabled));
  const masked = $derived(row.enabled.startsWith("masked") || row.load === "masked");

  async function loadProps(unit: string, quiet = false) {
    if (!quiet) propsLoading = true;
    try {
      const p = await api.systemdShow(sessionId, user, unit);
      if (unit !== row.unit) return;
      props = p;
      propsErr = "";
      loadedUnit = unit;
    } catch (e) {
      if (unit === row.unit) propsErr = errText(e);
    } finally {
      propsLoading = false;
    }
  }

  async function loadFile(unit: string) {
    fileLoading = true;
    try {
      const r = await api.systemdText(sessionId, user, "cat", unit);
      if (unit !== row.unit) return;
      fileText = r.stdout;
      fileErr = r.code === 0 || r.stdout ? "" : r.stderr.trim() || `systemctl cat exited with ${r.code}`;
    } catch (e) {
      if (unit === row.unit) fileErr = errText(e);
    } finally {
      fileLoading = false;
    }
  }

  async function loadDeps(unit: string, reverse: boolean) {
    depsLoading = true;
    try {
      const r = await api.systemdText(sessionId, user, reverse ? "revdeps" : "deps", unit);
      if (unit !== row.unit) return;
      depsRaw = r.stdout;
      depsNodes = parseDeps(r.stdout);
      depsErr = r.code === 0 || r.stdout ? "" : r.stderr.trim();
    } catch (e) {
      if (unit === row.unit) depsErr = errText(e);
    } finally {
      depsLoading = false;
    }
  }

  // New unit: reset per-unit data and reload what the current tab needs.
  $effect(() => {
    const u = row.unit;
    untrack(() => {
      props = [];
      propsErr = "";
      fileText = "";
      fileErr = "";
      depsRaw = "";
      depsNodes = [];
      depsErr = "";
      loadedUnit = "";
      void loadProps(u);
    });
  });
  $effect(() => {
    const u = row.unit;
    const t = tab;
    const rev = depsReverse;
    untrack(() => {
      if (t === "file") void loadFile(u);
      else if (t === "deps") void loadDeps(u, rev);
      else if (t === "timers") void systemd.loadTimers(sessionId);
    });
  });
  // After each list refresh / action, refresh the live properties quietly.
  $effect(() => {
    void systemd.revision;
    untrack(() => {
      if (loadedUnit === row.unit && tab === "props") void loadProps(row.unit, true);
    });
  });

  const timerRows = $derived(
    (systemd.timers[`${sessionId}|${user ? "u" : "s"}`]?.rows ?? []).filter((t) => t.unit === row.unit || t.activates === row.unit),
  );
  const timersState = $derived(systemd.timers[`${sessionId}|${user ? "u" : "s"}`]);

  function act(a: SystemdAction, opts: { now?: boolean } = {}) {
    void systemd.act(sessionId, a, row.unit, opts);
  }

  async function openInEditor() {
    if (!fragment) return;
    app.sidebarView = "explorer";
    await app.openFile(sessionId, fragment);
  }

  async function copy(text: string) {
    try {
      await clipboardWrite(text);
    } catch {
      /* ignore */
    }
  }

  function fmtProp(k: string, v: string): string {
    if (k === "MemoryCurrent") {
      const n = Number(v);
      return Number.isFinite(n) && n < 1.8e19 ? fmtMem(n) : "";
    }
    if (k === "CPUUsageNSec") {
      const n = Number(v);
      return Number.isFinite(n) && n < 1.8e19 ? `${(n / 1e9).toFixed(2)} s` : "";
    }
    if (k === "ExecStart") {
      const m = /argv\[\]=([^;]*?)\s*;/.exec(v);
      return m ? m[1].trim() : v;
    }
    return v;
  }
  const SKIP = new Set(["Id", "Names", "Description", "Type"]);
  const shownProps = $derived(
    props
      .filter((p) => !SKIP.has(p.key) && p.value !== "" && p.value !== "[not set]" && fmtProp(p.key, p.value) !== "")
      .map((p) => ({ key: p.key, value: fmtProp(p.key, p.value) })),
  );
  const typeProp = $derived(prop("Type"));
</script>

<aside class="flex min-h-0 min-w-0 flex-col overflow-hidden border-border bg-card text-[11px]" data-testid="svc-details" data-unit={row.unit}>
  <div class="flex flex-none items-start gap-2 border-b border-border px-3 py-1.5">
    <span class={`mt-1 size-2 flex-none rounded-full ${dotClass(row)}`}></span>
    <div class="min-w-0 flex-1">
      <div class="truncate font-mono text-[12px] font-semibold" title={row.unit} data-testid="svc-title">{row.unit}</div>
      {#if unescaped !== row.unit}<div class="truncate font-mono text-muted-foreground" title="Unescaped name">{unescaped}</div>{/if}
      <div class="truncate text-muted-foreground">{row.description || prop("Description")}</div>
      <div class="mt-0.5 flex flex-wrap gap-x-3 text-muted-foreground">
        <span>{row.load}</span><span class={isFailed(row) ? "font-semibold text-destructive" : ""}>{row.active} ({row.sub})</span>
        {#if row.enabled}<span>{row.enabled}{row.preset ? ` · preset ${row.preset}` : ""}</span>{/if}
        {#if typeProp}<span>Type={typeProp}</span>{/if}
      </div>
    </div>
    <Button variant="ghost" size="icon" class="size-6" title="Close (Esc)" onclick={onClose} data-testid="svc-close"><XIcon class="size-3.5" /></Button>
  </div>

  <div class="flex flex-none flex-wrap gap-1 border-b border-border px-3 py-1.5" data-testid="svc-actions">
    <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-[11px]" disabled={!!busy || masked} onclick={() => act("start")} data-testid="svc-act-start"><PlayIcon class="size-3" /> Start</Button>
    <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-[11px]" disabled={!!busy} onclick={() => act("stop")} data-testid="svc-act-stop"><SquareIcon class="size-3" /> Stop</Button>
    <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-[11px]" disabled={!!busy || masked} onclick={() => act("restart")} data-testid="svc-act-restart"><RotateCwIcon class="size-3" /> Restart</Button>
    <Button variant="outline" size="sm" class="h-6 px-2 text-[11px]" disabled={!!busy || masked} onclick={() => act("reload")} data-testid="svc-act-reload">Reload</Button>
    {#if enabledNow}
      <Button variant="outline" size="sm" class="h-6 px-2 text-[11px]" disabled={!!busy} onclick={() => act("disable")} data-testid="svc-act-disable">Disable</Button>
    {:else}
      <Button variant="outline" size="sm" class="h-6 px-2 text-[11px]" disabled={!!busy || masked} onclick={() => act("enable")} data-testid="svc-act-enable">Enable</Button>
    {/if}
    {#if masked}
      <Button variant="outline" size="sm" class="h-6 px-2 text-[11px]" disabled={!!busy} onclick={() => act("unmask")} data-testid="svc-act-unmask">Unmask</Button>
    {:else}
      <Button variant="outline" size="sm" class="h-6 px-2 text-[11px] text-destructive" disabled={!!busy} onclick={() => act("mask")} data-testid="svc-act-mask">Mask</Button>
    {/if}
    {#if isFailed(row)}
      <Button variant="outline" size="sm" class="h-6 px-2 text-[11px]" disabled={!!busy} onclick={() => act("reset-failed")} data-testid="svc-act-reset">Reset failed</Button>
    {/if}
  </div>

  <div class="flex flex-none gap-0.5 border-b border-border px-2" role="tablist" aria-label="Unit details">
    {#each TABS as t (t.id)}
      <button
        type="button"
        role="tab"
        aria-selected={tab === t.id}
        class={`-mb-px border-b-2 px-2 py-1 text-[11px] font-medium ${tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        data-testid={`svc-dtab-${t.id}`}
        onclick={() => (tab = t.id)}
      >{t.label}</button>
    {/each}
  </div>

  <div class="flex min-h-0 flex-1 flex-col overflow-auto px-3 py-2">
    {#if tab === "props"}
      {#if propsErr}
        <p class="text-destructive" data-testid="svc-props-error">{propsErr}</p>
      {:else if propsLoading && props.length === 0}
        <p class="text-muted-foreground">Loading…</p>
      {:else}
        {#if prop("NeedDaemonReload") === "yes"}
          <p class="mb-2 rounded bg-warning/15 px-2 py-1 text-warning" data-testid="svc-needs-reload">
            The unit file changed on disk. Run <code>daemon-reload</code> to apply it.
            <Button variant="outline" size="sm" class="ml-1 h-5 px-1.5 text-[10px]" onclick={() => void systemd.act(sessionId, "daemon-reload", undefined)}>daemon-reload</Button>
          </p>
        {/if}
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5" data-testid="svc-props">
          {#each shownProps as p (p.key)}
            <dt class="text-muted-foreground">{p.key}</dt>
            <dd class="break-words font-mono" data-prop={p.key}>{p.value}</dd>
          {/each}
        </dl>
      {/if}
    {:else if tab === "file"}
      <div class="mb-1 flex flex-none items-center gap-1.5">
        <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-[11px]" disabled={!fragment} onclick={() => void openInEditor()} title={fragment || "No unit file path"} data-testid="svc-open-file">
          <FileTextIcon class="size-3" /> Open in editor
        </Button>
        <Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-[11px]" disabled={!fileText} onclick={() => void copy(fileText)}><CopyIcon class="size-3" /> Copy</Button>
        <span class="ml-auto truncate font-mono text-[10px] text-muted-foreground" title={fragment}>{fragment}</span>
      </div>
      {#if fileErr}
        <p class="text-destructive" data-testid="svc-file-error">{fileErr}</p>
      {:else if fileLoading && !fileText}
        <p class="text-muted-foreground">Loading…</p>
      {/if}
      <pre class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-background p-2 font-mono text-[10.5px]" data-testid="svc-file-text">{fileText}</pre>
    {:else if tab === "journal"}
      {#key `${row.unit}|${user}`}
        <JournalTail {sessionId} unit={row.unit} {user} {canSudo} />
      {/key}
    {:else if tab === "deps"}
      <div class="mb-1 flex flex-none items-center gap-1.5">
        <Button variant={depsReverse ? "outline" : "secondary"} size="sm" class="h-6 px-2 text-[11px]" onclick={() => (depsReverse = false)} data-testid="svc-deps-fwd">Requires</Button>
        <Button variant={depsReverse ? "secondary" : "outline"} size="sm" class="h-6 px-2 text-[11px]" onclick={() => (depsReverse = true)} data-testid="svc-deps-rev">Required by</Button>
        <Button variant="ghost" size="icon" class="size-6" onclick={() => void loadDeps(row.unit, depsReverse)} title="Reload"><RefreshIcon class={`size-3 ${depsLoading ? "animate-spin" : ""}`} /></Button>
      </div>
      {#if depsErr}
        <p class="text-destructive">{depsErr}</p>
      {:else if depsNodes.length > 1}
        <ul class="font-mono text-[11px]" data-testid="svc-deps">
          {#each depsNodes.slice(1) as n, i (i)}
            <li class="flex items-center gap-1.5 py-px" style={`padding-left:${Math.max(0, n.depth - 1) * 12}px`}>
              <span class={`size-1.5 flex-none rounded-full ${n.state === "failed" ? "bg-destructive" : n.state === "active" ? "bg-success" : "bg-muted-foreground/50"}`}></span>
              <button type="button" class="truncate text-left hover:underline" onclick={() => onNavigate(n.name)} data-dep={n.name}>{n.name}</button>
            </li>
          {/each}
        </ul>
      {:else if depsLoading}
        <p class="text-muted-foreground">Loading…</p>
      {:else}
        <p class="text-muted-foreground" data-testid="svc-deps-empty">{depsRaw.trim() && depsNodes.length === 0 ? depsRaw : "No dependencies."}</p>
      {/if}
    {:else if tab === "timers"}
      {#if timersState?.error}
        <p class="text-destructive">{timersState.error}</p>
      {:else if timersState?.loading && timerRows.length === 0}
        <p class="text-muted-foreground">Loading…</p>
      {:else if timerRows.length === 0}
        <p class="text-muted-foreground" data-testid="svc-timers-empty">No timer is attached to this unit.</p>
      {:else}
        <ul class="space-y-2" data-testid="svc-timers">
          {#each timerRows as t (t.unit)}
            <li class="rounded border border-border p-2">
              <div class="font-mono font-semibold">{t.unit} → {t.activates}</div>
              {#if t.next || t.last}
                <div class="text-muted-foreground">Next: {t.next ? `${fmtUsec(t.next)} (${fmtRelUsec(t.next, Date.now())})` : "n/a"}</div>
                <div class="text-muted-foreground">Last: {t.last ? `${fmtUsec(t.last)} (${fmtRelUsec(t.last, Date.now())})` : "n/a"}</div>
              {:else}
                <div class="text-muted-foreground">{t.text}</div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</aside>
