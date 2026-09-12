<script lang="ts">
  // Generic modal used for every text prompt / confirm in the app (replaces
  // window.prompt / window.confirm / window.alert). Driven by `app.ask()`
  // (src/lib/stores.svelte.ts) and mounted from PromptDialog.svelte.
  import { app } from "../lib/stores.svelte";

  const req = $derived(app.dialogRequest);
  let value = $state("");

  $effect(() => {
    value = req?.input?.value ?? "";
  });

  function confirm(): void {
    if (!req) return;
    app.resolveDialog(req.input ? value : true);
  }

  function cancel(): void {
    if (!req) return;
    app.resolveDialog(req.input ? null : false);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }

  /** Focuses the input as soon as it's mounted, and selects the requested
   * range (e.g. the filename stem for rename) or the whole value otherwise. */
  function focusAndSelect(el: HTMLInputElement): void {
    el.focus();
    const input = req?.input;
    if (input?.selectStart !== undefined) {
      el.setSelectionRange(input.selectStart, input.selectEnd ?? input.selectStart);
    } else {
      el.select();
    }
  }
</script>

{#if req}
  <div class="modal-backdrop" onkeydown={onKeydown} role="presentation">
    <div class="modal" class:danger-modal={req.danger}>
      <h3>{req.title}</h3>
      {#if req.message}<p>{req.message}</p>{/if}
      <form
        onsubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        {#if req.input}
          <input
            type={req.input.password ? "password" : "text"}
            bind:value
            use:focusAndSelect
            spellcheck="false"
          />
        {/if}
        <div class="actions">
          <button type="button" onclick={cancel}>{req.cancelLabel}</button>
          <button type="submit" class="primary" class:danger={req.danger}>{req.confirmLabel}</button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 250;
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
    color: var(--fg);
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
    box-sizing: border-box;
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
  .actions button.primary.danger {
    background: var(--danger);
    border-color: var(--danger);
  }
</style>
