<script lang="ts">
  import { app } from "../lib/stores.svelte";
  import InputDialog from "./InputDialog.svelte";

  let password = $state("");
  let passphrase = $state("");

  const pending = $derived(app.pendingConnect);

  function submitPassword(e: SubmitEvent): void {
    e.preventDefault();
    void app.submitConnectPrompt({ password });
    password = "";
  }

  function submitPassphrase(e: SubmitEvent): void {
    e.preventDefault();
    void app.submitConnectPrompt({ passphrase });
    passphrase = "";
  }

  function acceptHostKey(): void {
    void app.submitConnectPrompt({ acceptHostKey: true });
  }

  function cancel(): void {
    password = "";
    passphrase = "";
    app.cancelConnectPrompt();
  }

  /** Focuses the element as soon as it's mounted (avoids the `autofocus` attribute lint). */
  function focusOnMount(el: HTMLElement): void {
    el.focus();
  }
</script>

{#if pending}
  <div class="modal-backdrop">
    <div class="modal" class:danger-modal={pending.kind === "HostKeyChanged"}>
      {#if pending.kind === "NeedPassword"}
        <h3>Password required</h3>
        {#if app.connectTarget}<p class="muted">{app.connectTarget}</p>{/if}
        <form onsubmit={submitPassword}>
          <input
            type="password"
            use:focusOnMount
            bind:value={password}
            placeholder="Password"
          />
          <div class="actions">
            <button type="button" onclick={cancel}>Cancel</button>
            <button type="submit" class="primary">Connect</button>
          </div>
        </form>
      {:else if pending.kind === "NeedPassphrase"}
        <h3>Key passphrase required</h3>
        {#if pending.keyPath}<p class="muted">{pending.keyPath}</p>{/if}
        <form onsubmit={submitPassphrase}>
          <input
            type="password"
            use:focusOnMount
            bind:value={passphrase}
            placeholder="Passphrase"
          />
          <div class="actions">
            <button type="button" onclick={cancel}>Cancel</button>
            <button type="submit" class="primary">Unlock</button>
          </div>
        </form>
      {:else if pending.kind === "HostKeyUnknown"}
        <h3>Unknown host key</h3>
        <p>The authenticity of <strong>{app.connectTarget}</strong> can't be established.</p>
        {#if pending.fingerprint}<p class="fingerprint">{pending.fingerprint}</p>{/if}
        <div class="actions">
          <button type="button" onclick={cancel}>Cancel</button>
          <button type="button" class="primary" onclick={acceptHostKey}>Trust &amp; connect</button>
        </div>
      {:else if pending.kind === "HostKeyChanged"}
        <h3 class="danger-text">⚠ Host key changed</h3>
        <p class="danger-text">{pending.message}</p>
        {#if pending.fingerprint}<p class="fingerprint">{pending.fingerprint}</p>{/if}
        <p class="danger-text">
          This usually means the server was reinstalled — or someone is intercepting your
          connection. Connection refused; verify the host out-of-band before retrying.
        </p>
        <div class="actions">
          <button type="button" onclick={cancel}>Close</button>
        </div>
      {:else}
        <h3>Connection failed</h3>
        <p>{pending.message}</p>
        <div class="actions">
          <button type="button" onclick={cancel}>Close</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<InputDialog />

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }
  .modal {
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 18px 22px;
    width: 360px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .modal.danger-modal {
    border-color: var(--danger);
  }
  .modal h3 {
    margin: 0 0 10px;
    color: var(--fg-strong);
  }
  .modal p {
    margin: 6px 0;
    font-size: 12px;
  }
  .muted {
    color: var(--muted);
  }
  .danger-text {
    color: var(--danger);
  }
  .fingerprint {
    font-family: var(--font-mono);
    font-size: 11px;
    word-break: break-all;
    background: var(--bg);
    padding: 6px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
  }
  .modal input {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--fg-strong);
    padding: 6px 8px;
    border-radius: 3px;
    font: inherit;
    margin-top: 4px;
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
  .actions button.primary {
    background: var(--accent);
    color: #1e2127;
    border-color: var(--accent);
    font-weight: 600;
  }
</style>
