<script lang="ts">
  // Lean virtualized log list (fixed row height; estimated heights when wrapping).
  // Only the rows in the viewport (+ overscan) exist in the DOM, so 100k lines stay smooth.
  import { onMount, tick } from "svelte";
  import { LEVEL_CLASS, splitTimestamp, type LogTab } from "$lib/logs.svelte";

  let {
    tab,
    selected = $bindable(new Set<number>()),
    findRe = null,
    findPos = -1,
  }: { tab: LogTab; selected?: Set<number>; findRe?: RegExp | null; findPos?: number } = $props();

  const ROW = 18;
  const OVERSCAN = 15;

  let el = $state<HTMLDivElement | null>(null);
  let probe = $state<HTMLSpanElement | null>(null);
  let viewH = $state(400);
  let viewW = $state(800);
  let scrollTop = $state(0);
  let charW = $state(7.2);
  let anchor = -1;

  onMount(() => {
    if (probe) charW = probe.getBoundingClientRect().width / 20 || 7.2;
  });

  const lnW = $derived(tab.view.lineNumbers ? String(tab.dropped + tab.total).length * charW + 16 : 0);

  // Row top offsets, only needed when wrapping (variable heights).
  const offsets = $derived.by(() => {
    void tab.visRev;
    if (!tab.view.wrap) return null;
    const n = tab.visible.length;
    const cols = Math.max(10, Math.floor((viewW - lnW - 24) / charW));
    const o = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const len = tab.line(tab.visible[i]).length + (tab.view.timestamps ? 0 : 0);
      o[i + 1] = o[i] + Math.max(1, Math.ceil(len / cols)) * ROW;
    }
    return o;
  });

  const totalH = $derived.by(() => {
    void tab.visRev;
    return offsets ? offsets[offsets.length - 1] : tab.visible.length * ROW;
  });

  const contentW = $derived(tab.view.wrap ? 0 : lnW + (tab.maxLen + 24) * charW);

  function posAtY(y: number): number {
    const n = tab.visible.length;
    if (!offsets) return Math.min(n, Math.max(0, Math.floor(y / ROW)));
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  interface Seg {
    t: string;
    cls: string;
  }
  interface Item {
    pos: number;
    abs: number;
    top: number;
    h: number;
    level: string;
    ts: string;
    segs: Seg[];
    ctx: boolean;
  }

  function segments(text: string): Seg[] {
    const ranges: [number, number, string][] = [];
    const scan = (re: RegExp | null, cls: string) => {
      if (!re) return;
      const g = re.global ? re : new RegExp(re.source, re.flags + "g");
      const hay = text.length > 3000 ? text.slice(0, 3000) : text;
      for (const m of hay.matchAll(g)) {
        if (m[0].length === 0) continue;
        ranges.push([m.index!, m.index! + m[0].length, cls]);
        if (ranges.length > 200) break;
      }
    };
    scan(tab.highlightRe, "hl");
    scan(findRe, "find");
    if (!ranges.length) return [{ t: text, cls: "" }];
    // find highlights win over filter highlights when overlapping
    ranges.sort((a, b) => a[0] - b[0] || (a[2] === "find" ? -1 : 1));
    const out: Seg[] = [];
    let at = 0;
    for (const [s, e, cls] of ranges) {
      if (s < at) continue;
      if (s > at) out.push({ t: text.slice(at, s), cls: "" });
      out.push({ t: text.slice(s, e), cls });
      at = e;
    }
    if (at < text.length) out.push({ t: text.slice(at), cls: "" });
    return out;
  }

  const items = $derived.by(() => {
    void tab.visRev;
    void tab.rev;
    const n = tab.visible.length;
    if (!n) return [] as Item[];
    const from = Math.max(0, posAtY(scrollTop) - OVERSCAN);
    const to = Math.min(n, posAtY(scrollTop + viewH) + 1 + OVERSCAN);
    const out: Item[] = [];
    for (let p = from; p < to; p++) {
      const abs = tab.visible[p];
      const full = tab.line(abs);
      const [ts, rest] = tab.view.timestamps ? splitTimestamp(full) : ["", full];
      const l = tab.levelOf(abs);
      out.push({
        pos: p,
        abs,
        top: offsets ? offsets[p] : p * ROW,
        h: offsets ? offsets[p + 1] - offsets[p] : ROW,
        level: LEVEL_CLASS[l < 0 ? 5 : l],
        ts,
        segs: segments(rest),
        ctx: tab.ctxOnly.has(abs),
      });
    }
    return out;
  });

  // Follow mode: stick to the bottom as lines arrive.
  $effect(() => {
    void tab.visRev;
    void totalH;
    if (tab.view.follow && el) {
      void tick().then(() => {
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  });

  function onScroll() {
    if (!el) return;
    scrollTop = el.scrollTop;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 6;
    if (atBottom) tab.view.follow = true;
    else if (tab.view.follow && el.scrollHeight > el.clientHeight) tab.view.follow = false;
  }

  export function scrollToPos(pos: number) {
    if (!el) return;
    const top = offsets ? offsets[pos] : pos * ROW;
    const h = offsets ? offsets[pos + 1] - offsets[pos] : ROW;
    if (top < el.scrollTop || top + h > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    }
    tab.view.follow = false;
  }

  export function scrollToBottom() {
    if (el) el.scrollTop = el.scrollHeight;
    tab.view.follow = true;
  }

  export function copySelection(): boolean {
    if (selected.size === 0) return false;
    const rows = [...selected].filter((a) => a >= tab.dropped).sort((a, b) => a - b);
    void navigator.clipboard?.writeText(rows.map((a) => tab.line(a)).join("\n"));
    return true;
  }

  function onRowClick(e: MouseEvent, it: Item) {
    if ((window.getSelection()?.toString().length ?? 0) > 0 && !e.shiftKey && !e.ctrlKey) return; // drag-selecting text
    const next = new Set(e.ctrlKey || e.metaKey ? selected : []);
    if (e.shiftKey && anchor >= 0) {
      const a = tab.visible.indexOf(anchor);
      const [lo, hi] = a < 0 ? [it.pos, it.pos] : [Math.min(a, it.pos), Math.max(a, it.pos)];
      for (let p = lo; p <= hi; p++) next.add(tab.visible[p]);
    } else if (e.ctrlKey || e.metaKey) {
      if (next.has(it.abs)) next.delete(it.abs);
      else next.add(it.abs);
      anchor = it.abs;
    } else {
      if (selected.size === 1 && selected.has(it.abs)) next.clear();
      else next.add(it.abs);
      anchor = it.abs;
    }
    selected = next;
  }

  function onKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "c" && selected.size > 0 && (window.getSelection()?.toString().length ?? 0) === 0) {
      if (copySelection()) e.preventDefault();
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      selected = new Set(tab.visible);
    } else if (e.key === "Escape") {
      selected = new Set();
    } else if (e.key === "End") {
      e.preventDefault();
      scrollToBottom();
    } else if (e.key === "Home") {
      e.preventDefault();
      if (el) el.scrollTop = 0;
      tab.view.follow = false;
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  bind:this={el}
  bind:clientHeight={viewH}
  bind:clientWidth={viewW}
  onscroll={onScroll}
  onkeydown={onKey}
  role="log"
  tabindex="0"
  data-testid="log-list"
  class="log-list relative h-full w-full overflow-auto bg-[var(--editor-bg,var(--background))] font-mono text-[12px] leading-[18px] outline-none"
>
  <span bind:this={probe} class="invisible absolute whitespace-pre" aria-hidden="true">00000000000000000000</span>
  <div style="height:{totalH}px; {tab.view.wrap ? '' : `width:${contentW}px;`} position:relative; min-width:100%">
    {#each items as it (it.abs)}
      <div
        class="log-row lvl-{it.level}"
        class:sel={selected.has(it.abs)}
        class:ctx={it.ctx}
        class:wrap={tab.view.wrap}
        data-testid="log-row"
        data-abs={it.abs}
        style="top:{it.top}px; height:{it.h}px"
        onclick={(e) => onRowClick(e, it)}
        role="presentation"
      >
        {#if tab.view.lineNumbers}
          <span class="ln" style="width:{lnW}px">{it.abs + 1}</span>
        {/if}
        {#if it.ts}<span class="ts">{it.ts}</span>{/if}
        <span class="txt"
          >{#each it.segs as s, i (i)}{#if s.cls}<mark class={s.cls} class:cur={s.cls === "find" && it.pos === findPos}>{s.t}</mark
              >{:else}{s.t}{/if}{/each}</span
        >
      </div>
    {/each}
  </div>
</div>

<style>
  .log-row {
    position: absolute;
    left: 0;
    right: 0;
    display: flex;
    gap: 8px;
    padding: 0 8px 0 0;
    white-space: pre;
    color: var(--foreground);
    cursor: default;
  }
  .log-row.wrap {
    white-space: pre-wrap;
    word-break: break-all;
  }
  .log-row:hover {
    background: color-mix(in oklab, var(--muted) 55%, transparent);
  }
  .log-row.sel {
    background: color-mix(in oklab, var(--primary) 22%, transparent);
  }
  .log-row.ctx {
    opacity: 0.55;
  }
  .ln {
    flex: none;
    text-align: right;
    padding-right: 8px;
    color: var(--muted-foreground);
    opacity: 0.7;
    user-select: none;
    border-right: 1px solid var(--border);
  }
  .ts {
    flex: none;
    color: var(--muted-foreground);
  }
  .txt {
    flex: 1 1 auto;
    min-width: 0;
  }
  .lvl-error .txt {
    color: var(--destructive);
  }
  .lvl-warn .txt {
    color: var(--warning);
  }
  .lvl-info .txt {
    color: var(--foreground);
  }
  .lvl-debug .txt {
    color: var(--muted-foreground);
  }
  .lvl-trace .txt {
    color: var(--muted-foreground);
    opacity: 0.7;
  }
  mark {
    color: inherit;
    border-radius: 2px;
  }
  mark.hl {
    background: color-mix(in oklab, var(--primary) 35%, transparent);
    outline: 1px solid color-mix(in oklab, var(--primary) 60%, transparent);
  }
  mark.find {
    background: color-mix(in oklab, var(--warning) 40%, transparent);
  }
  mark.find.cur {
    background: color-mix(in oklab, var(--warning) 85%, transparent);
    color: var(--background);
  }
</style>
