<script lang="ts">
  // The "htop" Dashboard tab (§14.4.H): meters header, sortable/filterable process
  // table (flat or tree), keyboard control, tagging, kill/nice, detail drawer.
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { app } from "../../lib/stores.svelte";
  import { monitor, fmtShort, fmtCpuTime } from "../../lib/monitor.svelte";
  import type { MonProc } from "../../lib/types";
  import { COLUMNS, SIGNALS, buildRows, descendants, fmtStart, userList, type SortKey } from "./htop";
  import { htopPrefs as prefs } from "./htopPrefs.svelte";
  import HtopMeters from "./HtopMeters.svelte";
  import ProcDetails from "./ProcDetails.svelte";
  import Loader from "../Loader.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import SkullIcon from "@lucide/svelte/icons/skull";
  import ListTreeIcon from "@lucide/svelte/icons/list-tree";
  import SearchIcon from "@lucide/svelte/icons/search";
  import ColumnsIcon from "@lucide/svelte/icons/columns-3";
  import CrosshairIcon from "@lucide/svelte/icons/crosshair";
  import InfoIcon from "@lucide/svelte/icons/info";
  import GaugeIcon from "@lucide/svelte/icons/gauge";

  const ROW_H = 20;
  const HEAD_H = 24;
  const OVERSCAN = 12;

  const snap = $derived(monitor.viewSnapshot);
  const sessionId = $derived(monitor.selectedId);

  let filter = $state("");
  let userFilter = $state("");
  let follow = $state(false);
  let detailsOpen = $state(false);
  let selectedPid = $state<number | null>(null);
  let signalOpen = $state(false);
  let rootEl = $state<HTMLDivElement | null>(null);
  let filterEl = $state<HTMLInputElement | null>(null);
  let tableEl = $state<HTMLDivElement | null>(null);
  let tableW = $state(0);
  let viewH = $state(0);
  let scrollTop = $state(0);
  const tagged = new SvelteSet<number>();
  const collapsed = new SvelteSet<number>();
  let fresh = $state<Set<number>>(new Set());
  let lastIdx = 0;
  let prevPids = new Set<number>();

  // Threads are only streamed while this tab is open.
  $effect(() => {
    monitor.setShowThreads(prefs.threads);
    return () => monitor.setShowThreads(false);
  });
  // Keyboard focus lives on the root so arrows work right after switching tabs.
  $effect(() => {
    rootEl?.focus({ preventScroll: true });
  });
  // Switching VM clears per-VM state.
  $effect(() => {
    void sessionId;
    untrack(() => {
      selectedPid = null;
      tagged.clear();
      collapsed.clear();
      prevPids = new Set();
      fresh = new Set();
    });
  });

  const procs = $derived(snap?.procs ?? []);
  const rows = $derived(
    buildRows(procs, {
      sortKey: prefs.sortKey,
      desc: prefs.desc,
      filter,
      user: userFilter,
      hideKernel: prefs.hideKernel,
      showThreads: prefs.threads,
      tree: prefs.tree,
      collapsed,
    }),
  );
  const users = $derived(userList(procs));
  const cols = $derived(
    COLUMNS.filter((c) => prefs.columns.includes(c.key) && (!c.hideBelow || tableW === 0 || tableW >= c.hideBelow)),
  );
  const selected = $derived(procs.find((p) => p.pid === selectedPid) ?? null);
  const targets = $derived(tagged.size > 0 ? [...tagged] : selected ? [selected.pid] : []);

  const winStart = $derived(Math.max(0, Math.floor((scrollTop - HEAD_H) / ROW_H) - OVERSCAN));
  const winEnd = $derived(Math.min(rows.length, Math.ceil((scrollTop + (viewH || 800)) / ROW_H) + OVERSCAN));
  const visible = $derived(rows.slice(winStart, winEnd));

  // Per snapshot: flag new processes, drop dead tags, re-home a vanished selection.
  $effect(() => {
    const s = snap;
    if (!s) return;
    untrack(() => {
      const cur = new Set(s.procs.map((p) => p.pid));
      if (prevPids.size) {
        const f = new Set<number>();
        for (const pid of cur) if (!prevPids.has(pid)) f.add(pid);
        fresh = f;
      }
      prevPids = cur;
      for (const pid of [...tagged]) if (!cur.has(pid)) tagged.delete(pid);
      for (const pid of [...collapsed]) if (!cur.has(pid)) collapsed.delete(pid);
      const i = rows.findIndex((r) => r.p.pid === selectedPid);
      if (i >= 0) lastIdx = i;
      else if (selectedPid !== null && !cur.has(selectedPid)) {
        selectedPid = rows[Math.min(lastIdx, rows.length - 1)]?.p.pid ?? null;
      }
    });
  });
  // `F` follow: keep the selected process in view across refreshes and re-sorts.
  $effect(() => {
    void rows;
    if (!follow) return;
    untrack(() => {
      const i = rows.findIndex((r) => r.p.pid === selectedPid);
      if (i >= 0) ensureVisible(i);
    });
  });

  function ensureVisible(i: number) {
    const el = tableEl;
    if (!el) return;
    const y = i * ROW_H;
    const h = el.clientHeight - HEAD_H;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW_H > el.scrollTop + h) el.scrollTop = y + ROW_H - h;
  }

  function select(pid: number | null, scroll = true) {
    selectedPid = pid;
    if (pid === null || !scroll) return;
    const i = rows.findIndex((r) => r.p.pid === pid);
    if (i >= 0) {
      lastIdx = i;
      ensureVisible(i);
    }
  }

  function move(delta: number, abs = false) {
    if (rows.length === 0) return;
    const idx = rows.findIndex((r) => r.p.pid === selectedPid);
    const next = abs ? (delta < 0 ? 0 : rows.length - 1) : idx === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, idx + delta));
    select(rows[next].p.pid);
  }

  function setSort(key: SortKey) {
    if (prefs.sortKey === key) prefs.desc = !prefs.desc;
    else {
      prefs.sortKey = key;
      prefs.desc = COLUMNS.find((c) => c.key === key)?.desc ?? true;
    }
    prefs.save();
  }
  function sortBy(key: SortKey) {
    if (prefs.sortKey === key) return;
    prefs.sortKey = key;
    prefs.desc = COLUMNS.find((c) => c.key === key)?.desc ?? true;
    prefs.save();
  }
  function cycleSort() {
    const order: SortKey[] = ["cpu", "mem", "time", "pid"];
    sortBy(order[(order.indexOf(prefs.sortKey) + 1) % order.length]);
  }

  function toggle(k: "tree" | "hideKernel" | "threads" | "meters") {
    prefs[k] = !prefs[k];
    prefs.save();
  }

  function toggleTag(pid: number) {
    if (tagged.has(pid)) tagged.delete(pid);
    else tagged.add(pid);
  }
  function tagChildren(pid: number) {
    tagged.add(pid);
    for (const c of descendants(procs, pid)) tagged.add(c);
  }
  function collapseToggle(pid: number, to?: boolean) {
    const want = to ?? !collapsed.has(pid);
    if (want) collapsed.add(pid);
    else collapsed.delete(pid);
  }

  async function sendSignal(name: string) {
    signalOpen = false;
    const pids = targets;
    if (pids.length === 0) return;
    const one = pids.length === 1 ? procs.find((p) => p.pid === pids[0]) : undefined;
    const names = pids
      .slice(0, 6)
      .map((pid) => `${pid} ${procs.find((p) => p.pid === pid)?.command ?? ""}`.trim())
      .join(", ");
    const ok = await app.ask({
      title: one ? `Send SIG${name} to ${one.command} (PID ${one.pid})?` : `Send SIG${name} to ${pids.length} processes?`,
      message: one ? one.args : `${names}${pids.length > 6 ? ", …" : ""}`,
      confirmLabel: `Send SIG${name}`,
      danger: true,
    });
    if (!ok) return;
    if (pids.length === 1) await monitor.kill(pids[0], name);
    else if (await monitor.killMany(pids, name)) tagged.clear();
  }

  async function nice(delta: number) {
    for (const pid of targets) {
      const p = procs.find((x) => x.pid === pid);
      if (!p) continue;
      const next = Math.max(-20, Math.min(19, p.ni + delta));
      if (next === p.ni) continue;
      if (!(await monitor.renice(pid, next))) break;
    }
  }

  function openKill() {
    if (targets.length) signalOpen = true;
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement || t.closest("[role=dialog], [role=menu], [role=listbox]")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const sel = selected;
    const row = rows.find((r) => r.p.pid === selectedPid);
    switch (e.key) {
      case "ArrowDown": move(1); break;
      case "ArrowUp": move(-1); break;
      case "PageDown": move(Math.max(1, Math.floor((viewH - HEAD_H) / ROW_H) - 1)); break;
      case "PageUp": move(-Math.max(1, Math.floor((viewH - HEAD_H) / ROW_H) - 1)); break;
      case "Home": move(-1, true); break;
      case "End": move(1, true); break;
      case "ArrowRight":
        if (prefs.tree && row?.hasKids) collapseToggle(row.p.pid, false);
        break;
      case "ArrowLeft":
        if (prefs.tree && row) {
          if (row.hasKids && !row.collapsed) collapseToggle(row.p.pid, true);
          else if (row.depth > 0) {
            const parent = rows.slice(0, rows.indexOf(row)).reverse().find((r) => r.depth < row.depth);
            if (parent) select(parent.p.pid);
          }
        }
        break;
      case "+": if (row?.hasKids) collapseToggle(row.p.pid, false); break;
      case "-": if (row?.hasKids) collapseToggle(row.p.pid, true); break;
      case "*": {
        const parents = rows.filter((r) => r.hasKids).map((r) => r.p.pid);
        if (parents.some((pid) => !collapsed.has(pid))) for (const pid of parents) collapsed.add(pid);
        else collapsed.clear();
        break;
      }
      case "F9":
      case "Delete":
      case "k": openKill(); break;
      case "F7":
      case "]": void nice(-1); break; // htop: ] lowers the nice value
      case "F8":
      case "[": void nice(1); break;
      case "/":
      case "F3":
      case "F4": filterEl?.focus(); filterEl?.select(); break;
      case "F5":
      case "t": toggle("tree"); break;
      case "F6": cycleSort(); break;
      case "P": sortBy("cpu"); break;
      case "M": sortBy("mem"); break;
      case "T": sortBy("time"); break;
      case "N": sortBy("pid"); break;
      case "I": prefs.desc = !prefs.desc; prefs.save(); break;
      case "K": toggle("hideKernel"); break;
      case "H": toggle("threads"); break;
      case "F": follow = !follow; break;
      case "p": monitor.setPaused(!monitor.paused); break;
      case "u": userFilter = ""; break;
      case " ":
        if (sel) {
          toggleTag(sel.pid);
          move(1);
        }
        break;
      case "c": if (sel) tagChildren(sel.pid); break;
      case "U": tagged.clear(); break;
      case "Enter":
      case "i": if (sel) detailsOpen = !detailsOpen; break;
      case "Escape":
        if (detailsOpen) detailsOpen = false;
        else if (tagged.size) tagged.clear();
        else if (filter || userFilter) {
          filter = "";
          userFilter = "";
        } else return;
        break;
      default: return;
    }
    e.preventDefault();
  }

  function sigKey(e: KeyboardEvent) {
    const el = e.currentTarget as HTMLElement;
    const btns = [...el.querySelectorAll<HTMLButtonElement>("button[data-sig]")];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") btns[(i + 1) % btns.length]?.focus();
    else if (e.key === "ArrowUp") btns[(i - 1 + btns.length) % btns.length]?.focus();
    else return;
    e.preventDefault();
  }

  const cpuClass = (v: number) => (v >= 50 ? "text-destructive" : v >= 10 ? "text-warning" : "");
  const stateClass = (s: string) =>
    s === "R" ? "font-bold text-success" : s === "Z" ? "text-destructive" : s === "D" ? "text-warning" : "text-muted-foreground";
  const dialogTitle = $derived(
    targets.length > 1
      ? `${targets.length} tagged processes`
      : selected
        ? `${selected.command} (PID ${selected.pid})`
        : "",
  );
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  bind:this={rootEl}
  class="flex min-h-0 flex-1 flex-col overflow-y-auto outline-none"
  tabindex="0"
  role="region"
  aria-label="htop process manager"
  onkeydown={onKey}
  data-testid="htop-view"
