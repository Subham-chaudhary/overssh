<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { app } from "../lib/stores.svelte";

  let target = $state("");
  let identityFile = $state<string | null>(null);

  function parseTarget(value: string): { user?: string; hostname: string; port?: number } | null {
    let rest = value.trim();
    if (!rest) return null;
    let user: string | undefined;
    const at = rest.indexOf("@");
    if (at !== -1) {
      user = rest.slice(0, at) || undefined;
      rest = rest.slice(at + 1);
    }
    let port: number | undefined;
    const colon = rest.lastIndexOf(":");
    if (colon !== -1) {
      const portStr = rest.slice(colon + 1);
      const parsed = Number(portStr);
      if (portStr !== "" && Number.isInteger(parsed) && parsed > 0) {
        port = parsed;
        rest = rest.slice(0, colon);
      }
    }
    if (!rest) return null;
    return { user, hostname: rest, port };
  }

  const parsed = $derived(parseTarget(target));
  const canConnect = $derived(!!parsed && !app.connecting);

  async function browseKey(): Promise<void> {
    const path = await open({ multiple: false, title: "Select private key" });
    if (typeof path === "string") identityFile = path;
  }

  function submit(): void {
    if (!parsed) return;
    const label = parsed.user ? `${parsed.user}@${parsed.hostname}` : parsed.hostname;
    void app.connect(
      {
        hostname: parsed.hostname,
        user: parsed.user,
        port: parsed.port,
        identityFile: identityFile ?? undefined,
      },
      label,
    );
  }
</script>

<form
  class="quick-connect"
  onsubmit={(e) => {
    e.preventDefault();
    submit();
  }}
>
  <div class="title">Quick connect</div>
  <input type="text" placeholder="user@host:port" bind:value={target} spellcheck="false" />
  <div class="key-row">
    <button type="button" onclick={browseKey}>{identityFile ? "Change key…" : "Key file…"}</button>
    {#if identityFile}
      <span class="key-path" title={identityFile}>{identityFile}</span>
      <button type="button" class="clear" onclick={() => (identityFile = null)} aria-label="Clear key">
        ✕
      </button>
    {/if}
  </div>
  <button type="submit" class="connect-btn" disabled={!canConnect}>Connect</button>
</form>

<style>
  .quick-connect {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 10px 12px;
  }
  .title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }
  .quick-connect input[type="text"] {
    background: var(--bg-alt);
    border: 1px solid var(--border);
    color: var(--fg-strong);
    padding: 5px 7px;
    border-radius: 3px;
    font: inherit;
  }
  .key-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .key-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 11px;
  }
  .clear {
    padding: 0 4px;
  }
  .connect-btn {
    margin-top: 4px;
    background: var(--accent);
    color: #1e2127;
    border: none;
    padding: 6px;
    border-radius: 3px;
    font-weight: 600;
    cursor: pointer;
  }
  .connect-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
