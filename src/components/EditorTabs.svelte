<script lang="ts">
  import { app } from "../lib/stores.svelte";
  import { basename } from "../lib/paths";
  import Editor from "./Editor.svelte";

  function isDirty(id: string): boolean {
    const t = app.tabs.find((x) => x.id === id);
    return !!t && t.doc !== t.savedDoc;
  }

  function closeTab(e: MouseEvent, id: string): void {
    e.stopPropagation();
    app.closeTab(id);
  }
</script>

<div class="editor-area">
  <div class="tab-strip">
    {#each app.tabs as tab (tab.id)}
      <div
        class="tab"
        class:active={tab.id === app.activeTabId}
        title={tab.path}
        role="tab"
        tabindex="0"
        aria-selected={tab.id === app.activeTabId}
        onclick={() => (app.activeTabId = tab.id)}
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") app.activeTabId = tab.id;
        }}
      >
        <span class="tab-name">{basename(tab.path)}</span>
        {#if isDirty(tab.id)}<span class="tab-dot">●</span>{/if}
        <button type="button" class="tab-close" aria-label="Close tab" onclick={(e) => closeTab(e, tab.id)}>
          ✕
        </button>
      </div>
    {/each}
  </div>

  <div class="editor-body">
    {#each app.tabs as tab (tab.id)}
      <Editor {tab} active={tab.id === app.activeTabId} />
    {/each}
  </div>
</div>

{#if app.conflict}
  <div class="modal-backdrop">
    <div class="modal conflict">
      <h3>File changed on server</h3>
      <p>
        <code>{app.conflict.path}</code> was modified since you opened it.
      </p>
      <div class="actions">
        <button type="button" class="danger" onclick={() => app.resolveConflictOverwrite()}
          >Overwrite</button
        >
        <button type="button" onclick={() => app.resolveConflictReload()}>Reload</button>
        <button type="button" onclick={() => app.resolveConflictCancel()}>Cancel</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .editor-area {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
  }
  .tab-strip {
    display: flex;
    overflow-x: auto;
    background: var(--bg-alt);
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-right: 1px solid var(--border);
    color: var(--muted);
    font: inherit;
    cursor: pointer;
    white-space: nowrap;
  }
  .tab.active {
    background: var(--bg);
    color: var(--fg-strong);
  }
  .tab-dot {
    color: var(--accent);
    font-size: 9px;
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
  .editor-body {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal {
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px 20px;
    max-width: 480px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .modal h3 {
    margin: 0 0 8px;
    color: var(--fg-strong);
  }
  .modal code {
    color: var(--warn);
    word-break: break-all;
  }
  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }
  .actions button {
    padding: 5px 12px;
  }
  .actions button.danger {
    background: var(--danger);
    color: #1e2127;
    border-color: var(--danger);
  }
</style>
