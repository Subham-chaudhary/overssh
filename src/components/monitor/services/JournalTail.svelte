<script lang="ts">
  // Live `journalctl -u <unit> -f` for the details drawer (§15.3.V). Streams through the
  // existing `logs_open` command (logs.rs); this component only owns its own buffer.
  import { onMount, untrack } from "svelte";
  import * as api from "../../../lib/api";
  import { errText } from "../../../lib/systemd/systemd.svelte";
  import { journalSpec } from "../../../lib/systemd/model";
  import type { LogDataEvent, LogEndEvent } from "../../../lib/types";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import ArrowDownToLineIcon from "@lucide/svelte/icons/arrow-down-to-line";
  import RefreshIcon from "@lucide/svelte/icons/refresh-cw";
  import EraserIcon from "@lucide/svelte/icons/eraser";

  let { sessionId, unit, user, canSudo }: { sessionId: string; unit: string; user: boolean; canSudo: boolean } = $props();

  const MAX_LINES = 3000;
  const TAIL = 300;

  let lines = $state<string[]>([]);
  let follow = $state(true);
  let sudo = $state(false);
  let filter = $state("");
  let status = $state<"connecting" | "live" | "ended" | "error">("connecting");
  let note = $state("");
  let boxEl = $state<HTMLDivElement | null>(null);

  let streamId: string | null = null;
  let gen = 0;
  let pending: { streamId: string; lines: string[] }[] = [];
  let ended = new Map<string, number | null>();
  let flushQueued = false;
  let buf: string[] = [];

  function append(batch: string[]) {
    buf.push(...batch);
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      const next = lines.concat(buf);
      buf = [];
      lines = next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }

  function onData(e: LogDataEvent) {
    if (streamId === null) pending.push(e);
    else if (e.streamId === streamId) append(e.lines);
  }
  function onEnd(e: LogEndEvent) {
    if (streamId === null) ended.set(e.streamId, e.code);
    else if (e.streamId === streamId) finish(e.code);
  }
  function finish(code: number | null) {
    status = "ended";
    note = code === null || code === 0 ? "Stream closed." : `journalctl exited with code ${code}.`;
  }

  async function start() {
    const mine = ++gen;
    await stop();
    lines = [];
    buf = [];
    pending = [];
    ended = new Map();
    streamId = null;
    status = "connecting";
    note = "";
    try {
      const id = await api.logsOpen(sessionId, journalSpec(unit, { user, sudo: sudo && canSudo, lines: TAIL }));
      if (mine !== gen) {
        void api.logsClose(id).catch(() => {});
        return;
      }
      streamId = id;
      status = "live";
      for (const p of pending) if (p.streamId === id) append(p.lines);
      pending = [];
      if (ended.has(id)) finish(ended.get(id) ?? null);
    } catch (e) {
      if (mine !== gen) return;
      status = "error";
      note = errText(e);
    }
  }

  async function stop() {
    const id = streamId;
    streamId = null;
    if (id) await api.logsClose(id).catch(() => {});
  }

  onMount(() => {
    let un1: (() => void) | undefined;
    let un2: (() => void) | undefined;
    let dead = false;
    void api.onLogData(onData).then((u) => (dead ? u() : (un1 = u)));
    void api.onLogEnd(onEnd).then((u) => (dead ? u() : (un2 = u)));
    return () => {
      dead = true;
      gen++;
      un1?.();
      un2?.();
      void stop();
    };
  });

  // (Re)start when the unit, mode or sudo toggle changes.
  $effect(() => {
    void unit;
    void user;
    void sudo;
    void sessionId;
    untrack(() => void start());
  });

  const shown = $derived.by(() => {
    const f = filter.trim().toLowerCase();
    return f ? lines.filter((l) => l.toLowerCase().includes(f)) : lines;
  });

  $effect(() => {
    void shown;
    if (follow && boxEl) {
      const el = boxEl;
      queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    }
  });

  function onScroll() {
    const el = boxEl;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom && follow) follow = false;
    else if (atBottom && !follow) follow = true;
  }

  const cls = (l: string) =>
    /\b(error|failed|fatal|crit(ical)?|panic|denied)\b/i.test(l)
      ? "text-destructive"
      : /\b(warn(ing)?)\b/i.test(l)
        ? "text-warning"
        : "";
  const noAccess = $derived(lines.some((l) => /no journal files were opened|insufficient permissions/i.test(l)));
</script>

<div class="flex min-h-0 flex-1 flex-col gap-1.5" data-testid="svc-journal">
  <div class="flex flex-none flex-wrap items-center gap-1.5">
    <Input bind:value={filter} placeholder="Filter lines" class="h-6 w-32 text-[11px]" data-testid="svc-journal-filter" />
    <Button variant={follow ? "secondary" : "outline"} size="sm" class="h-6 gap-1 px-2 text-[11px]" aria-pressed={follow} onclick={() => (follow = !follow)} data-testid="svc-journal-follow">
      <ArrowDownToLineIcon class="size-3" /> Follow
    </Button>
    {#if canSudo && !user}
      <label class="flex items-center gap-1 text-[11px] text-muted-foreground" title="Run journalctl through sudo -n (needs passwordless sudo)">
        <Switch bind:checked={sudo} class="scale-75" data-testid="svc-journal-sudo" /> sudo
      </label>
    {/if}
    <Button variant="ghost" size="icon" class="size-6" title="Clear" onclick={() => (lines = [])}><EraserIcon class="size-3" /></Button>
    <Button variant="ghost" size="icon" class="size-6" title="Restart stream" onclick={() => void start()} data-testid="svc-journal-restart"><RefreshIcon class="size-3" /></Button>
    <span class="ml-auto text-[10px] text-muted-foreground" data-testid="svc-journal-status">
      {#if status === "live"}live · {lines.length} lines{:else if status === "connecting"}connecting…{:else}{note}{/if}
    </span>
  </div>
  {#if noAccess}
    <p class="flex-none rounded bg-warning/15 px-2 py-1 text-[11px] text-warning" data-testid="svc-journal-noaccess">
      The journal is not readable by this user. Add it to the <code>systemd-journal</code> group{#if canSudo && !user} or turn on sudo{/if}.
    </p>
  {/if}
  <div
    bind:this={boxEl}
    onscroll={onScroll}
    class="min-h-0 flex-1 overflow-auto rounded border border-border bg-background p-1.5 font-mono text-[10.5px] leading-snug"
    data-testid="svc-journal-lines"
  >
    {#each shown as l, i (i)}
      <div class={`whitespace-pre-wrap break-all ${cls(l)}`}>{l}</div>
    {:else}
      <div class="text-muted-foreground">{status === "live" ? "Waiting for log lines…" : ""}</div>
    {/each}
  </div>
</div>
