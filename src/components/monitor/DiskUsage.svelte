<script lang="ts">
  // ncdu-like disk usage explorer (docs/GUIDE.md §13.4.C): `du` over an exec
  // channel, squarified treemap + sortable list, lazy drill-down.
  import { app } from "../../lib/stores.svelte";
  import * as api from "../../lib/api";
  import { diskUsage, DU_DEPTHS, fmtKb, type DuSession } from "../../lib/diskusage.svelte";
  import { squarify } from "../../lib/treemap";
  import { basename } from "../../lib/paths";
  import { fmtShort } from "../../lib/monitor.svelte";
  import type { MonDisk } from "../../lib/types";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import Loader from "../Loader.svelte";
  import FolderIcon from "@lucide/svelte/icons/folder";
  import FileIcon from "@lucide/svelte/icons/file";
  import ScanIcon from "@lucide/svelte/icons/hard-drive";
  import XIcon from "@lucide/svelte/icons/x";
  import RefreshIcon from "@lucide/svelte/icons/refresh-cw";
  import TrashIcon from "@lucide/svelte/icons/trash-2";
  import FolderOpenIcon from "@lucide/svelte/icons/folder-open";
  import ShieldAlertIcon from "@lucide/svelte/icons/shield-alert";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";

  let { sessionId, home, disks }: { sessionId: string; home: string; disks: MonDisk[] } = $props();

  const FILES = "\u0000files";

  let du = $state<DuSession | null>(null);
  $effect(() => {
    du = diskUsage.ensure(sessionId, home);
  });

  let sortKey = $state<"size" | "name">("size");
  let sortDesc = $state(true);
  let hover = $state<{ path: string; x: number; y: number } | null>(null);
  let boxW = $state(0);
  let boxH = $state(0);

  const cwd = $derived(du?.cwd ?? null);
  const total = $derived(cwd && du ? du.size(cwd) : 0);
  const kids = $derived(cwd && du ? du.children(cwd) : []);
  const filesKb = $derived(Math.max(0, total - kids.reduce((s, k) => s + k.kb, 0)));

  interface Row {
    path: string;
    name: string;
    kb: number;
    dir: boolean;
  }

  const rows = $derived.by((): Row[] => {
    const list: Row[] = kids.map((k) => ({ path: k.path, name: basename(k.path), kb: k.kb, dir: true }));
    if (filesKb > 0) list.push({ path: FILES, name: "(files in this directory)", kb: filesKb, dir: false });
    const dir = sortDesc ? -1 : 1;
    return list.sort((a, b) => (sortKey === "size" ? a.kb - b.kb : a.name.localeCompare(b.name)) * dir || a.name.localeCompare(b.name));
  });
  const maxKb = $derived(rows.reduce((m, r) => Math.max(m, r.kb), 0));
  const pct = (kb: number) => (total ? (kb * 100) / total : 0);

  interface Tile {
    key: string;
    path: string;
    level: 0 | 1;
    x: number;
    y: number;
    w: number;
    h: number;
    kb: number;
    color: string;
    label: string;
    dir: boolean;
  }

  const color = (idx: number, share: number, level: 0 | 1, isDir: boolean) => {
    if (!isDir) return "color-mix(in oklab, var(--muted-foreground) 25%, var(--card))";
    const base = `var(--chart-${(idx % 5) + 1})`;
    const mix = Math.round((level === 0 ? 38 : 24) + 42 * Math.sqrt(Math.min(1, share)));
    return `color-mix(in oklab, ${base} ${mix}%, var(--card))`;
  };

  const tiles = $derived.by((): Tile[] => {
    if (!du || !cwd || total <= 0 || boxW < 20 || boxH < 20) return [];
    const items = rows.map((r) => ({ id: r.path, value: r.kb }));
    const out: Tile[] = [];
    const lay = squarify(items, { x: 0, y: 0, w: boxW, h: boxH });
    lay.forEach((r, i) => {
      const row = rows.find((x) => x.path === r.id)!;
      const idx = kids.findIndex((k) => k.path === r.id);
      out.push({
        key: r.id,
        path: r.id,
        level: 0,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        kb: r.value,
        color: color(idx < 0 ? i : idx, r.value / total, 0, row.dir),
        label: row.name,
        dir: row.dir,
      });
      if (!row.dir || r.w < 110 || r.h < 70) return;
      const sub = du!.children(r.id);
      if (!sub.length) return;
      const subFiles = Math.max(0, r.value - sub.reduce((s, k) => s + k.kb, 0));
      const subItems = sub.map((k) => ({ id: k.path, value: k.kb }));
      if (subFiles > 0) subItems.push({ id: r.id + FILES, value: subFiles });
      const inner = { x: r.x + 3, y: r.y + 18, w: r.w - 6, h: r.h - 21 };
      if (inner.w < 20 || inner.h < 12) return;
      squarify(subItems, inner).forEach((s, j) => {
        const isFiles = s.id.endsWith(FILES);
        out.push({
          key: s.id,
          path: s.id,
          level: 1,
          x: s.x,
          y: s.y,
          w: s.w,
          h: s.h,
          kb: s.value,
          color: color(idx + j + 1, s.value / r.value, 1, !isFiles),
          label: isFiles ? "(files)" : basename(s.id),
          dir: !isFiles,
        });
      });
    });
    return out;
  });

  const crumbs = $derived.by(() => {
    if (!cwd) return [] as { name: string; path: string }[];
    const segs = cwd.split("/").filter(Boolean);
    const c = [{ name: "/", path: "/" }];
    segs.forEach((s, i) => c.push({ name: s, path: "/" + segs.slice(0, i + 1).join("/") }));
    return c;
  });

  const hoverInfo = $derived.by(() => {
    if (!hover) return null;
    const p = hover.path;
    const isFiles = p.endsWith(FILES);
    const real = isFiles ? p.slice(0, -FILES.length) || cwd! : p;
    const kb = tiles.find((t) => t.path === p)?.kb ?? rows.find((r) => r.path === p)?.kb ?? 0;
    return { title: isFiles ? `${real} (files)` : p, kb, pct: pct(kb) };
  });

  function setSort(k: "size" | "name") {
    if (sortKey === k) sortDesc = !sortDesc;
    else {
      sortKey = k;
      sortDesc = k === "size";
    }
  }

  function drill(path: string) {
    if (!du || path.endsWith(FILES)) return;
    void du.navigate(path);
  }

  function move(e: MouseEvent, path: string) {
    const el = (e.currentTarget as HTMLElement).closest("[data-tm]") as HTMLElement | null;
    const r = el?.getBoundingClientRect();
    hover = { path, x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  }

  function openInExplorer(path: string) {
    void app.navigateExplorer(sessionId, path);
    app.sidebarView = "explorer";
  }

  async function del(row: Row) {
    if (!du || !row.dir) return;
    const ok = await app.ask({
      title: `Delete ${row.name}?`,
      message: `${row.path} (${fmtKb(row.kb)}) and everything inside it will be permanently deleted from the VM.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.remove(sessionId, row.path, true);
      du.removed(row.path);
      app.addToast("success", `Deleted ${row.name}`);
    } catch (e) {
      app.addToast("error", (e as { message?: string }).message ?? String(e));
    }
  }

  const sortMark = (k: string) => (sortKey === k ? (sortDesc ? " ▼" : " ▲") : "");
</script>

<div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3" data-testid="du-view">
  {#if disks.length}
    <div class="flex flex-wrap gap-2" data-testid="du-mounts">
      {#each disks as d (d.mount)}
        <button
          type="button"
          class="min-w-44 rounded-md border border-border bg-card px-2 py-1 text-left hover:bg-accent"
          title={`Scan ${d.mount}`}
          data-testid="du-mount"
          onclick={() => du && void du.scanRoot(d.mount)}
        >
          <div class="flex items-baseline justify-between gap-3 font-mono text-[11px]">
            <span class="truncate font-semibold">{d.mount}</span>
            <span class="tabular-nums text-muted-foreground">{d.percent.toFixed(0)}%</span>
          </div>
          <div class="my-0.5 h-1.5 overflow-hidden rounded-full bg-muted">
            <div class={`h-full ${d.percent > 90 ? "bg-destructive" : d.percent > 75 ? "bg-warning" : "bg-chart-1"}`} style={`width:${Math.min(100, d.percent)}%`}></div>
          </div>
          <div class="truncate text-[10px] text-muted-foreground">{fmtShort(d.used)} of {fmtShort(d.total)} · {d.filesystem}</div>
        </button>
      {/each}
    </div>
  {/if}

  {#if du}
    <div class="flex flex-wrap items-center gap-2">
      <Input
        bind:value={du.rootInput}
        class="h-7 w-72 font-mono text-[12px]"
        placeholder="/ or /home/user"
        aria-label="Scan root"
        data-testid="du-root"
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === "Enter" && du) void du.scanRoot(du.rootInput);
        }}
      />
      <Button variant="outline" size="sm" class="h-7 px-2 text-[12px]" onclick={() => du && void du.scanRoot("/")}>/</Button>
      <Button variant="outline" size="sm" class="h-7 px-2 text-[12px]" onclick={() => du && void du.scanRoot(home || "/")}>~</Button>
      <Select.Root type="single" value={String(du.depth)} onValueChange={(v) => v && du && (du.depth = Number(v))}>
        <Select.Trigger class="h-7 w-24 text-[12px]" aria-label="Scan depth" data-testid="du-depth">depth {du.depth}</Select.Trigger>
        <Select.Content>
          {#each DU_DEPTHS as d}
            <Select.Item value={String(d)} label={`depth ${d}`}>depth {d}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      {#if du.scanning}
        <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-[12px] text-destructive" onclick={() => du && void du.cancel()} data-testid="du-cancel">
          <XIcon class="size-3.5" /> Cancel
        </Button>
      {:else}
        <Button size="sm" class="h-7 gap-1 px-2 text-[12px]" onclick={() => du && void du.scanRoot(du.rootInput)} data-testid="du-scan">
          <ScanIcon class="size-3.5" /> Scan
        </Button>
        {#if du.root}
          <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-[12px]" onclick={() => du && void du.rescan()} title="Re-scan the current directory" data-testid="du-rescan">
            <RefreshIcon class="size-3.5" /> Refresh
          </Button>
        {/if}
      {/if}
      {#if du.denied > 0}
        <span class="flex items-center gap-1 rounded bg-warning/20 px-1.5 py-0.5 text-[11px] text-warning" title="Directories du could not read (run as a user with access to include them)" data-testid="du-denied">
          <ShieldAlertIcon class="size-3" /> {du.denied} permission denied
        </span>
      {/if}
      {#if du.errors > 0}
        <span class="rounded bg-destructive/15 px-1.5 py-0.5 text-[11px] text-destructive" title={du.errorSamples.join("\n")} data-testid="du-errors">{du.errors} other errors</span>
      {/if}
    </div>

    {#if du.scanning}
      <div class="flex items-center gap-2 text-[11px] text-muted-foreground" data-testid="du-progress">
        <Loader label="" size="sm" />
        <span>Scanning {du.scanPath}: {du.entryCount.toLocaleString()} directories</span>
        <span class="min-w-0 flex-1 truncate font-mono opacity-70">{du.lastPath}</span>
      </div>
    {/if}
    {#if du.error}
      <p class="text-[12px] text-destructive" data-testid="du-error">{du.error}</p>
    {/if}

    {#if !du.root}
      <div class="flex flex-1 flex-col items-center justify-center gap-1 py-16 text-muted-foreground">
        <ScanIcon class="size-8 opacity-60" />
        <p class="text-sm font-medium text-foreground">Find what is using disk space</p>
        <p class="text-[12px]">Pick a folder and press Scan. Runs <code class="font-mono">du</code> on the VM, nothing is installed.</p>
      </div>
    {:else}
      <nav class="flex flex-wrap items-center gap-0.5 text-[12px]" aria-label="Path" data-testid="du-crumbs">
        {#each crumbs as c, i (c.path)}
          {#if i > 0}<ChevronRightIcon class="size-3 text-muted-foreground" />{/if}
          <button
            type="button"
            class={`rounded px-1 py-0.5 font-mono hover:bg-accent ${c.path === cwd ? "font-semibold text-foreground" : "text-muted-foreground"}`}
            data-testid="du-crumb"
            data-path={c.path}
            onclick={() => drill(c.path)}
          >{c.name}</button>
        {/each}
        <span class="ml-auto font-mono text-[11px] text-muted-foreground" data-testid="du-total">{fmtKb(total)}</span>
      </nav>

      <div class="grid min-h-[360px] flex-1 gap-3 @3xl/mon:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <!-- Treemap -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="relative min-h-[360px] overflow-hidden rounded-md border border-border bg-card"
          data-tm
          data-testid="du-treemap"
          bind:clientWidth={boxW}
          bind:clientHeight={boxH}
          onmouseleave={() => (hover = null)}
        >
          {#each tiles as t (t.level + ":" + t.key)}
            <button
              type="button"
              class="absolute overflow-hidden border border-background/70 text-left leading-tight text-foreground transition-[filter] hover:brightness-125 focus-visible:outline-2 focus-visible:outline-ring"
              style={`left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px;background:${t.color};${t.level === 1 ? "font-size:10px" : "font-size:11px"}`}
              data-testid={t.level === 0 ? "du-tile" : "du-subtile"}
              data-path={t.path}
              data-kb={t.kb}
              aria-label={`${t.label} ${fmtKb(t.kb)}`}
              onclick={() => drill(t.path)}
              onmousemove={(e) => move(e, t.path)}
            >
              {#if t.w > 46 && t.h > (t.level === 0 ? 30 : 24)}
                <span class="block truncate px-1 pt-0.5 font-medium">{t.label}</span>
                {#if t.level === 0 || t.h > 34}
                  <span class="block truncate px-1 font-mono text-[10px] opacity-80">{fmtKb(t.kb)}</span>
                {/if}
              {/if}
            </button>
          {/each}
          {#if tiles.length === 0 && !du.scanning}
            <p class="absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground">Nothing to show here.</p>
          {/if}
          {#if hover && hoverInfo}
            <div
              class="pointer-events-none absolute z-20 max-w-72 rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md"
              style={`left:${Math.min(hover.x + 12, Math.max(0, boxW - 200))}px;top:${Math.min(hover.y + 14, Math.max(0, boxH - 50))}px`}
              data-testid="du-tooltip"
            >
              <div class="break-all font-mono">{hoverInfo.title}</div>
              <div class="text-muted-foreground">{fmtKb(hoverInfo.kb)} · {hoverInfo.pct.toFixed(1)}% of {basename(cwd ?? "/") || "/"}</div>
            </div>
          {/if}
        </div>

        <!-- List -->
        <div class="min-h-0 overflow-auto rounded-md border border-border" data-testid="du-list">
          <table class="w-full border-collapse text-[12px]">
            <thead class="sticky top-0 z-10 bg-muted">
              <tr>
                <th class="cursor-pointer select-none px-2 py-1 text-left font-semibold text-muted-foreground hover:text-foreground" onclick={() => setSort("name")}>Name{sortMark("name")}</th>
                <th class="w-28 px-2 py-1"></th>
                <th class="w-24 cursor-pointer select-none px-2 py-1 text-right font-semibold text-muted-foreground hover:text-foreground" onclick={() => setSort("size")}>Size{sortMark("size")}</th>
                <th class="w-14 px-2 py-1 text-right font-semibold text-muted-foreground">%</th>
                <th class="w-16 px-1 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {#each rows as r (r.path)}
                <tr
                  class={`group ${hover?.path === r.path ? "bg-accent/70" : "hover:bg-accent/50"}`}
                  data-testid="du-row"
                  data-path={r.path}
                  onmouseenter={() => (hover = { path: r.path, x: 20, y: 20 })}
                  onmouseleave={() => (hover = null)}
                >
                  <td class="max-w-0 truncate px-2 py-0.5">
                    {#if r.dir}
                      <button type="button" class="flex w-full items-center gap-1.5 truncate text-left hover:underline" onclick={() => drill(r.path)} title={r.path}>
                        <FolderIcon class="size-3.5 flex-none text-chart-1" /><span class="truncate">{r.name}</span>
                      </button>
                    {:else}
                      <span class="flex items-center gap-1.5 truncate text-muted-foreground"><FileIcon class="size-3.5 flex-none" />{r.name}</span>
                    {/if}
                  </td>
                  <td class="px-2 py-0.5">
                    <div class="h-2 overflow-hidden rounded-sm bg-muted"><div class={`h-full ${r.dir ? "bg-chart-1" : "bg-muted-foreground/60"}`} style={`width:${maxKb ? (r.kb * 100) / maxKb : 0}%`}></div></div>
                  </td>
                  <td class="px-2 py-0.5 text-right font-mono tabular-nums">{fmtKb(r.kb)}</td>
                  <td class="px-2 py-0.5 text-right font-mono tabular-nums text-muted-foreground">{pct(r.kb).toFixed(1)}</td>
                  <td class="px-1 py-0.5">
                    {#if r.dir}
                      <span class="flex justify-end gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                        <button type="button" class="rounded p-1 hover:bg-background" title="Open in explorer" aria-label={`Open ${r.name} in explorer`} data-testid="du-open" onclick={() => openInExplorer(r.path)}><FolderOpenIcon class="size-3.5" /></button>
                        <button type="button" class="rounded p-1 text-destructive hover:bg-background" title="Delete" aria-label={`Delete ${r.name}`} data-testid="du-delete" onclick={() => void del(r)}><TrashIcon class="size-3.5" /></button>
                      </span>
                    {/if}
                  </td>
                </tr>
              {/each}
              {#if rows.length === 0}
                <tr><td colspan="5" class="px-2 py-4 text-center text-muted-foreground">{du.scanning ? "Scanning…" : "Empty."}</td></tr>
              {/if}
            </tbody>
          </table>
        </div>
      </div>
      <p class="flex-none text-[10px] text-muted-foreground">
        Sizes are disk usage (<code class="font-mono">du -x -k</code>, one filesystem). Click a folder to drill down; its contents are scanned on demand.
      </p>
    {/if}
  {/if}
</div>
