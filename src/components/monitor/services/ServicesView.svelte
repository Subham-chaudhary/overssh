<script lang="ts">
  // The "Services" Dashboard tab (§15.3.V): systemd unit table with filters, keyboard
  // control and a details drawer. Data and actions live in lib/systemd/systemd.svelte.ts.
  import { untrack } from "svelte";
  import { monitor } from "../../../lib/monitor.svelte";
  import { systemd } from "../../../lib/systemd/systemd.svelte";
  import {
    dotClass,
    enabledGroup,
    filterRows,
    fmtCpu,
    fmtMem,
    isFailed,
    sortRows,
    stateCounts,
    type EnabledFilter,
    type SortKey,
    type StateFilter,
  } from "../../../lib/systemd/model";
  import type { SvcRow } from "../../../lib/systemd/types";
  import ServiceDetails from "./ServiceDetails.svelte";
  import TimersView from "./TimersView.svelte";
  import SudoDialog from "./SudoDialog.svelte";
  import Loader from "../../Loader.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import SearchIcon from "@lucide/svelte/icons/search";
  import RefreshIcon from "@lucide/svelte/icons/refresh-cw";
  import InfoIcon from "@lucide/svelte/icons/info";
  import PlayIcon from "@lucide/svelte/icons/play";
  import SquareIcon from "@lucide/svelte/icons/square";
  import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
  import ServerOffIcon from "@lucide/svelte/icons/server-off";
  import AlertTriangleIcon from "@lucide/svelte/icons/triangle-alert";

  const ROW_H = 24;
  const HEAD_H = 24;
  const OVERSCAN = 12;

  const sessionId = $derived(monitor.selectedId);
  const prefs = $derived(systemd.prefs);
  const probe = $derived(sessionId ? systemd.probes[sessionId] : undefined);
  const probeError = $derived(sessionId ? systemd.probeErrors[sessionId] : undefined);
  const ld = $derived(sessionId ? systemd.list(sessionId, prefs.user) : undefined);

  let mode = $state<"services" | "timers">("services");
  let query = $state("");
  let selectedUnit = $state<string | null>(null);
  let detailsOpen = $state(false);
  let dtab = $state<"props" | "file" | "journal" | "deps" | "timers">("props");
  let rootEl = $state<HTMLDivElement | null>(null);
  let filterEl = $state<HTMLInputElement | null>(null);
  let tableEl = $state<HTMLDivElement | null>(null);
  let tableW = $state(0);
  let viewH = $state(0);
  let scrollTop = $state(0);

  // Poll while mounted for this session; the cleanup stops the timer on session change.
  $effect(() => {
    const sid = sessionId;
    if (!sid) return;
    untrack(() => void systemd.probe(sid));
    return untrack(() => systemd.attachView(sid));
  });
  $effect(() => {
    rootEl?.focus({ preventScroll: true });
  });
  // Switching VM or system/user mode clears the selection.
  $effect(() => {
    void sessionId;
    void prefs.user;
    untrack(() => {
      selectedUnit = null;
      detailsOpen = false;
    });
  });

  const allRows = $derived(ld?.rows ?? []);
  const counts = $derived(stateCounts(allRows));
  const rows = $derived(
    sortRows(filterRows(allRows, { state: prefs.state, enabled: prefs.enabled, query }), prefs.sortKey, prefs.desc),
  );
  const selected = $derived(selectedUnit ? (allRows.find((r) => r.unit === selectedUnit) ?? null) : null);
  const canSudo = $derived(!!probe && !probe.isRoot && probe.sudo);

  const cols = $derived({
    desc: tableW === 0 || tableW >= 640,
    load: tableW === 0 || tableW >= 760,
    sub: tableW === 0 || tableW >= 420,
    enabled: tableW === 0 || tableW >= 380,
    mem: tableW === 0 || tableW >= 520,
    cpu: tableW === 0 || tableW >= 600,
  });

  const winStart = $derived(Math.max(0, Math.floor((scrollTop - HEAD_H) / ROW_H) - OVERSCAN));
  const winEnd = $derived(Math.min(rows.length, Math.ceil((scrollTop + (viewH || 800)) / ROW_H) + OVERSCAN));
  const visible = $derived(rows.slice(winStart, winEnd));
  const colCount = $derived(3 + (cols.desc ? 1 : 0) + (cols.load ? 1 : 0) + (cols.sub ? 1 : 0) + (cols.enabled ? 1 : 0) + (cols.mem ? 1 : 0) + (cols.cpu ? 1 : 0));

  function ensureVisible(i: number) {
    const el = tableEl;
    if (!el) return;
    const y = i * ROW_H;
    const h = el.clientHeight - HEAD_H;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW_H > el.scrollTop + h) el.scrollTop = y + ROW_H - h;
  }

  function select(unit: string | null, scroll = true) {
    selectedUnit = unit;
    if (unit === null || !scroll) return;
    const i = rows.findIndex((r) => r.unit === unit);
    if (i >= 0) ensureVisible(i);
  }

  function move(delta: number, abs = false) {
    if (rows.length === 0) return;
    const idx = rows.findIndex((r) => r.unit === selectedUnit);
    const next = abs ? (delta < 0 ? 0 : rows.length - 1) : idx === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, idx + delta));
    select(rows[next].unit);
  }

  function setSort(key: SortKey) {
    if (prefs.sortKey === key) prefs.desc = !prefs.desc;
    else {
      prefs.sortKey = key;
      prefs.desc = key === "memory" || key === "cpu";
    }
    systemd.savePrefs();
  }

  function setState(s: StateFilter) {
    prefs.state = s;
    systemd.savePrefs();
  }
  function setEnabled(e: EnabledFilter) {
    prefs.enabled = e;
    systemd.savePrefs();
  }

  function navigate(unit: string) {
    const r = allRows.find((x) => x.unit === unit);
    if (r) {
      query = "";
      prefs.state = "all";
      prefs.enabled = "any";
      select(unit);
      detailsOpen = true;
    } else {
      mode = "services";
      query = unit;
    }
  }

  function open(unit: string, tab?: typeof dtab) {
    select(unit, false);
    if (tab) dtab = tab;
    detailsOpen = true;
  }

  function act(a: "start" | "stop" | "restart" | "reload" | "enable" | "disable") {
    if (sessionId && selected) void systemd.act(sessionId, a, selected.unit);
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.closest("[role=dialog], [role=menu], [role=listbox], [data-testid=svc-details]")) {
      if (e.key === "Escape" && detailsOpen && t.closest("[data-testid=svc-details]")) {
        detailsOpen = false;
        rootEl?.focus();
        e.preventDefault();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (mode !== "services") return;
    const page = Math.max(1, Math.floor((viewH - HEAD_H) / ROW_H) - 1);
    switch (e.key) {
      case "ArrowDown": move(1); break;
      case "ArrowUp": move(-1); break;
      case "PageDown": move(page); break;
      case "PageUp": move(-page); break;
      case "Home": move(-1, true); break;
      case "End": move(1, true); break;
      case "/": filterEl?.focus(); filterEl?.select(); break;
      case "Enter":
      case "i": if (selected) detailsOpen = !detailsOpen; break;
      case "s": act("start"); break;
      case "S": act("stop"); break;
      case "r": act("restart"); break;
      case "R": act("reload"); break;
      case "e": act("enable"); break;
      case "d": act("disable"); break;
      case "j": if (selected) open(selected.unit, "journal"); break;
      case "f": setState(prefs.state === "failed" ? "all" : "failed"); break;
      case "u": systemd.setUser(!prefs.user); break;
      case "F5": if (sessionId) void systemd.refresh(sessionId); break;
      case "Escape":
        if (detailsOpen) detailsOpen = false;
        else if (query) query = "";
        else if (prefs.state !== "all" || prefs.enabled !== "any") {
          prefs.state = "all";
          prefs.enabled = "any";
          systemd.savePrefs();
        } else return;
        break;
      default: return;
    }
    e.preventDefault();
  }

  const CHIPS: { id: StateFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "running", label: "Running" },
    { id: "failed", label: "Failed" },
    { id: "inactive", label: "Inactive" },
  ];
  const ENABLED: { id: EnabledFilter; label: string }[] = [
    { id: "any", label: "Any enablement" },
    { id: "enabled", label: "Enabled" },
    { id: "disabled", label: "Disabled" },
    { id: "static", label: "Static" },
    { id: "masked", label: "Masked" },
  ];
  const enabledClass = (r: SvcRow) => {
    const g = enabledGroup(r.enabled);
    return g === "enabled" ? "text-success" : g === "masked" ? "text-destructive" : "text-muted-foreground";
  };
  const activeClass = (r: SvcRow) => (isFailed(r) ? "font-semibold text-destructive" : r.active === "active" ? "" : "text-muted-foreground");
  const arrow = (k: SortKey) => (prefs.sortKey === k ? (prefs.desc ? " ▼" : " ▲") : "");
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  bind:this={rootEl}
  class="flex min-h-0 flex-1 flex-col outline-none"
  tabindex="0"
  role="region"
  aria-label="systemd services"
  onkeydown={onKey}
  data-testid="services-view"
