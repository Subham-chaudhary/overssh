<script lang="ts">
  import { app } from "../lib/stores.svelte";

  const session = $derived(app.activeSession);
  const tab = $derived(app.activeTab);
</script>

<footer class="status-bar">
  <div class="left">
    {#if app.connecting}
      <span class="pill connecting">Connecting…</span>
    {:else if session}
      <span class="pill ok">● {session.label}</span>
      <span class="muted">{session.user}@{session.hostname}</span>
    {:else}
      <span class="pill">○ Not connected</span>
    {/if}
    {#if app.sessions.length > 1}
      <span class="muted">{app.sessions.length} sessions</span>
    {/if}
  </div>
  <div class="right">
    {#if tab}
      <span class="path" title={tab.path}>{tab.path}</span>
      <span>{tab.language}</span>
      <span>Ln {tab.line}, Col {tab.col}</span>
    {/if}
  </div>
</footer>

<style>
  .status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 22px;
    padding: 0 10px;
    background: var(--accent);
    color: #1e2127;
    font-size: 11px;
    flex: none;
    gap: 16px;
  }
  .left,
  .right {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .pill {
    font-weight: 600;
  }
  .pill.ok {
    color: #1e2127;
  }
  .pill.connecting {
    color: #1e2127;
    opacity: 0.8;
  }
  .muted {
    opacity: 0.75;
  }
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40vw;
  }
</style>
