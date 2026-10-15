<script lang="ts">
  // Built-in asciinema v2 player on xterm.js: play/pause, 0.5x-4x speed, idle
  // cap (2 s), seek bar. Seeking resets the terminal and replays the events up
  // to the target time, so any position is exact.
  import { onMount, onDestroy } from "svelte";
  import { Terminal as XTerm } from "@xterm/xterm";
  import "@xterm/xterm/css/xterm.css";
  import { settings, terminalTheme } from "../../lib/settings.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import PlayIcon from "@lucide/svelte/icons/play";
  import PauseIcon from "@lucide/svelte/icons/pause";
  import { parseCast, formatClock, clampDim, MAX_COLS, MAX_ROWS, type Cast } from "./cast";

  let { text }: { text: string } = $props();

  const SPEEDS = [0.5, 1, 2, 4];
  const IDLE_CAP = 2;

  let host: HTMLDivElement | undefined = $state();
  let term: XTerm | undefined;
  let cast = $state<Cast | null>(null);
  let error = $state<string | null>(null);
  let pos = $state(0);
  let playing = $state(false);
  let speed = $state(1);
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastTick = 0;
  let nextIdx = 0; // next event to apply

  function applyEvent(code: string, data: string): void {
    if (!term) return;
    if (code === "o") term.write(data);
    else if (code === "r") {
      const m = /^(\d+)x(\d+)$/.exec(data);
      if (m) term.resize(clampDim(Number(m[1]), MAX_COLS, term.cols), clampDim(Number(m[2]), MAX_ROWS, term.rows));
    }
  }

  function seek(to: number): void {
    if (!cast || !term) return;
    pos = Math.min(Math.max(to, 0), cast.duration);
    term.reset();
    term.resize(cast.width, cast.height);
    nextIdx = 0;
    let buf = "";
    // Batch consecutive output so a long replay stays one write.
    while (nextIdx < cast.events.length && cast.events[nextIdx].at <= pos) {
      const ev = cast.events[nextIdx++];
      if (ev.code === "o") buf += ev.data;
      else {
        if (buf) term.write(buf);
        buf = "";
        applyEvent(ev.code, ev.data);
      }
    }
    if (buf) term.write(buf);
  }

  function tick(): void {
    if (!cast) return;
    const now = performance.now();
    pos = Math.min(pos + ((now - lastTick) / 1000) * speed, cast.duration);
    lastTick = now;
    while (nextIdx < cast.events.length && cast.events[nextIdx].at <= pos) {
      const ev = cast.events[nextIdx++];
      applyEvent(ev.code, ev.data);
    }
    if (pos >= cast.duration) pause();
  }

  function play(): void {
    if (!cast || playing) return;
    if (pos >= cast.duration) seek(0);
    playing = true;
    lastTick = performance.now();
    timer = setInterval(tick, 33);
  }

  function pause(): void {
    playing = false;
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  onMount(() => {
    if (!host) return;
    try {
      cast = parseCast(text, IDLE_CAP);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return;
    }
    term = new XTerm({
      cols: cast.width,
      rows: cast.height,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 5000,
      fontFamily: "'Cascadia Code', Consolas, Menlo, 'SF Mono', 'DejaVu Sans Mono', 'Liberation Mono', monospace",
      fontSize: settings.terminal.fontSize,
      theme: terminalTheme(),
      allowProposedApi: true,
    });
    term.open(host);
    play();
  });

  onDestroy(() => {
    pause();
    term?.dispose();
  });
</script>

{#if error}
  <div class="p-4 text-sm text-destructive" data-testid="player-error">{error}</div>
{:else}
  <div class="flex min-h-0 flex-1 flex-col gap-2">
    <div class="min-h-0 flex-1 overflow-auto rounded border border-border bg-panel p-1" data-testid="player-term">
      <div bind:this={host} class="w-max"></div>
    </div>
    <div class="flex items-center gap-2 text-xs">
      <Button
        variant="outline"
        size="icon"
        class="size-7"
        aria-label={playing ? "Pause" : "Play"}
        data-testid="player-play"
        onclick={() => (playing ? pause() : play())}
      >
        {#if playing}<PauseIcon class="size-3.5" />{:else}<PlayIcon class="size-3.5" />{/if}
      </Button>
      <span class="w-10 text-right tabular-nums" data-testid="player-time">{formatClock(pos)}</span>
      <input
        type="range"
        class="min-w-0 flex-1 accent-primary"
        min="0"
        max={cast?.duration ?? 0}
        step="0.05"
        value={pos}
        aria-label="Seek"
        data-testid="player-seek"
        oninput={(e) => seek(Number((e.currentTarget as HTMLInputElement).value))}
      />
      <span class="w-10 tabular-nums text-muted-foreground" data-testid="player-total">
        {formatClock(cast?.duration ?? 0)}
      </span>
      <div class="flex gap-0.5" role="group" aria-label="Speed">
        {#each SPEEDS as s (s)}
          <button
            type="button"
            class={`rounded px-1.5 py-0.5 ${speed === s ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent"}`}
            data-testid={`player-speed-${s}`}
            onclick={() => (speed = s)}
          >{s}x</button>
        {/each}
      </div>
    </div>
    <div class="text-[11px] text-muted-foreground">Idle gaps longer than {IDLE_CAP} s are shortened.</div>
  </div>
{/if}
