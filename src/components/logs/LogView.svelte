<script lang="ts">
  import { clipboardWrite } from "$lib/clipboard";
  import { untrack } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Toggle } from "$lib/components/ui/toggle/index.js";
  import {
    LEVELS,
    LEVEL_CLASS,
    activeLog,
    closeLog,
    exportLines,
    logStore,
    openLog,
    stopLog,
    describeSource,
    type LogTab,
  } from "$lib/logs.svelte";
  import LogList from "./LogList.svelte";
  import XIcon from "@lucide/svelte/icons/x";
  import ArrowDownToLineIcon from "@lucide/svelte/icons/arrow-down-to-line";
  import PauseIcon from "@lucide/svelte/icons/pause";
  import PlayIcon from "@lucide/svelte/icons/play";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import WrapTextIcon from "@lucide/svelte/icons/wrap-text";
  import ListOrderedIcon from "@lucide/svelte/icons/list-ordered";
  import ClockIcon from "@lucide/svelte/icons/clock";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import ChevronUpIcon from "@lucide/svelte/icons/chevron-up";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import SquareIcon from "@lucide/svelte/icons/square";
  import FileTextIcon from "@lucide/svelte/icons/file-text";

  const tab = $derived(activeLog());

  let selected = $state(new Set<number>());
  let list = $state<LogList | null>(null);
  let filterInput = $state<HTMLInputElement | null>(null);
  let findInput = $state<HTMLInputElement | null>(null);
  let findIdx = $state(0);

  // Recompute the filtered set whenever the buffer or any filter changes.
  $effect(() => {
    if (!tab) return;
    void tab.rev;
    void tab.filterKey;
    untrack(() => tab.refresh());
  });

  // Selection is per visible tab.
  $effect(() => {
    void logStore.activeId;
    selected = new Set();
    findIdx = 0;
  });

  const findRe = $derived.by(() => {
    const q = tab?.view.find ?? "";
    if (!q) return null;
    try {
      return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    } catch {
      return null;
    }
  });

  /** Positions (in the visible list) of lines containing the find text. */
  const findHits = $derived.by(() => {
    if (!tab || !findRe) return [] as number[];
    void tab.visRev;
    const re = new RegExp(findRe.source, "i");
    const out: number[] = [];
    const vis = tab.visible;
    for (let p = 0; p < vis.length; p++) if (re.test(tab.line(vis[p]))) out.push(p);
    return out;
  });

  const findPos = $derived(findHits.length ? findHits[Math.min(findIdx, findHits.length - 1)] : -1);

  function findStep(dir: 1 | -1) {
    if (!findHits.length) return;
    findIdx = (Math.min(findIdx, findHits.length - 1) + dir + findHits.length) % findHits.length;
    list?.scrollToPos(findHits[findIdx]);
  }

  function onFilterKey(e: KeyboardEvent, t: LogTab) {
    if (e.key === "Enter") {
      e.preventDefault();
      t.addChip();
    } else if (e.key === "Backspace" && !t.view.query && t.view.chips.length) {
      t.view.chips.pop();
    } else if (e.key === "Escape") {
      t.view.query = "";
    }
  }

  function onFindKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      findStep(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape" && tab) {
      tab.view.find = "";
    }
  }

  function onRootKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      findInput?.focus();
      findInput?.select();
    } else if (e.key === "F3") {
      e.preventDefault();
      findStep(e.shiftKey ? -1 : 1);
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      filterInput?.focus();
    }
  }

  function linesForAction(t: LogTab): string[] {
    if (selected.size > 0) {
      return [...selected]
        .filter((a) => a >= t.dropped)
        .sort((a, b) => a - b)
        .map((a) => t.line(a));
    }
    return t.visibleLines();
  }

  const statusLabel = (t: LogTab) =>
    t.status === "connecting"
      ? "connecting…"
      : t.status === "live"
        ? t.paused
          ? `paused (+${t.pausedBuffered.toLocaleString()} buffered)`
          : "live"
        : t.status === "ended"
          ? `ended${t.endCode !== null ? ` (exit ${t.endCode})` : ""}`
          : "error";

  const dotClass = (t: LogTab) =>
    t.status === "live" ? (t.paused ? "bg-warning" : "bg-success") : t.status === "error" ? "bg-destructive" : t.status === "ended" ? "bg-muted-foreground" : "bg-primary animate-pulse motion-reduce:animate-none";
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-sm" data-testid="log-view" onkeydown={onRootKey}>
  {#if logStore.tabs.length === 0 || !tab}
    <div class="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <FileTextIcon class="size-8 opacity-50" />
      <p>No log open</p>
      <p class="text-xs">Pick a source in the Logs sidebar, or run "Logs: Open Log File…" from the palette.</p>
    </div>
  {:else}
    <!-- tabs -->
    <div class="flex flex-none overflow-x-auto border-b border-border bg-sidebar" role="tablist" aria-label="Open logs">
      {#each logStore.tabs as t (t.id)}
        <div
          class={[
            "group flex h-9 items-center gap-1.5 border-r border-border px-3 text-sm whitespace-nowrap select-none",
            t.id === logStore.activeId
              ? "border-t-2 border-t-primary bg-tab-active text-foreground"
              : "border-t-2 border-t-transparent bg-tab-inactive text-muted-foreground hover:text-foreground",
          ]}
          role="tab"
          tabindex="0"
          aria-selected={t.id === logStore.activeId}
          data-testid="log-tab"
          title={`${t.sessionLabel}: ${describeSource(t.spec)}`}
          onclick={() => (logStore.activeId = t.id)}
          onauxclick={(e) => {
            if (e.button === 1) void closeLog(t.id);
          }}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") logStore.activeId = t.id;
          }}
        >
          <span class={`size-2 shrink-0 rounded-full ${dotClass(t)}`}></span>
          <span class="max-w-32 overflow-hidden text-ellipsis @lg/main:max-w-48">{t.title}</span>
          <span class="hidden text-xs text-muted-foreground @lg/main:inline">{t.sessionLabel}</span>
          <button
            type="button"
            class="flex size-4 items-center justify-center rounded-sm hover:bg-accent hover:text-accent-foreground"
            aria-label={`Close ${t.title}`}
            onclick={(e) => {
              e.stopPropagation();
              void closeLog(t.id);
            }}
          >
            <XIcon class="size-3" />
          </button>
        </div>
      {/each}
    </div>

    <!-- filter row -->
    <div class="flex flex-none flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
      {#each tab.view.chips as c (c.id)}
        <span
          class={[
            "inline-flex h-6 items-center gap-1 rounded-md border px-1.5 font-mono text-xs",
            c.exclude ? "border-destructive/50 text-destructive" : "border-primary/50 text-primary",
          ]}
          data-testid="log-chip"
        >
          {c.exclude ? "−" : "+"}{c.regex ? "/" + c.text + "/" : c.text}
          <button type="button" aria-label={`Remove filter ${c.text}`} class="hover:opacity-70" onclick={() => tab.removeChip(c.id)}>
            <XIcon class="size-3" />
          </button>
        </span>
      {/each}
      <div class="flex min-w-40 flex-1 items-center gap-1 @lg/main:min-w-48">
        <Input
          bind:ref={filterInput}
          bind:value={tab.view.query}
          placeholder={tab.view.invert ? "Exclude lines matching… (Enter pins)" : "Filter lines… (Enter pins as chip)"}
          class={["h-7 flex-1 font-mono text-xs", tab.queryError && "border-destructive"]}
          data-testid="log-filter-input"
          aria-label="Filter"
          onkeydown={(e) => onFilterKey(e, tab)}
        />
        <Toggle size="sm" bind:pressed={tab.view.regex} aria-label="Regular expression" title="Regular expression" class="font-mono">.*</Toggle>
        <Toggle size="sm" bind:pressed={tab.view.cs} aria-label="Match case" title="Match case" class="font-mono">Aa</Toggle>
        <Toggle size="sm" bind:pressed={tab.view.invert} aria-label="Invert (exclude)" title="Invert: exclude matching lines" class="font-mono">!=</Toggle>
      </div>
      <label class="flex flex-none items-center gap-1 text-xs text-muted-foreground" title="Show N lines around each match">
        context
        <input
          type="number"
          min="0"
          max="50"
          class="h-7 w-14 rounded-md border border-input bg-transparent px-1.5 text-xs text-foreground"
          bind:value={tab.view.context}
          aria-label="Context lines"
        />
      </label>
    </div>

    <!-- level + actions row -->
    <div class="flex flex-none flex-wrap items-center gap-1 border-b border-border px-2 py-1">
      {#each LEVELS as name, i (name)}
        <Toggle
          size="sm"
          bind:pressed={tab.view.levels[i]}
          class={`lvl-toggle gap-1 font-mono text-xs ${tab.view.levels[i] ? "" : "opacity-50"}`}
          data-testid={`log-level-${LEVEL_CLASS[i]}`}
          aria-label={`${name} lines`}
        >
          <span class={`lvl-dot lvl-dot-${LEVEL_CLASS[i]}`}></span>
          {name}
          <span class="hidden text-muted-foreground @md/main:inline">{tab.counts[i].toLocaleString()}</span>
        </Toggle>
      {/each}

      <span class="mx-1 hidden h-4 w-px bg-border @lg/main:block"></span>

      <div class="flex min-w-0 items-center gap-0.5">
        <Input
          bind:ref={findInput}
          bind:value={tab.view.find}
          placeholder="Find in results"
          class="h-7 w-28 min-w-0 text-xs @lg/main:w-40"
          data-testid="log-find-input"
          aria-label="Find in results"
          onkeydown={onFindKey}
          oninput={() => {
            findIdx = 0;
            queueMicrotask(() => {
              if (findHits.length) list?.scrollToPos(findHits[0]);
            });
          }}
        />
        <span class="w-12 flex-none text-center text-xs text-muted-foreground" data-testid="log-find-count">
          {tab.view.find ? (findHits.length ? `${Math.min(findIdx, findHits.length - 1) + 1}/${findHits.length}` : "0/0") : ""}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Previous match" title="Previous (Shift+F3)" onclick={() => findStep(-1)}>
          <ChevronUpIcon class="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Next match" title="Next (F3)" onclick={() => findStep(1)}>
          <ChevronDownIcon class="size-4" />
        </Button>
      </div>

      <span class="ml-auto"></span>

      <Toggle size="sm" bind:pressed={tab.view.follow} aria-label="Follow" title="Follow (tail)" data-testid="log-follow">
        <ArrowDownToLineIcon class="size-4" />
      </Toggle>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={tab.paused ? "Resume stream" : "Pause stream"}
        title={tab.paused ? "Resume stream" : "Pause stream"}
        data-testid="log-pause"
        onclick={() => tab.togglePause()}
      >
        {#if tab.paused}<PlayIcon class="size-4" />{:else}<PauseIcon class="size-4" />{/if}
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Clear" title="Clear" data-testid="log-clear" onclick={() => tab.clear()}>
        <Trash2Icon class="size-4" />
      </Button>
      <Toggle size="sm" bind:pressed={tab.view.wrap} aria-label="Wrap lines" title="Wrap lines"><WrapTextIcon class="size-4" /></Toggle>
      <Toggle size="sm" bind:pressed={tab.view.lineNumbers} aria-label="Line numbers" title="Line numbers"><ListOrderedIcon class="size-4" /></Toggle>
      <Toggle size="sm" bind:pressed={tab.view.timestamps} aria-label="Timestamps" title="Timestamp column"><ClockIcon class="size-4" /></Toggle>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copy lines"
        title="Copy selected lines (or all visible)"
        onclick={() => void clipboardWrite(linesForAction(tab).join("\n"))}
      >
        <CopyIcon class="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Export lines"
        title="Save selected lines (or all visible) to a file"
        data-testid="log-export"
        onclick={() => void exportLines(tab, linesForAction(tab))}
      >
        <DownloadIcon class="size-4" />
      </Button>
      {#if tab.status === "live"}
        <Button variant="ghost" size="icon-sm" aria-label="Stop stream" title="Stop stream" onclick={() => void stopLog(tab)}>
          <SquareIcon class="size-4" />
        </Button>
      {:else if tab.status !== "connecting"}
        <Button variant="ghost" size="icon-sm" aria-label="Restart stream" title="Restart stream" onclick={() => void openLog(tab.sessionId, tab.spec, tab)}>
          <RefreshCwIcon class="size-4" />
        </Button>
      {/if}
    </div>

    <!-- list -->
    <div class="relative min-h-0 flex-1">
      {#if tab.status === "error"}
        <div class="p-4 text-destructive" data-testid="log-error">{tab.error}</div>
      {:else}
        {#key tab.id}
          <LogList bind:this={list} {tab} bind:selected {findRe} {findPos} />
        {/key}
        {#if tab.total === 0}
          <div class="pointer-events-none absolute inset-0 flex items-center justify-center text-muted-foreground">
            {tab.status === "connecting" ? "Connecting…" : tab.status === "ended" ? "No output" : "Waiting for output…"}
          </div>
        {/if}
        {#if !tab.view.follow}
          <Button
            size="sm"
            class="absolute right-5 bottom-3 shadow-md"
            data-testid="log-jump-bottom"
            onclick={() => list?.scrollToBottom()}
          >
            <ArrowDownToLineIcon class="size-3.5" /> Jump to bottom
          </Button>
        {/if}
      {/if}
    </div>

    <!-- status -->
    <div class="flex min-w-0 flex-none items-center gap-3 overflow-hidden border-t border-border bg-sidebar px-3 py-1 text-xs whitespace-nowrap text-muted-foreground" data-testid="log-status">
      <span class="min-w-0 shrink truncate font-mono" title={describeSource(tab.spec)}>{tab.sessionLabel}: {describeSource(tab.spec)}</span>
      <span class="flex-none">{statusLabel(tab)}</span>
      <span class="ml-auto flex-none" data-testid="log-count">{tab.visibleCount.toLocaleString()} / {tab.total.toLocaleString()} lines</span>
      {#if selected.size > 0}<span class="hidden flex-none @md/main:inline">{selected.size.toLocaleString()} selected</span>{/if}
      {#if tab.dropped > 0}<span class="hidden flex-none @lg/main:inline" title="Oldest lines were dropped (buffer cap)">+{tab.dropped.toLocaleString()} dropped</span>{/if}
    </div>
  {/if}
</div>

<style>
  .lvl-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 9999px;
    background: var(--muted-foreground);
  }
  .lvl-dot-error {
    background: var(--destructive);
  }
  .lvl-dot-warn {
    background: var(--warning);
  }
  .lvl-dot-info {
    background: var(--success);
  }
  .lvl-dot-debug {
    background: var(--muted-foreground);
  }
  .lvl-dot-trace {
    background: var(--muted-foreground);
    opacity: 0.5;
  }
  .lvl-dot-other {
    background: transparent;
    border: 1px solid var(--muted-foreground);
  }
</style>
