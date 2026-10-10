<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { app } from "../lib/stores.svelte";
  import { isAppError } from "../lib/api";
  import { terminalStore } from "../lib/terminal.svelte";
  import { cn } from "../lib/utils";
  import { settings } from "../lib/settings.svelte";
  import Terminal from "./Terminal.svelte";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
  } from "$lib/components/ui/tooltip/index.js";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import XIcon from "@lucide/svelte/icons/x";
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import ArrowDownToLineIcon from "@lucide/svelte/icons/arrow-down-to-line";
  import { initMain, dockBack } from "../terminal-window/bridge.svelte";
  import { termLayout, tabKey } from "../terminal-window/layout.svelte";
  import { PANE_HEADER, leaves, ratioFromPointer, type DividerPlacement } from "../terminal-window/splitLayout";
  import type { TerminalTab } from "../lib/terminal.svelte";
  import SquareSplitHorizontalIcon from "@lucide/svelte/icons/square-split-horizontal";
  import SquareSplitVerticalIcon from "@lucide/svelte/icons/square-split-vertical";
  import MinimizeIcon from "@lucide/svelte/icons/minimize-2";

  // `detached`: this panel is the one inside the separate terminal window (§14.4.W).
  let { detached = false }: { detached?: boolean } = $props();

  // Keyed by termId. Populated via bind:this on each mounted <Terminal>, used
  // to refit a terminal after it becomes visible again (tab switch, or the
  // whole panel being shown).
  let refs: Record<string, { fit: () => void } | undefined> = {};

  function sessionLabel(sessionId: string): string {
    return terminalStore.sessionLabel(sessionId);
  }

  async function openNew(): Promise<void> {
    const sessionId = terminalStore.defaultSessionId();
    if (!sessionId) return;
    const cwd = terminalStore.cwdFor(sessionId);
    try {
      await terminalStore.openNew(sessionId, { cwd });
    } catch (err) {
      app.addToast("error", isAppError(err) ? err.message : String(err));
    }
  }

  function closeTerminal(e: MouseEvent, id: string): void {
    e.stopPropagation();
    void terminalStore.close(id);
  }

  function closePanel(): void {
    app.showTerminal = false;
  }

  onMount(() => {
    void terminalStore.ensureListening();
    if (!detached) initMain();
    else termLayout.restoreFromStorage();
  });

  // --- split panes (detached window only, §15.3.S) ---------------------------------

  let areaEl: HTMLDivElement | undefined = $state();
  let areaW = $state(0);
  let areaH = $state(0);
  let tabMenu = $state<{ x: number; y: number; id: string } | null>(null);

  $effect(() => {
    if (!detached) return;
    termLayout.width = areaW;
    termLayout.height = areaH;
  });

  // Keep panes and tabs in step: a terminal that closed collapses its pane, the
  // active terminal shows in the focused pane (or focuses the pane that shows it).
  $effect(() => {
    if (!detached) return;
    void terminalStore.tabs.map(tabKey);
    void terminalStore.activeId;
    untrack(() => termLayout.sync());
  });

  const split = $derived(detached && termLayout.isSplit);
  const placement = $derived(termLayout.placement);
  /** False when the window is too small for even the minimum pane sizes: only the focused pane shows. */
  const showPanes = $derived(split && placement.fits);

  function paneOf(tab: TerminalTab) {
    const key = tabKey(tab);
    return placement.panes.find((p) => p.key === key) ?? null;
  }

  /** Whether a terminal is on screen right now. */
  function isShown(tab: TerminalTab): boolean {
    if (showPanes) return paneOf(tab) !== null;
    if (split) {
      const active = terminalStore.activeTab;
      return tabKey(tab) === (termLayout.focusedKey ?? (active ? tabKey(active) : null));
    }
    return tab.id === terminalStore.activeId;
  }

  function bodyStyle(tab: TerminalTab): string | undefined {
    const p = showPanes ? paneOf(tab) : null;
    if (!p) return undefined;
    return `left:${p.x}px;top:${p.y + PANE_HEADER}px;width:${p.w}px;height:${Math.max(0, p.h - PANE_HEADER)}px;`;
  }

  function tabForKey(key: string | null): TerminalTab | null {
    return key ? (terminalStore.tabs.find((t) => tabKey(t) === key) ?? null) : null;
  }

  function focusOwnPane(tab: TerminalTab): void {
    if (!detached || !split) return;
    const leaf = leaves(termLayout.root).find((l) => l.key === tabKey(tab));
    if (leaf) termLayout.focus(leaf.id, false);
  }

  function startDividerDrag(e: PointerEvent, d: DividerPlacement): void {
    if (e.button !== 0 || !areaEl) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!areaEl) return;
      const r = areaEl.getBoundingClientRect();
      termLayout.setRatio(d.id, ratioFromPointer(d, d.dir === "row" ? ev.clientX - r.left : ev.clientY - r.top));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  function onDividerKey(e: KeyboardEvent, d: DividerPlacement): void {
    const grow = d.dir === "row" ? "ArrowRight" : "ArrowDown";
    const shrink = d.dir === "row" ? "ArrowLeft" : "ArrowUp";
    if (e.key !== grow && e.key !== shrink) return;
    if (e.altKey) return; // Alt+Arrow moves pane focus
    e.preventDefault();
    e.stopPropagation();
    const cur = (d.dir === "row" ? d.x : d.y) - d.areaStart;
    const step = e.shiftKey ? 80 : 24;
    termLayout.setRatio(d.id, (cur + (e.key === grow ? step : -step)) / d.areaSize);
  }

  async function splitFrom(id: string | null, dir: "row" | "col"): Promise<void> {
    tabMenu = null;
    if (id) {
      terminalStore.setActive(id);
      termLayout.sync();
    }
    await termLayout.split(dir);
  }

  function onTabContextMenu(e: MouseEvent, tab: TerminalTab): void {
    if (!detached) return;
    e.preventDefault();
    e.stopPropagation();
    tabMenu = { x: e.clientX, y: e.clientY, id: tab.id };
  }

  // xterm refits on every pane resize (its own ResizeObserver, debounced); this also
  // refits after layout changes that keep a pane's size (focus swaps, restore).
  $effect(() => {
    if (!detached) return;
    void areaW;
    void areaH;
    void JSON.stringify(placement.panes);
    void termLayout.focusedKey;
    const t = setTimeout(() => {
      for (const tab of terminalStore.tabs) if (isShown(tab)) refs[tab.id]?.fit();
    }, 80);
    return () => clearTimeout(t);
  });

  // Auto-open a first terminal the moment the panel is shown with none open
  // (covers Ctrl+J / the palette's "Toggle Terminal Panel", which only flip
  // `app.showTerminal` — App.svelte's Ctrl+` handler opens one itself when
  // needed). `hasPendingOpen` avoids racing that Ctrl+` path: both funnel
  // through `terminalStore.openNew`, which reserves the session synchronously
  // before either could observe the other's "zero tabs" state — see its
  // doc comment in terminal.svelte.ts.
  $effect(() => {
    const sessionId = app.activeSessionId;
    if (
      !detached &&
      app.showTerminal &&
      terminalStore.tabs.length === 0 &&
      sessionId &&
      !terminalStore.hasPendingOpen(sessionId)
    ) {
      void openNew();
    }
  });

  // Re-fit whenever the active terminal (or panel visibility) changes — its
  // container may have changed size while it was hidden.
  $effect(() => {
    if (app.showTerminal && terminalStore.activeId) {
      refs[terminalStore.activeId]?.fit();
    }
  });
