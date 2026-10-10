<script lang="ts">
  // Generic modal used for every text prompt / confirm in the app (replaces
  // window.prompt / window.confirm / window.alert). Driven by `app.ask()`
  // (src/lib/stores.svelte.ts) and mounted from PromptDialog.svelte. A text
  // prompt renders as a shadcn Dialog; a plain yes/no confirm renders as an
  // AlertDialog (Escape / overlay click cancels either way).
  import { app } from "../lib/stores.svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";

  const req = $derived(app.dialogRequest);
  let value = $state("");
  let inputRef = $state<HTMLInputElement | null>(null);

  $effect(() => {
    value = req?.input?.value ?? "";
  });

  // shadcn's <Input> is a component, not a raw element, so a `use:` action
  // can't target it directly — focus/select it via its `ref` binding instead.
  $effect(() => {
    const input = req?.input;
    const el = inputRef;
    if (!input || !el) return;
    el.focus();
    if (input.selectStart !== undefined) {
      el.setSelectionRange(input.selectStart, input.selectEnd ?? input.selectStart);
    } else {
      el.select();
    }
  });

  /** Inline validation (e.g. file names): shown under the field, blocks confirm. */
  const invalid = $derived(req?.input?.validate ? req.input.validate(value) : null);
  /** Show the message only once the user typed something (not for the empty start). */
  let touched = $state(false);
  $effect(() => {
    void req?.id;
    touched = false;
  });

  function confirm(): void {
    if (!req) return;
    if (req.input && invalid) {
      touched = true;
      return;
    }
    app.resolveDialog(req.input ? value : true);
  }

  function cancel(): void {
    if (!req) return;
    app.resolveDialog(req.input ? null : false);
  }

  function onOpenChange(isOpen: boolean): void {
    if (!isOpen) cancel();
  }
</script>

{#if req?.input}
  <Dialog.Root open={true} {onOpenChange}>
    <Dialog.Content class="sm:max-w-sm" showCloseButton={false}>
      <Dialog.Header>
        <Dialog.Title>{req.title}</Dialog.Title>
        {#if req.message}<Dialog.Description>{req.message}</Dialog.Description>{/if}
      </Dialog.Header>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <Input
          type={req.input.password ? "password" : "text"}
          bind:value
          bind:ref={inputRef}
          spellcheck="false"
          aria-invalid={touched && invalid ? "true" : undefined}
          oninput={() => (touched = true)}
        />
        {#if touched && invalid}
          <p class="mt-1.5 text-[12px] text-destructive" data-testid="input-dialog-error">{invalid}</p>
        {/if}
        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={cancel}>{req.cancelLabel}</Button>
          <Button type="submit" variant={req.danger ? "destructive" : "default"} disabled={!!invalid}
            >{req.confirmLabel}</Button
          >
        </Dialog.Footer>
      </form>
    </Dialog.Content>
  </Dialog.Root>
{:else if req}
  <AlertDialog.Root open={true} {onOpenChange}>
    <AlertDialog.Content>
      <AlertDialog.Header>
        <AlertDialog.Title>{req.title}</AlertDialog.Title>
        {#if req.message}<AlertDialog.Description>{req.message}</AlertDialog.Description>{/if}
      </AlertDialog.Header>
      <AlertDialog.Footer>
        <AlertDialog.Cancel onclick={cancel}>{req.cancelLabel}</AlertDialog.Cancel>
        <AlertDialog.Action variant={req.danger ? "destructive" : "default"} onclick={confirm}
          >{req.confirmLabel}</AlertDialog.Action
        >
      </AlertDialog.Footer>
    </AlertDialog.Content>
  </AlertDialog.Root>
{/if}
