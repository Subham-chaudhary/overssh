<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "../lib/stores.svelte";
  import QuickConnect from "./QuickConnect.svelte";

  onMount(() => {
    void app.loadHosts();
  });

  function connectHost(alias: string): void {
    void app.connect({ alias }, alias);
  }
</script>

<div class="host-list">
  <input
    type="text"
    class="filter"
    placeholder="Filter hosts…"
    bind:value={app.hostFilter}
    spellcheck="false"
  />

  <div class="entries">
    {#if app.hostsLoading}
      <div class="state muted">Loading ~/.ssh/config…</div>
    {:else if app.hostsError}
      <div class="state error">{app.hostsError}</div>
    {:else if app.filteredHosts.length === 0}
      <div class="state muted">No hosts found.</div>
    {:else}
      <ul>
        {#each app.filteredHosts as host (host.alias)}
          <li>
            <button
              type="button"
              class="host"
              disabled={app.connecting}
              onclick={() => connectHost(host.alias)}
            >
              <span class="alias">{host.alias}</span>
              <span class="detail">{host.user ? `${host.user}@` : ""}{host.hostname}</span>
              {#if host.proxyJump}
                <span class="warn" title={`ProxyJump ${host.proxyJump} is unsupported`}
                  >unsupported proxy</span
                >
              {/if}
            </button>
            {#if app.connecting && app.connectTarget === host.alias}
              <span class="spinner" aria-label="Connecting">⟳</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="divider"></div>
  <QuickConnect />
</div>

<style>
  .host-list {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .filter {
    margin: 8px 10px;
    background: var(--bg-alt);
    border: 1px solid var(--border);
    color: var(--fg-strong);
    padding: 5px 7px;
    border-radius: 3px;
    font: inherit;
  }
  .entries {
    flex: 1;
    overflow-y: auto;
    min-height: 60px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    position: relative;
    display: flex;
    align-items: center;
  }
  .host {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    background: transparent;
    border: none;
    color: var(--fg);
    text-align: left;
    padding: 6px 10px;
    cursor: pointer;
    font: inherit;
    min-width: 0;
  }
  .host:hover {
    background: var(--bg-hover);
  }
  .host:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .alias {
    color: var(--fg-strong);
    font-weight: 600;
  }
  .detail {
    color: var(--muted);
    font-size: 11px;
  }
  .warn {
    color: var(--warn);
    font-size: 10px;
  }
  .spinner {
    position: absolute;
    right: 10px;
    animation: spin 1s linear infinite;
    color: var(--accent);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .state {
    padding: 12px 10px;
    font-size: 12px;
  }
  .muted {
    color: var(--muted);
  }
  .error {
    color: var(--danger);
  }
  .divider {
    border-top: 1px solid var(--border);
    margin-top: 4px;
  }
</style>
