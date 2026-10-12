<script lang="ts">
  // Live container (or compose project) logs: follow, timestamps, tail N, search filter, wrap,
  // clear, ANSI colours, scroll-up pauses auto-scroll, copy and download. The UI keeps a
  // ring buffer of 10 000 lines; the list is windowed unless wrapping is on.
  import { clipboardWrite } from "$lib/clipboard";
  import { onDestroy, tick, untrack } from "svelte";
  import { save } from "@tauri-apps/plugin-dialog";
  import * as api from "$lib/api";
  import { app } from "$lib/stores.svelte";
  import { settings } from "$lib/settings.svelte";
  import { dockerStore, LogSession } from "$lib/docker/docker.svelte";
  import { ansiSegments } from "$lib/docker/ansi";
  import { stripAnsi, lineLevel } from "$lib/docker/parse";
  import { Button } from "$lib/components/ui/button/index.js";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import ArrowDownIcon from "@lucide/svelte/icons/arrow-down";
  import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
  import SearchIcon from "@lucide/svelte/icons/search";

  let { target, label, running = true, compose = false }: { target: string; label: string; running?: boolean; compose?: boolean } = $props();

  const ROW = 18;
  const OVERSCAN = 20;
  const WRAP_CAP = 1500;

  let tail = $state(settings.docker.logTail);
  let timestamps = $state(settings.docker.logTimestamps);
  let follow = $state(true);
  let wrap = $state(false);
  let colors = $state(true);
  let query = $state("");
  let regex = $state(false);

  let session = $state.raw<LogSession | null>(null);

  function restart(): void {
    const old = session;
    if (old) void old.stop();
    const s = dockerStore.newLogSession(target, compose);
    session = s;
    paused = false;
    if (s) void s.start({ follow, tail, timestamps });
  }

  // (Re)start whenever the target or the stream options change.
  // Deriveds dampen identity changes of the parent's container object (it is re-parsed on every refresh).
  const tgt = $derived(target);
  const cmp = $derived(compose);
  $effect(() => {
    void tgt;
    void cmp;
    void tail;
    void timestamps;
    void follow;
    untrack(restart);
  });

  // A stopped container that starts again resumes the stream (transition only, no loops).
  let wasRunning: boolean | undefined;
  $effect(() => {
    const r = running;
    if (wasRunning === false && r && session?.ended && follow) untrack(restart);
    wasRunning = r;
  });

  onDestroy(() => {
    void session?.stop();
  });

  // --- view -----------------------------------------------------------------------
  let el = $state<HTMLDivElement | null>(null);
  let viewH = $state(400);
  let scrollTop = $state(0);
  let paused = $state(false);

  const re = $derived.by(() => {
    const q = query.trim();
    if (!q) return null;
    try {
      return new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    } catch {
      return null;
    }
  });
  const badRegex = $derived(regex && query.trim() !== "" && re === null);

  const lines = $derived.by(() => {
    void session?.rev;
    const all = session?.buffer.lines ?? [];
    // A fresh array each time: the buffer mutates in place and $derived would skip an identical reference.
    if (!re) return all.slice();
    return all.filter((l) => {
      re.lastIndex = 0;
      return re.test(stripAnsi(l.text));
    });
  });
  const total = $derived.by(() => {
    void session?.rev;
    return session?.buffer.lines.length ?? 0;
  });

  const visible = $derived.by(() => {
    if (wrap) {
      const start = Math.max(0, lines.length - WRAP_CAP);
      return { start, items: lines.slice(start), top: 0, height: 0 };
    }
    const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
    const last = Math.min(lines.length, Math.ceil((scrollTop + viewH) / ROW) + OVERSCAN);
    return { start: first, items: lines.slice(first, last), top: first * ROW, height: lines.length * ROW };
  });

  function segs(text: string): { t: string; cls: string; hl: boolean }[] {
    const base = colors ? ansiSegments(text) : [{ t: stripAnsi(text), cls: "" }];
    if (!re) return base.map((b) => ({ ...b, hl: false }));
    const out: { t: string; cls: string; hl: boolean }[] = [];
    for (const b of base) {
      let last = 0;
      re.lastIndex = 0;
      for (let m = re.exec(b.t); m; m = re.exec(b.t)) {
        if (m[0] === "") {
          re.lastIndex++;
          continue;
        }
        if (m.index > last) out.push({ t: b.t.slice(last, m.index), cls: b.cls, hl: false });
        out.push({ t: m[0], cls: b.cls, hl: true });
        last = m.index + m[0].length;
      }
      if (last < b.t.length || out.length === 0) out.push({ t: b.t.slice(last), cls: b.cls, hl: false });
    }
    return out;
  }

  function onScroll(): void {
    if (!el) return;
    scrollTop = el.scrollTop;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    paused = !atBottom;
  }

  async function toBottom(): Promise<void> {
    await tick();
    if (el) el.scrollTop = el.scrollHeight;
  }

  // Follow: stick to the bottom whenever lines arrive and the user has not scrolled up.
  $effect(() => {
    void lines.length;
    void session?.rev;
    if (!paused) void toBottom();
  });

  function jump(): void {
    paused = false;
    void toBottom();
  }

  function clear(): void {
    session?.clear();
  }

  const plainLines = () => lines.map((l) => stripAnsi(l.text));

  async function copy(): Promise<void> {
    try {
      await clipboardWrite(plainLines().join("\n"));
      app.addToast("info", `Copied ${lines.length} lines`);
    } catch {
      app.addToast("error", "Clipboard access denied");
    }
  }

  async function download(): Promise<void> {
    const path = await save({ defaultPath: `${label.replace(/[^\w.-]+/g, "_")}.log` });
    if (!path) return;
    try {
      await api.logsExport(path, plainLines());
      app.addToast("success", `Saved ${lines.length} lines`);
    } catch (e) {
      app.addToast("error", e instanceof Error ? e.message : String((e as { message?: string }).message ?? e));
    }
  }

  const tails = [50, 200, 500, 1000, 5000];
  const sel = "h-7 rounded-md border border-input bg-transparent px-1.5 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
  const tog = (on: boolean) => `h-7 rounded-md border px-2 text-[12px] ${on ? "border-primary/60 bg-accent text-foreground" : "border-input text-muted-foreground hover:bg-muted"}`;
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col" data-testid="docker-logs" data-ended={session?.ended ?? false}>
  <div class="flex flex-none flex-wrap items-center gap-1 border-b border-border px-2 py-1">
    <div class="relative min-w-24 flex-1 @lg/main:max-w-60">
      <SearchIcon class="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
      <input class={`h-7 w-full rounded-md border bg-transparent pr-2 pl-6 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${badRegex ? "border-destructive" : "border-input"}`} placeholder="Search logs" data-testid="docker-logs-search" bind:value={query} />
    </div>
    <button type="button" class={tog(regex)} title="Regular expression" data-testid="docker-logs-regex" onclick={() => (regex = !regex)}>.*</button>
    <select class={sel} bind:value={tail} title="Initial lines" data-testid="docker-logs-tail" aria-label="Tail lines">
      {#each tails as n (n)}<option value={n}>{n} lines</option>{/each}
      {#if !tails.includes(tail)}<option value={tail}>{tail} lines</option>{/if}
    </select>
    <button type="button" class={tog(timestamps)} data-testid="docker-logs-timestamps" onclick={() => (timestamps = !timestamps)}>Time</button>
    <button type="button" class={tog(follow)} title="Keep streaming new output" data-testid="docker-logs-follow" onclick={() => (follow = !follow)}>Follow</button>
    <button type="button" class={tog(wrap)} data-testid="docker-logs-wrap" onclick={() => (wrap = !wrap)}>Wrap</button>
    <button type="button" class={tog(colors)} title="Render ANSI colours (off strips them)" data-testid="docker-logs-colors" onclick={() => (colors = !colors)}>Colour</button>
    <Button size="icon" variant="ghost" class="size-7" title="Clear" aria-label="Clear" data-testid="docker-logs-clear" onclick={clear}><Trash2Icon class="size-3.5" /></Button>
    <Button size="icon" variant="ghost" class="size-7" title="Copy visible lines" aria-label="Copy" data-testid="docker-logs-copy" onclick={copy}><CopyIcon class="size-3.5" /></Button>
    <Button size="icon" variant="ghost" class="size-7" title="Download visible lines" aria-label="Download" data-testid="docker-logs-download" onclick={download}><DownloadIcon class="size-3.5" /></Button>
  </div>

  <div class="relative min-h-0 flex-1">
    <div
      bind:this={el}
      bind:clientHeight={viewH}
      class="h-full overflow-auto bg-background font-mono text-[12px] leading-[18px]"
      data-testid="docker-logs-body"
      onscroll={onScroll}
    >
      {#if wrap}
        {#if lines.length > WRAP_CAP}<div class="px-2 text-[11px] text-muted-foreground italic">Showing the last {WRAP_CAP} lines (turn Wrap off to scroll all).</div>{/if}
        {#each visible.items as l (l.id)}
          <div class={`px-2 break-words whitespace-pre-wrap ${l.stream === "stderr" ? "bg-destructive/5" : ""}`} data-testid="docker-log-line">
            {#each segs(l.text) as s, i (i)}<span class={`${s.cls} ${s.hl ? "rounded-sm bg-warning/40 text-foreground" : ""}`}>{s.t}</span>{/each}
          </div>
        {/each}
      {:else}
        <div style={`height:${visible.height}px;position:relative;min-width:max-content`}>
          <div style={`position:absolute;top:${visible.top}px;left:0;right:0`}>
            {#each visible.items as l (l.id)}
              <div class={`h-[18px] px-2 whitespace-pre ${l.stream === "stderr" ? "bg-destructive/5" : ""} ${lineLevel(l.text) === "error" && !colors ? "text-destructive" : ""}`} data-testid="docker-log-line">
                {#each segs(l.text) as s, i (i)}<span class={`${s.cls} ${s.hl ? "rounded-sm bg-warning/40 text-foreground" : ""}`}>{s.t}</span>{/each}
              </div>
            {/each}
          </div>
        </div>
      {/if}
      {#if lines.length === 0}
        <p class="p-3 text-muted-foreground" data-testid="docker-logs-empty">
          {#if session?.error}{session.error}{:else if query}No lines match.{:else if session?.ended}No log output.{:else}Waiting for output…{/if}
        </p>
      {/if}
    </div>
    {#if paused}
      <button type="button" class="absolute right-4 bottom-3 flex items-center gap-1 rounded-full border border-border bg-popover px-2.5 py-1 text-[11px] shadow-md hover:bg-accent" data-testid="docker-logs-jump" onclick={jump}>
        <ArrowDownIcon class="size-3" /> Jump to bottom
      </button>
    {/if}
  </div>

  <div class="flex flex-none items-center gap-3 border-t border-border px-2 py-1 text-[11px] text-muted-foreground" data-testid="docker-logs-status">
    {#if session?.ended}
      <span>Stream ended{session.exitCode != null ? ` (exit ${session.exitCode})` : ""}</span>
      <button type="button" class="flex items-center gap-1 text-primary hover:underline" data-testid="docker-logs-resume" onclick={restart}><RotateCwIcon class="size-3" /> Resume</button>
    {:else}
      <span class="flex items-center gap-1"><span class={`size-1.5 rounded-full ${follow ? "animate-pulse bg-success" : "bg-muted-foreground"}`}></span>{follow ? (paused ? "Following (scroll paused)" : "Following") : "Snapshot"}</span>
    {/if}
    <span data-testid="docker-logs-count">{lines.length}{re ? ` of ${total}` : ""} lines{session && session.buffer.dropped > 0 ? ` · ${session.buffer.dropped} older dropped` : ""}</span>
  </div>
</div>