</script>

<TooltipProvider delayDuration={300}>
  <div class="flex h-full w-full min-h-0 min-w-0 flex-col bg-panel">
    <div class="flex flex-none items-stretch border-b border-border bg-sidebar">
      <div
        class="flex flex-none items-center px-3 text-[11px] font-semibold tracking-wide text-muted-foreground select-none"
        data-testid="terminal-panel-label"
      >
        TERMINAL
      </div>

      <div
        class="flex min-w-0 flex-1 items-stretch overflow-x-auto"
        role="tablist"
        aria-label="Open terminals"
      >
        {#each terminalStore.tabs as tab (tab.key ?? tab.id)}
          <div
            class={cn(
              "group flex flex-none items-center gap-1.5 border-r border-border px-2.5 text-xs whitespace-nowrap",
              tab.id === terminalStore.activeId
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
              tab.sessionId !== terminalStore.currentSessionId && "opacity-70",
            )}
            role="tab"
            tabindex="0"
            aria-selected={tab.id === terminalStore.activeId}
            data-testid="terminal-tab"
            data-term-id={tab.id}
            onclick={() => terminalStore.setActive(tab.id)}
            oncontextmenu={(e) => onTabContextMenu(e, tab)}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") terminalStore.setActive(tab.id);
            }}
          >
            <Tooltip>
              <TooltipTrigger>
                {#snippet child({ props })}
                  <span {...props} class="max-w-[160px] truncate py-1.5">{tab.title}</span>
                {/snippet}
              </TooltipTrigger>
              <TooltipContent side="bottom">{tab.title}</TooltipContent>
            </Tooltip>
            <Badge variant="outline" class="text-[10px] font-normal">
              {sessionLabel(tab.sessionId)}
            </Badge>
            {#if settings.terminal.recording.enabled}
              <Tooltip>
                <TooltipTrigger>
                  {#snippet child({ props })}
                    <button
                      {...props}
                      type="button"
                      class="rounded p-0.5 hover:bg-accent"
                      aria-label={tab.recording ? "Stop recording" : "Start recording"}
                      aria-pressed={tab.recording}
                      data-testid="terminal-rec-toggle"
                      data-recording={tab.recording}
                      onclick={(e: MouseEvent) => {
                        e.stopPropagation();
                        void terminalStore.toggleRecording(tab.id);
                      }}
                    >
                      <span
                        class={cn(
                          "block size-2.5 rounded-full",
                          tab.recording
                            ? "animate-pulse bg-red-500"
                            : "border border-red-500/70 bg-transparent",
                        )}
                      ></span>
                    </button>
                  {/snippet}
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {tab.recording ? "Recording - click to stop" : "Start recording this terminal"}
                </TooltipContent>
              </Tooltip>
            {/if}
            {#if tab.exited}
              <span class="text-[10px] font-semibold text-destructive uppercase">exited</span>
            {/if}
            <Tooltip>
              <TooltipTrigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    class="rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={`Close ${tab.title}`}
                    onclick={(e: MouseEvent) => closeTerminal(e, tab.id)}
                  >
                    <Trash2Icon size={12} />
                  </button>
                {/snippet}
              </TooltipTrigger>
              <TooltipContent side="bottom">Close terminal</TooltipContent>
            </Tooltip>
          </div>
        {/each}
      </div>

      {#if detached}
        <Tooltip>
          <TooltipTrigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="flex w-8 flex-none items-center justify-center border-l border-border text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                disabled={!terminalStore.defaultSessionId()}
                aria-label="Split terminal right"
                data-testid="terminal-split-right"
                onclick={() => void termLayout.split("row")}
              >
                <SquareSplitHorizontalIcon size={14} />
              </button>
            {/snippet}
          </TooltipTrigger>
          <TooltipContent side="bottom">Split right (Ctrl+\ or Ctrl+Shift+5)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="flex w-8 flex-none items-center justify-center border-l border-border text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                disabled={!terminalStore.defaultSessionId()}
                aria-label="Split terminal down"
                data-testid="terminal-split-down"
                onclick={() => void termLayout.split("col")}
              >
                <SquareSplitVerticalIcon size={14} />
              </button>
            {/snippet}
          </TooltipTrigger>
          <TooltipContent side="bottom">Split down (Ctrl+Shift+\)</TooltipContent>
        </Tooltip>
        {#if split}
          <Tooltip>
            <TooltipTrigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  class="flex w-8 flex-none items-center justify-center border-l border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Merge panes into one"
                  data-testid="terminal-unsplit"
                  onclick={() => termLayout.unsplit()}
                >
                  <MinimizeIcon size={14} />
                </button>
              {/snippet}
            </TooltipTrigger>
            <TooltipContent side="bottom">Merge panes (terminals stay open as tabs)</TooltipContent>
          </Tooltip>
        {/if}
      {/if}

      <Tooltip>
        <TooltipTrigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="flex w-8 flex-none items-center justify-center border-l border-border text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              disabled={!terminalStore.defaultSessionId()}
              aria-label="New terminal"
              onclick={() => void openNew()}
            >
              <PlusIcon size={14} />
            </button>
          {/snippet}
        </TooltipTrigger>
        <TooltipContent side="bottom">New terminal</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="flex w-8 flex-none items-center justify-center border-l border-border text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={detached ? "Dock terminals back into the main window" : "Detach terminal panel to a window"}
              data-testid={detached ? "terminal-dock" : "terminal-detach"}
              onclick={() => void (detached ? dockBack() : terminalStore.detach())}
            >
              {#if detached}
                <ArrowDownToLineIcon size={14} />
              {:else}
                <ExternalLinkIcon size={14} />
              {/if}
            </button>
          {/snippet}
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {detached ? "Dock back into the main window" : "Detach panel to a window"}
        </TooltipContent>
      </Tooltip>

      {#if !detached}
        <Tooltip>
          <TooltipTrigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="flex w-8 flex-none items-center justify-center border-l border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Close terminal panel"
                onclick={closePanel}
              >
                <XIcon size={14} />
              </button>
            {/snippet}
          </TooltipTrigger>
          <TooltipContent side="bottom">Close panel (Ctrl+`)</TooltipContent>
        </Tooltip>
      {/if}
    </div>

    <div
      class="relative min-h-0 flex-1 overflow-hidden bg-panel"
      bind:this={areaEl}
      bind:clientWidth={areaW}
      bind:clientHeight={areaH}
      data-testid="terminal-area"
      data-split={split}
    >
      {#if terminalStore.tabs.length === 0}
        <div class="flex h-full items-center justify-center text-xs text-muted-foreground">
          {#if terminalStore.currentSessionId}
            No terminal open.
          {:else}
            Connect to a host to open a terminal.
          {/if}
        </div>
      {/if}
      {#each terminalStore.tabs as tab (tab.key ?? tab.id)}
        <div
          class={cn("absolute", !(showPanes && paneOf(tab)) && "inset-0", !isShown(tab) && "invisible pointer-events-none")}
          style={bodyStyle(tab)}
          data-testid="terminal-body"
          data-term-id={tab.id}
          onpointerdowncapture={() => focusOwnPane(tab)}
          role="presentation"
        >
          <Terminal termId={tab.id} bind:this={refs[tab.id]} />
        </div>
      {/each}

      {#if showPanes}
        {#each placement.panes as p (p.id)}
          {@const ptab = tabForKey(p.key)}
          {@const focused = p.id === termLayout.focusId}
          <div
            class={cn(
              "absolute flex items-center gap-1.5 overflow-hidden border-b border-border px-2 text-[11px] select-none",
              focused ? "bg-background text-foreground" : "bg-sidebar text-muted-foreground",
            )}
            style={`left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${PANE_HEADER}px;`}
            data-testid="terminal-pane"
            data-pane-id={p.id}
            data-focused={focused}
            data-term-id={ptab?.id}
            role="presentation"
            onpointerdown={() => termLayout.focus(p.id)}
          >
            <span class="min-w-0 flex-1 truncate">{ptab ? ptab.title : "Starting terminal..."}</span>
            {#if ptab}
              <span class="flex-none text-[10px] opacity-70">{sessionLabel(ptab.sessionId)}</span>
              <button
                type="button"
                class="flex-none rounded p-0.5 text-muted-foreground opacity-60 hover:bg-accent hover:text-foreground hover:opacity-100"
                aria-label={`Close ${ptab.title}`}
                data-testid="terminal-pane-close"
                onpointerdown={(e) => e.stopPropagation()}
                onclick={(e) => closeTerminal(e, ptab.id)}
              >
                <XIcon size={11} />
              </button>
            {/if}
          </div>
          <div
            class={cn("pointer-events-none absolute border", focused ? "border-primary/70" : "border-transparent")}
            style={`left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px;`}
          ></div>
        {/each}
        {#each placement.dividers as d (d.id)}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div
            class={cn(
              "absolute z-10 bg-border hover:bg-primary/60",
              d.dir === "row" ? "cursor-col-resize" : "cursor-row-resize",
            )}
            style={`left:${d.x}px;top:${d.y}px;width:${d.w}px;height:${d.h}px;`}
            role="separator"
            aria-orientation={d.dir === "row" ? "vertical" : "horizontal"}
            aria-valuenow={Math.round((((d.dir === "row" ? d.x : d.y) - d.areaStart) / d.areaSize) * 100)}
            tabindex="0"
            data-testid="terminal-split-divider"
            data-dir={d.dir}
            onpointerdown={(e) => startDividerDrag(e, d)}
            onkeydown={(e) => onDividerKey(e, d)}
          ></div>
        {/each}
      {/if}
    </div>
  </div>
</TooltipProvider>

<svelte:window
  onclick={() => (tabMenu = null)}
  onblur={() => (tabMenu = null)}
  onkeydown={(e) => {
    if (e.key === "Escape") tabMenu = null;
  }}
/>

{#if tabMenu && detached}
  <div
    class="fixed z-[300] flex min-w-[160px] flex-col gap-0.5 rounded-md border border-border bg-popover p-1 text-[12px] text-popover-foreground shadow-lg"
    style={`left:${Math.min(tabMenu.x, window.innerWidth - 176)}px;top:${Math.min(tabMenu.y, window.innerHeight - 110)}px;`}
    role="menu"
    data-testid="terminal-tab-menu"
  >
    <button
      type="button"
      role="menuitem"
      class="rounded-sm px-2 py-1 text-left hover:bg-accent"
      data-testid="terminal-tab-menu-split-right"
      onclick={() => void splitFrom(tabMenu?.id ?? null, "row")}>Split Right</button
    >
    <button
      type="button"
      role="menuitem"
      class="rounded-sm px-2 py-1 text-left hover:bg-accent"
      data-testid="terminal-tab-menu-split-down"
      onclick={() => void splitFrom(tabMenu?.id ?? null, "col")}>Split Down</button
    >
    <div class="my-0.5 h-px bg-border"></div>
    <button
      type="button"
      role="menuitem"
      class="rounded-sm px-2 py-1 text-left text-destructive hover:bg-destructive/10"
      onclick={() => {
        const id = tabMenu?.id;
        tabMenu = null;
        if (id) void terminalStore.close(id);
      }}>Close Terminal</button
    >
  </div>
{/if}