>
  {#if !snap}
    <div class="flex flex-1 items-center justify-center">
      {#if sessionId && monitor.errors[sessionId]}
        <p class="text-sm text-destructive">{monitor.errors[sessionId]}</p>
      {:else}
        <Loader label="Collecting stats…" size="lg" />
      {/if}
    </div>
  {:else}
    {#if prefs.meters}<HtopMeters {snap} />{/if}

    <!-- Toolbar -->
    <div class="flex flex-none flex-wrap items-center gap-1.5 px-4 pt-2" data-testid="htop-toolbar">
      <div class="relative">
        <SearchIcon class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          bind:ref={filterEl}
          bind:value={filter}
          placeholder="Filter ( / )  a|b"
          class="h-7 w-44 pl-7 text-[12px] @2xl/mon:w-56"
          data-testid="proc-filter"
          onkeydown={(e: KeyboardEvent) => {
            if (e.key === "Escape") {
              filter = "";
              rootEl?.focus();
              e.stopPropagation();
            } else if (e.key === "Enter" || e.key === "ArrowDown") {
              rootEl?.focus();
              if (e.key === "ArrowDown") move(rows.length && selectedPid === null ? 0 : 1);
              e.preventDefault();
            }
          }}
        />
      </div>
      <Select.Root type="single" value={userFilter || "__all__"} onValueChange={(v) => (userFilter = v === "__all__" ? "" : v)}>
        <Select.Trigger class="h-7 w-28 text-[12px]" aria-label="User filter" data-testid="proc-user">{userFilter || "All users"}</Select.Trigger>
        <Select.Content>
          <Select.Item value="__all__" label="All users">All users</Select.Item>
          {#each users as u (u)}
            <Select.Item value={u} label={u}>{u}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <Button variant={prefs.tree ? "secondary" : "outline"} size="sm" class="h-7 gap-1 px-2 text-[12px]" onclick={() => toggle("tree")} aria-pressed={prefs.tree} title="Tree view (T / F5)" data-testid="proc-tree">
        <ListTreeIcon class="size-3.5" /> <span class="hidden @xl/mon:inline">Tree</span>
      </Button>
      <Button variant={prefs.hideKernel ? "secondary" : "outline"} size="sm" class="h-7 px-2 text-[12px]" onclick={() => toggle("hideKernel")} aria-pressed={prefs.hideKernel} title="Hide kernel threads (K)" data-testid="proc-hide-kernel">
        <span class="@xl/mon:hidden">Kern</span><span class="hidden @xl/mon:inline">Hide kernel</span>
      </Button>
      <Button variant={prefs.threads ? "secondary" : "outline"} size="sm" class="h-7 px-2 text-[12px]" onclick={() => toggle("threads")} aria-pressed={prefs.threads} title="Show threads (H)" data-testid="proc-threads">
        Threads
      </Button>
      <Button variant={follow ? "secondary" : "outline"} size="sm" class="h-7 gap-1 px-2 text-[12px]" onclick={() => (follow = !follow)} aria-pressed={follow} title="Follow the selected process (F)" data-testid="proc-follow">
        <CrosshairIcon class="size-3.5" /> <span class="hidden @2xl/mon:inline">Follow</span>
      </Button>
      <Button variant={prefs.meters ? "outline" : "secondary"} size="sm" class="h-7 gap-1 px-2 text-[12px]" onclick={() => toggle("meters")} aria-pressed={prefs.meters} title="Show / hide the CPU and memory meters" data-testid="proc-meters-toggle">
        <GaugeIcon class="size-3.5" />
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="outline" size="sm" class="h-7 gap-1 px-2 text-[12px]" title="Choose columns" data-testid="proc-columns">
              <ColumnsIcon class="size-3.5" /> <span class="hidden @2xl/mon:inline">Columns</span>
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="start" class="w-44">
          {#each COLUMNS.filter((c) => c.key !== "command") as c (c.key)}
            <DropdownMenu.CheckboxItem
              closeOnSelect={false}
              checked={prefs.columns.includes(c.key)}
              onCheckedChange={() => prefs.toggleColumn(c.key)}
              data-testid={`proc-col-${c.key}`}
            >
              <span class="font-mono text-[11px]">{c.label}</span>
              <span class="ml-2 truncate text-[10px] text-muted-foreground">{c.title.split(" (")[0]}</span>
            </DropdownMenu.CheckboxItem>
          {/each}
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={() => prefs.resetColumns()}>Reset columns</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-[12px]" disabled={!selected} onclick={() => (detailsOpen = !detailsOpen)} aria-pressed={detailsOpen} title="Process details (Enter / I)" data-testid="proc-details-toggle">
        <InfoIcon class="size-3.5" /> <span class="hidden @2xl/mon:inline">Details</span>
      </Button>
      <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-[12px] text-destructive" disabled={targets.length === 0} onclick={openKill} title="Send a signal (F9 / Del)" data-testid="proc-kill">
        <SkullIcon class="size-3.5" /> <span class="hidden @xl/mon:inline">Kill</span>{#if tagged.size > 0}<span data-testid="proc-tagged">({tagged.size})</span>{/if}
      </Button>
      <span class="ml-auto text-[11px] text-muted-foreground" data-testid="proc-count">{rows.length} of {prefs.threads ? procs.length : procs.filter((p) => !p.thread).length} processes</span>
    </div>

    <div class="flex min-h-[260px] flex-1 flex-col @4xl/mon:min-h-0 @4xl/mon:flex-row">
      <section class="flex min-h-[220px] min-w-0 flex-1 flex-col px-4 pb-2 pt-2">
        <div
          bind:this={tableEl}
          bind:clientWidth={tableW}
          bind:clientHeight={viewH}
          onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
          class="min-h-0 flex-1 overflow-auto rounded-md border border-border"
          data-testid="proc-table"
        >
          <table class="w-full border-collapse font-mono text-[11px]">
            <thead class="sticky top-0 z-10 bg-muted">
              <tr style={`height:${HEAD_H}px`}>
                {#each cols as c (c.key)}
                  <th
                    class={`${c.w} cursor-pointer select-none whitespace-nowrap px-2 py-0 font-semibold text-muted-foreground hover:text-foreground ${c.align === "r" ? "text-right" : "text-left"} ${prefs.sortKey === c.key ? "bg-primary/20 text-foreground" : ""}`}
                    onclick={() => setSort(c.key)}
                    title={c.title}
                    aria-sort={prefs.sortKey === c.key ? (prefs.desc ? "descending" : "ascending") : "none"}
                    data-col={c.key}
                  >
                    {c.label}{prefs.sortKey === c.key ? (prefs.desc ? " ▼" : " ▲") : ""}
                  </th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#if winStart > 0}
                <tr aria-hidden="true" style={`height:${winStart * ROW_H}px`}><td colspan={cols.length}></td></tr>
              {/if}
              {#each visible as r (r.p.pid)}
                {@const p = r.p}
                <tr
                  data-testid="proc-row"
                  data-pid={p.pid}
                  data-tagged={tagged.has(p.pid) ? "1" : undefined}
                  data-selected={selectedPid === p.pid ? "1" : undefined}
                  style={`height:${ROW_H}px`}
                  class={`cursor-default ${selectedPid === p.pid ? "bg-primary/25" : tagged.has(p.pid) ? "bg-warning/20" : fresh.has(p.pid) ? "bg-success/15" : "hover:bg-accent/60"}`}
                  onclick={(e) => {
                    if (e.ctrlKey || e.metaKey) toggleTag(p.pid);
                    select(p.pid, false);
                  }}
                  ondblclick={() => {
                    select(p.pid, false);
                    detailsOpen = true;
                  }}
                >
                  {#each cols as c (c.key)}
                    {#if c.key === "pid"}
                      <td class="px-2 text-right tabular-nums">{p.pid}</td>
                    {:else if c.key === "ppid"}
                      <td class="px-2 text-right tabular-nums text-muted-foreground">{p.ppid}</td>
                    {:else if c.key === "user"}
                      <td class="max-w-24 truncate px-2 text-chart-1">{p.user}</td>
                    {:else if c.key === "pri"}
                      <td class="px-2 text-right tabular-nums">{p.pri}</td>
                    {:else if c.key === "ni"}
                      <td class={`px-2 text-right tabular-nums ${p.ni < 0 ? "text-destructive" : p.ni > 0 ? "text-chart-1" : ""}`}>{p.ni}</td>
                    {:else if c.key === "virt"}
                      <td class="px-2 text-right tabular-nums">{fmtShort(p.virt)}</td>
                    {:else if c.key === "res"}
                      <td class="px-2 text-right tabular-nums">{fmtShort(p.res)}</td>
                    {:else if c.key === "shr"}
                      <td class="px-2 text-right tabular-nums">{fmtShort(p.shr)}</td>
                    {:else if c.key === "state"}
                      <td class={`px-2 ${stateClass(p.state)}`}>{p.state}</td>
                    {:else if c.key === "cpu"}
                      <td class={`px-2 text-right tabular-nums ${cpuClass(p.cpu)}`}>{p.cpu.toFixed(1)}</td>
                    {:else if c.key === "mem"}
                      <td class="px-2 text-right tabular-nums">{p.mem.toFixed(1)}</td>
                    {:else if c.key === "time"}
                      <td class="px-2 text-right tabular-nums">{fmtCpuTime(p.time)}</td>
                    {:else if c.key === "threads"}
                      <td class="px-2 text-right tabular-nums">{p.threads}</td>
                    {:else if c.key === "start"}
                      <td class="px-2 text-right tabular-nums">{fmtStart(p.start, snap.ts)}</td>
                    {:else}
                      <td class="max-w-0 truncate px-2" title={p.args}>
                        {#if prefs.tree}<span class="whitespace-pre text-muted-foreground">{r.guide}</span>{#if r.hasKids}<button
                              type="button"
                              class="mr-1 text-muted-foreground hover:text-foreground"
                              tabindex="-1"
                              aria-label={r.collapsed ? "Expand" : "Collapse"}
                              data-testid="proc-toggle"
                              onclick={(e) => {
                                e.stopPropagation();
                                collapseToggle(p.pid);
                              }}>{r.collapsed ? "▸" : "▾"}</button>{/if}{/if}<span class={p.thread ? "text-chart-4" : p.kernel ? "text-muted-foreground" : "text-foreground"}>{p.thread ? p.command : p.args}</span>
                      </td>
                    {/if}
                  {/each}
                </tr>
              {/each}
              {#if winEnd < rows.length}
                <tr aria-hidden="true" style={`height:${(rows.length - winEnd) * ROW_H}px`}><td colspan={cols.length}></td></tr>
              {/if}
            </tbody>
          </table>
        </div>
        <div class="mt-1 flex-none truncate text-[10px] text-muted-foreground">
          ↑↓ PgUp PgDn select · F9 kill · F7/F8 nice · / filter · T tree (←→ fold) · Space tag · F follow · Enter details · P M T N sort · K kernel · H threads
        </div>
      </section>

      {#if detailsOpen && selected}
        <div class="flex h-64 min-h-0 flex-none flex-col border-t border-border @4xl/mon:h-auto @4xl/mon:w-80 @4xl/mon:border-l @4xl/mon:border-t-0 @6xl/mon:w-96">
          <ProcDetails
            proc={selected}
            {procs}
            ts={snap.ts}
            paused={monitor.paused}
            onSelect={(pid) => {
              select(pid);
              rootEl?.focus();
            }}
            onKill={openKill}
            onNice={(d) => void nice(d)}
            onClose={() => {
              detailsOpen = false;
              rootEl?.focus();
            }}
          />
        </div>
      {/if}
    </div>
  {/if}
</div>

<Dialog.Root bind:open={signalOpen}>
  <Dialog.Content class="max-w-sm" data-testid="signal-dialog">
    <Dialog.Header>
      <Dialog.Title>Send signal</Dialog.Title>
      <Dialog.Description class="truncate">{dialogTitle}</Dialog.Description>
    </Dialog.Header>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="flex flex-col gap-1" onkeydown={sigKey}>
      {#each SIGNALS as s, i}
        <button
          type="button"
          data-sig={s.name}
          class="flex items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-accent focus:bg-accent focus:outline-none"
          onclick={() => sendSignal(s.name)}
          {@attach (el: HTMLElement) => {
            if (i === 0) queueMicrotask(() => el.focus());
          }}
        >
          <span class="w-6 text-right font-mono text-muted-foreground">{s.n}</span>
          <span class="w-14 font-mono font-semibold">SIG{s.name}</span>
          <span class="text-muted-foreground">{s.hint}</span>
        </button>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>
