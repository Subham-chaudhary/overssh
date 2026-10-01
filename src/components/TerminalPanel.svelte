<script lang="ts">
  import { onMount } from "svelte";
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

    <div class="relative min-h-0 flex-1 bg-panel">
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
          class={cn(
            "absolute inset-0",
            tab.id !== terminalStore.activeId && "invisible pointer-events-none",
          )}
        >
          <Terminal termId={tab.id} bind:this={refs[tab.id]} />
        </div>
      {/each}
    </div>
  </div>
</TooltipProvider>