>
  {#if !sessionId}
    <div class="flex flex-1 items-center justify-center text-sm text-muted-foreground">No VM selected.</div>
  {:else if !probe && !probeError}
    <div class="flex flex-1 items-center justify-center"><Loader label="Checking for systemd…" size="lg" /></div>
  {:else if probeError}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center" data-testid="svc-probe-error">
      <AlertTriangleIcon class="size-7 text-destructive" />
      <p class="text-sm text-destructive">{probeError}</p>
      <Button variant="outline" size="sm" onclick={() => void systemd.probe(sessionId, true)}>Retry</Button>
    </div>
  {:else if probe && !probe.available}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground" data-testid="svc-nosystemd">
      <ServerOffIcon class="size-8 opacity-60" />
      <p class="text-sm font-medium text-foreground">systemd is not available on this host</p>
      <p class="max-w-md text-[12px]">
        {#if probe.pid1}The init system here is <code class="font-mono">{probe.pid1}</code> (PID 1), not systemd.{/if}
        Containers and distributions such as Alpine (OpenRC) do not use systemd, so there are no units to list.
      </p>
      <Button variant="outline" size="sm" onclick={() => void systemd.probe(sessionId, true)}>Check again</Button>
    </div>
  {:else}
    <!-- Toolbar -->
    <div class="flex flex-none flex-wrap items-center gap-1.5 px-4 pt-2" data-testid="svc-toolbar">
      <div class="relative">
        <SearchIcon class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          bind:ref={filterEl}
          bind:value={query}
          placeholder="Filter ( / )  a|b"
          class="h-7 w-40 pl-7 text-[12px] @2xl/mon:w-56"
          data-testid="svc-filter"
          onkeydown={(e: KeyboardEvent) => {
            if (e.key === "Escape") {
              query = "";
              rootEl?.focus();
              e.stopPropagation();
            } else if (e.key === "Enter" || e.key === "ArrowDown") {
              rootEl?.focus();
              if (e.key === "ArrowDown") move(rows.length && selectedUnit === null ? 0 : 1);
              e.preventDefault();
            }
          }}
        />
      </div>
      <div class="flex gap-1" role="group" aria-label="State filter">
        {#each CHIPS as c (c.id)}
          <Button
            variant={prefs.state === c.id ? "secondary" : "outline"}
            size="sm"
            class={`h-7 gap-1 px-2 text-[12px] ${c.id === "failed" && counts.failed > 0 ? "text-destructive" : ""}`}
            aria-pressed={prefs.state === c.id}
            onclick={() => setState(c.id)}
            data-testid={`svc-chip-${c.id}`}
          >
            {c.label}<span class="tabular-nums text-muted-foreground" data-testid={`svc-count-${c.id}`}>{counts[c.id]}</span>
          </Button>
        {/each}
      </div>
      <Select.Root type="single" value={prefs.enabled} onValueChange={(v) => v && setEnabled(v as EnabledFilter)}>
        <Select.Trigger class="h-7 w-36 text-[12px]" aria-label="Enablement filter" data-testid="svc-enabled-filter">
          {ENABLED.find((x) => x.id === prefs.enabled)?.label}
        </Select.Trigger>
        <Select.Content>
          {#each ENABLED as o (o.id)}
            <Select.Item value={o.id} label={o.label}>{o.label}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <div class="flex gap-1" role="group" aria-label="Scope">
        <Button variant={prefs.user ? "outline" : "secondary"} size="sm" class="h-7 px-2 text-[12px]" aria-pressed={!prefs.user} onclick={() => systemd.setUser(false)} title="System services" data-testid="svc-scope-system">System</Button>
        <Button variant={prefs.user ? "secondary" : "outline"} size="sm" class="h-7 px-2 text-[12px]" aria-pressed={prefs.user} onclick={() => systemd.setUser(true)} title="User services (systemctl --user, U)" data-testid="svc-scope-user">User</Button>
      </div>
      <div class="flex gap-1" role="group" aria-label="View">
        <Button variant={mode === "services" ? "secondary" : "outline"} size="sm" class="h-7 px-2 text-[12px]" onclick={() => (mode = "services")} data-testid="svc-mode-services">Units</Button>
        <Button variant={mode === "timers" ? "secondary" : "outline"} size="sm" class="h-7 px-2 text-[12px]" onclick={() => (mode = "timers")} data-testid="svc-mode-timers">Timers</Button>
      </div>
      {#if mode === "services"}
        <div class="flex gap-1">
          <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-[12px]" disabled={!selected} onclick={() => act("start")} title="Start (s)" data-testid="svc-start"><PlayIcon class="size-3.5" /> <span class="hidden @3xl/mon:inline">Start</span></Button>
          <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-[12px]" disabled={!selected} onclick={() => act("stop")} title="Stop (Shift+S)" data-testid="svc-stop"><SquareIcon class="size-3.5" /> <span class="hidden @3xl/mon:inline">Stop</span></Button>
          <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-[12px]" disabled={!selected} onclick={() => act("restart")} title="Restart (r)" data-testid="svc-restart"><RotateCwIcon class="size-3.5" /> <span class="hidden @3xl/mon:inline">Restart</span></Button>
          <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-[12px]" disabled={!selected} onclick={() => (detailsOpen = !detailsOpen)} aria-pressed={detailsOpen} title="Details (Enter)" data-testid="svc-details-toggle"><InfoIcon class="size-3.5" /> <span class="hidden @3xl/mon:inline">Details</span></Button>
        </div>
      {/if}
      <Button variant="ghost" size="sm" class="h-7 px-2 text-[12px]" title="systemctl daemon-reload" onclick={() => void systemd.act(sessionId, "daemon-reload", undefined)} data-testid="svc-daemon-reload">
        <span class="hidden @2xl/mon:inline">daemon-reload</span><span class="@2xl/mon:hidden">reload</span>
      </Button>
      <Button variant="ghost" size="icon" class="size-7" title="Refresh (F5)" onclick={() => void systemd.refresh(sessionId)} data-testid="svc-refresh">
        <RefreshIcon class={`size-3.5 ${ld?.loading ? "animate-spin" : ""}`} />
      </Button>
      <span class="ml-auto text-[11px] text-muted-foreground" data-testid="svc-count">{rows.length} of {allRows.length} units</span>
    </div>

    {#if ld?.error}
      <div class="mx-4 mt-2 flex flex-none items-center gap-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[12px] text-destructive" data-testid="svc-list-error">
        <AlertTriangleIcon class="size-3.5 flex-none" />
        <span class="min-w-0 flex-1 truncate" title={ld.error}>{ld.gone ? "Session disconnected. " : ""}{ld.error}</span>
        {#if !ld.gone}<Button variant="outline" size="sm" class="h-6 px-2 text-[11px]" onclick={() => void systemd.refresh(sessionId)}>Retry</Button>{/if}
      </div>
    {/if}

    {#if mode === "timers"}
      <TimersView
        {sessionId}
        {query}
        onOpen={(u) => {
          mode = "services";
          navigate(u);
        }}
      />
    {:else}
      <div class="flex min-h-[260px] flex-1 flex-col @4xl/mon:min-h-0 @4xl/mon:flex-row">
        <section class="flex min-h-[220px] min-w-0 flex-1 flex-col px-4 pb-2 pt-2">
          {#if !ld || (ld.loading && ld.rows.length === 0 && !ld.error)}
            <div class="flex flex-1 items-center justify-center"><Loader label="Loading services…" size="lg" /></div>
          {:else}
            <div
              bind:this={tableEl}
              bind:clientWidth={tableW}
              bind:clientHeight={viewH}
              onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
              class="min-h-0 flex-1 overflow-auto rounded-md border border-border"
              data-testid="svc-table"
            >
              <table class="w-full border-collapse text-[11px]">
                <thead class="sticky top-0 z-10 bg-muted">
                  <tr style={`height:${HEAD_H}px`} class="text-left text-muted-foreground">
                    <th class={`w-5 px-1 ${prefs.sortKey === "state" ? "bg-primary/20" : ""}`} onclick={() => setSort("state")} title="Sort by state"></th>
                    <th class={`cursor-pointer select-none whitespace-nowrap px-2 font-semibold hover:text-foreground ${prefs.sortKey === "unit" ? "bg-primary/20 text-foreground" : ""}`} onclick={() => setSort("unit")} data-col="unit">Unit{arrow("unit")}</th>
                    {#if cols.desc}<th class="px-2 font-semibold">Description</th>{/if}
                    {#if cols.load}<th class="px-2 font-semibold">Load</th>{/if}
                    <th class={`cursor-pointer select-none whitespace-nowrap px-2 font-semibold hover:text-foreground ${prefs.sortKey === "state" ? "bg-primary/20 text-foreground" : ""}`} onclick={() => setSort("state")} data-col="state">Active{arrow("state")}</th>
                    {#if cols.sub}<th class="px-2 font-semibold">Sub</th>{/if}
                    {#if cols.enabled}<th class={`cursor-pointer select-none whitespace-nowrap px-2 font-semibold hover:text-foreground ${prefs.sortKey === "enabled" ? "bg-primary/20 text-foreground" : ""}`} onclick={() => setSort("enabled")} data-col="enabled">Enabled{arrow("enabled")}</th>{/if}
                    {#if cols.mem}<th class={`cursor-pointer select-none whitespace-nowrap px-2 text-right font-semibold hover:text-foreground ${prefs.sortKey === "memory" ? "bg-primary/20 text-foreground" : ""}`} onclick={() => setSort("memory")} data-col="memory">Mem{arrow("memory")}</th>{/if}
                    {#if cols.cpu}<th class={`cursor-pointer select-none whitespace-nowrap px-2 text-right font-semibold hover:text-foreground ${prefs.sortKey === "cpu" ? "bg-primary/20 text-foreground" : ""}`} onclick={() => setSort("cpu")} data-col="cpu">CPU%{arrow("cpu")}</th>{/if}
                  </tr>
                </thead>
                <tbody>
                  {#if winStart > 0}
                    <tr aria-hidden="true" style={`height:${winStart * ROW_H}px`}><td colspan={colCount}></td></tr>
                  {/if}
                  {#each visible as r (r.unit)}
                    <tr
                      data-testid="svc-row"
                      data-unit={r.unit}
                      data-active={r.active}
                      data-failed={isFailed(r) ? "1" : undefined}
                      data-selected={selectedUnit === r.unit ? "1" : undefined}
                      style={`height:${ROW_H}px`}
                      class={`cursor-default ${selectedUnit === r.unit ? "bg-primary/25" : isFailed(r) ? "bg-destructive/10 hover:bg-destructive/20" : "hover:bg-accent/60"}`}
                      onclick={() => select(r.unit, false)}
                      ondblclick={() => open(r.unit)}
                    >
                      <td class="px-1.5"><span class={`block size-2 rounded-full ${dotClass(r)}`} data-testid="svc-dot"></span></td>
                      <td class="max-w-0 truncate px-2 font-mono" title={r.unit}>{r.unit}</td>
                      {#if cols.desc}<td class="max-w-0 truncate px-2 text-muted-foreground" title={r.description}>{r.description}</td>{/if}
                      {#if cols.load}<td class={`px-2 ${r.load === "loaded" ? "text-muted-foreground" : "text-warning"}`}>{r.load}</td>{/if}
                      <td class={`px-2 ${activeClass(r)}`}>{r.active}</td>
                      {#if cols.sub}<td class={`px-2 ${isFailed(r) ? "text-destructive" : "text-muted-foreground"}`}>{r.sub}</td>{/if}
                      {#if cols.enabled}<td class={`px-2 ${enabledClass(r)}`} data-testid="svc-enabled">{r.enabled || "—"}</td>{/if}
                      {#if cols.mem}<td class="px-2 text-right tabular-nums">{fmtMem(r.memory)}</td>{/if}
                      {#if cols.cpu}<td class="px-2 text-right tabular-nums">{fmtCpu(r.cpuPct)}</td>{/if}
                    </tr>
                  {:else}
                    <tr><td colspan={colCount} class="px-2 py-8 text-center text-muted-foreground" data-testid="svc-none">
                      {allRows.length === 0 ? "No services found." : "No services match the filter."}
                    </td></tr>
                  {/each}
                  {#if winEnd < rows.length}
                    <tr aria-hidden="true" style={`height:${(rows.length - winEnd) * ROW_H}px`}><td colspan={colCount}></td></tr>
                  {/if}
                </tbody>
              </table>
            </div>
            <div class="mt-1 flex-none truncate text-[10px] text-muted-foreground">
              ↑↓ PgUp PgDn select · / filter · Enter details · s start · S stop · r restart · R reload · e enable · d disable · j journal · f failed · u user
            </div>
          {/if}
        </section>

        {#if detailsOpen && selected && sessionId}
          <div class="flex h-72 min-h-0 flex-none flex-col border-t border-border @4xl/mon:h-auto @4xl/mon:w-[26rem] @4xl/mon:border-l @4xl/mon:border-t-0 @6xl/mon:w-[32rem]">
            <ServiceDetails
              {sessionId}
              row={selected}
              user={prefs.user}
              {canSudo}
              bind:tab={dtab}
              onClose={() => {
                detailsOpen = false;
                rootEl?.focus();
              }}
              onNavigate={navigate}
            />
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<SudoDialog />
