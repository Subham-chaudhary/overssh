<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "../lib/stores.svelte";
  import { isAppError } from "../lib/api";
  import { terminalStore } from "../lib/terminal.svelte";
  import Terminal from "./Terminal.svelte";

  // Keyed by termId. Populated via bind:this on each mounted <Terminal>, used
  // to refit a terminal after it becomes visible again (tab switch, or the
  // whole panel being shown).
  let refs: Record<string, { fit: () => void } | undefined> = {};

  function sessionLabel(sessionId: string): string {
    return app.sessions.find((s) => s.id === sessionId)?.label ?? sessionId;
  }

  async function openNew(): Promise<void> {
    const sessionId = app.activeSessionId;
    if (!sessionId) return;
    const cwd = app.explorers[sessionId]?.cwd;
    try {
      await terminalStore.open(sessionId, sessionLabel(sessionId), 80, 24, cwd);
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
  });

  // Auto-open a first terminal the moment the panel is shown with none open.
  $effect(() => {
    if (app.showTerminal && terminalStore.tabs.length === 0 && app.activeSessionId) {
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

<div class="terminal-panel">
  <div class="tab-strip">
    {#each terminalStore.tabs as tab (tab.id)}
      <div
        class="tab"
        class:active={tab.id === terminalStore.activeId}
        role="tab"
        tabindex="0"
        aria-selected={tab.id === terminalStore.activeId}
        onclick={() => terminalStore.setActive(tab.id)}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") terminalStore.setActive(tab.id);
        }}
      >
        <span class="tab-name">{tab.title}</span>
        {#if tab.exited}<span class="tab-exited">exited</span>{/if}
        <button
          type="button"
          class="tab-close"
          aria-label="Close terminal"
          onclick={(e) => closeTerminal(e, tab.id)}
        >
          ✕
        </button>
      </div>
    {/each}
    <button
      type="button"
      class="new-terminal"
      title="New terminal"
      disabled={!app.activeSessionId}
      onclick={() => void openNew()}
    >
      +
    </button>
    <div class="tab-strip-spacer"></div>
    <button type="button" class="close-panel" aria-label="Close terminal panel" onclick={closePanel}>
      ✕
    </button>
  </div>

  <div class="terminal-body">
    {#if terminalStore.tabs.length === 0}
      <div class="empty">
        {#if app.activeSessionId}
          No terminal open.
        {:else}
          Connect to a host to open a terminal.
        {/if}
      </div>
    {/if}
    {#each terminalStore.tabs as tab (tab.id)}
      <div class="terminal-instance" class:hidden={tab.id !== terminalStore.activeId}>
        <Terminal termId={tab.id} bind:this={refs[tab.id]} />
      </div>
    {/each}
  </div>
</div>

<style>
  .terminal-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .tab-strip {
    display: flex;
    align-items: stretch;
    overflow-x: auto;
    background: var(--bg-alt);
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-right: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .tab.active {
    background: var(--bg);
    color: var(--fg-strong);
  }
  .tab-exited {
    color: var(--danger);
    font-size: 10px;
    text-transform: uppercase;
  }
  .tab-close {
    background: transparent;
    border: none;
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    border-radius: 3px;
    padding: 0 3px;
    line-height: 1.6;
    cursor: pointer;
  }
  .tab-close:hover {
    background: var(--bg-hover);
    color: var(--fg-strong);
  }
  .new-terminal {
    flex: none;
    background: transparent;
    border: none;
    border-right: 1px solid var(--border);
    color: var(--muted);
    width: 28px;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }
  .new-terminal:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--fg-strong);
  }
  .new-terminal:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tab-strip-spacer {
    flex: 1;
  }
  .close-panel {
    flex: none;
    background: transparent;
    border: none;
    color: var(--muted);
    width: 28px;
    font-size: 11px;
    cursor: pointer;
  }
  .close-panel:hover {
    background: var(--bg-hover);
    color: var(--fg-strong);
  }
  .terminal-body {
    flex: 1;
    min-height: 0;
    position: relative;
    background: #1e2127;
  }
  .terminal-instance {
    position: absolute;
    inset: 0;
  }
  .terminal-instance.hidden {
    visibility: hidden;
    pointer-events: none;
  }
  .empty {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-size: 12px;
  }
</style>
