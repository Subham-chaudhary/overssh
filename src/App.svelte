<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import { app } from "./lib/stores.svelte";
  import { onSessionClosed } from "./lib/api";
  import HostList from "./components/HostList.svelte";
  import Explorer from "./components/Explorer.svelte";
  import EditorTabs from "./components/EditorTabs.svelte";
  import PromptDialog from "./components/PromptDialog.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import TerminalPanel from "./components/TerminalPanel.svelte";

  let unlisten: UnlistenFn | undefined;

  onMount(() => {
    void onSessionClosed((payload) => app.handleSessionClosed(payload)).then((fn) => {
      unlisten = fn;
    });
  });

  onDestroy(() => {
    unlisten?.();
  });

  let dragging = false;

  function startDrag(e: PointerEvent): void {
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onDrag(e: PointerEvent): void {
    if (!dragging) return;
    app.sidebarWidth = Math.min(520, Math.max(180, e.clientX));
  }

  function stopDrag(): void {
    dragging = false;
  }

  // Terminal panel height (local to this component — the panel itself is
  // always mounted so its terminals survive being hidden; only its height
  // and a `.hidden` class change).
  let panelHeight = $state(260);
  let mainEl: HTMLElement | undefined = $state();
  let resizingPanel = false;

  function startPanelDrag(e: PointerEvent): void {
    resizingPanel = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPanelDrag(e: PointerEvent): void {
    if (!resizingPanel || !mainEl) return;
    const bottom = mainEl.getBoundingClientRect().bottom;
    const maxHeight = window.innerHeight * 0.8;
    panelHeight = Math.min(maxHeight, Math.max(100, bottom - e.clientY));
  }

  function stopPanelDrag(): void {
    resizingPanel = false;
  }

  function onWindowKeydown(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "w") {
      if (app.activeTabId) {
        e.preventDefault();
        app.closeTab(app.activeTabId);
      }
    } else if (mod && e.key === "`") {
      e.preventDefault();
      app.showTerminal = !app.showTerminal;
    } else if (e.key === "F5") {
      if (app.activeSessionId) {
        e.preventDefault();
        void app.refreshExplorer(app.activeSessionId);
      }
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="app-root">
  <div class="workspace">
    <aside class="sidebar" style={`width:${app.sidebarWidth}px`}>
      <div class="sidebar-tabs">
        <button
          type="button"
          class:active={app.sidebarView === "hosts"}
          onclick={() => (app.sidebarView = "hosts")}
        >
          Hosts
        </button>
        <button
          type="button"
          class:active={app.sidebarView === "explorer"}
          onclick={() => (app.sidebarView = "explorer")}
        >
          Explorer
        </button>
      </div>
      <div class="sidebar-body">
        {#if app.sidebarView === "hosts"}
          <HostList />
        {:else}
          <Explorer />
        {/if}
      </div>
    </aside>

    <div
      class="splitter"
      role="separator"
      aria-orientation="vertical"
      onpointerdown={startDrag}
      onpointermove={onDrag}
      onpointerup={stopDrag}
    ></div>

    <main class="main" bind:this={mainEl}>
      <div class="center">
        {#if app.tabs.length === 0}
          <div class="empty-state">
            <p>No file open.</p>
            <ul>
              <li><kbd>Ctrl</kbd> + <kbd>S</kbd> save</li>
              <li><kbd>Ctrl</kbd> + <kbd>W</kbd> close tab</li>
              <li><kbd>Ctrl</kbd> + <kbd>F</kbd> find in file</li>
              <li><kbd>Ctrl</kbd> + <kbd>`</kbd> toggle terminal</li>
              <li><kbd>F5</kbd> refresh explorer</li>
            </ul>
          </div>
        {:else}
          <EditorTabs />
        {/if}
      </div>

      <div
        class="panel-splitter"
        class:hidden={!app.showTerminal}
        role="separator"
        aria-orientation="horizontal"
        onpointerdown={startPanelDrag}
        onpointermove={onPanelDrag}
        onpointerup={stopPanelDrag}
      ></div>

      <!-- Always mounted (never {#if}'d away) so terminals survive the panel
           being hidden; visibility is CSS-only. -->
      <div class="panel" class:hidden={!app.showTerminal} style={`height:${panelHeight}px`}>
        <TerminalPanel />
      </div>
    </main>
  </div>

  <StatusBar />
</div>

<PromptDialog />

<div class="toast-stack">
  {#each app.toasts as t (t.id)}
    <div class="toast {t.kind}">
      <span>{t.message}</span>
      <button type="button" onclick={() => app.dismissToast(t.id)} aria-label="Dismiss">✕</button>
    </div>
  {/each}
</div>

<style>
  .app-root {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .workspace {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .sidebar {
    display: flex;
    flex-direction: column;
    flex: none;
    background: var(--bg-alt);
    border-right: 1px solid var(--border);
    min-width: 180px;
    max-width: 520px;
  }
  .sidebar-tabs {
    display: flex;
    flex: none;
    border-bottom: 1px solid var(--border);
  }
  .sidebar-tabs button {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--muted);
    padding: 8px 0;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .sidebar-tabs button.active {
    color: var(--fg-strong);
    border-bottom-color: var(--accent);
  }
  .sidebar-tabs button:hover {
    color: var(--fg-strong);
  }
  .sidebar-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .splitter {
    flex: none;
    width: 4px;
    cursor: col-resize;
    background: transparent;
  }
  .splitter:hover,
  .splitter:active {
    background: var(--accent);
  }
  .main {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .center {
    flex: 1;
    min-height: 0;
  }
  .panel-splitter {
    flex: none;
    height: 4px;
    cursor: row-resize;
    background: transparent;
  }
  .panel-splitter:hover,
  .panel-splitter:active {
    background: var(--accent);
  }
  .panel-splitter.hidden {
    display: none;
  }
  .panel {
    flex: none;
    border-top: 1px solid var(--border);
    background: var(--bg-alt);
    overflow: hidden;
  }
  .panel.hidden {
    display: none;
  }
  .empty-state {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--muted);
  }
  .empty-state ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
  }
  .empty-state kbd {
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 5px;
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .toast-stack {
    position: fixed;
    right: 14px;
    bottom: 30px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    z-index: 500;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    padding: 8px 10px;
    border-radius: 4px;
    font-size: 12px;
    color: var(--fg-strong);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
    max-width: 360px;
  }
  .toast.success {
    border-left-color: var(--ok);
  }
  .toast.error {
    border-left-color: var(--danger);
  }
  .toast button {
    background: transparent;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 11px;
  }
  .toast button:hover {
    color: var(--fg-strong);
  }
</style>
