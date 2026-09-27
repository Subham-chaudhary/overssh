<script lang="ts">
  // Connect-flow prompts: password / passphrase / host-key confirm, driven by
  // the `AppError.kind` from `connect` (docs/GUIDE.md §7). Password/passphrase
  // are text prompts (shadcn Dialog); host-key confirm and terminal errors are
  // yes/no-shaped (shadcn AlertDialog).
  import { app } from "../lib/stores.svelte";
  import InputDialog from "./InputDialog.svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

  let password = $state("");
  let passphrase = $state("");
  let passwordRef = $state<HTMLInputElement | null>(null);
  let passphraseRef = $state<HTMLInputElement | null>(null);

  const pending = $derived(app.pendingConnect);

  // shadcn's <Input> is a component, not a raw element, so a `use:` action
  // can't target it directly — focus it via its `ref` binding instead.
  $effect(() => {
    if (pending?.kind === "NeedPassword") passwordRef?.focus();
    else if (pending?.kind === "NeedPassphrase") passphraseRef?.focus();
  });

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

  function onOpenChange(isOpen: boolean): void {
    if (!isOpen) cancel();
  }
</script>

{#if pending?.kind === "NeedPassword"}
  <Dialog.Root open={true} {onOpenChange}>
    <Dialog.Content class="sm:max-w-sm" showCloseButton={false}>
      <Dialog.Header>
        <Dialog.Title>Password required</Dialog.Title>
        {#if pending.hop}
          <Dialog.Description data-testid="prompt-hop">
            Jump host <span class="font-mono">{pending.hop}</span> (for {app.connectTarget})
          </Dialog.Description>
        {:else if app.connectTarget}<Dialog.Description>{app.connectTarget}</Dialog.Description>{/if}
      </Dialog.Header>
      <form onsubmit={submitPassword}>
        <Input type="password" bind:ref={passwordRef} bind:value={password} placeholder="Password" />
        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={cancel}>Cancel</Button>
          <Button type="submit">Connect</Button>
        </Dialog.Footer>
      </form>
    </Dialog.Content>
  </Dialog.Root>
{:else if pending?.kind === "NeedPassphrase"}
  <Dialog.Root open={true} {onOpenChange}>
    <Dialog.Content class="sm:max-w-sm" showCloseButton={false}>
      <Dialog.Header>
        <Dialog.Title>Key passphrase required</Dialog.Title>
        {#if pending.hop}
          <Dialog.Description data-testid="prompt-hop">Jump host <span class="font-mono">{pending.hop}</span></Dialog.Description>
        {/if}
        {#if pending.keyPath}
          <Dialog.Description class="font-mono text-[11px] break-all">{pending.keyPath}</Dialog.Description>
        {/if}
      </Dialog.Header>
      <form onsubmit={submitPassphrase}>
        <Input type="password" bind:ref={passphraseRef} bind:value={passphrase} placeholder="Passphrase" />
        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={cancel}>Cancel</Button>
          <Button type="submit">Unlock</Button>
        </Dialog.Footer>
      </form>
    </Dialog.Content>
  </Dialog.Root>
{:else if pending?.kind === "HostKeyUnknown"}
  <AlertDialog.Root open={true} {onOpenChange}>
    <AlertDialog.Content>
      <AlertDialog.Header>
        <AlertDialog.Title>Unknown host key</AlertDialog.Title>
        <AlertDialog.Description>
          The authenticity of
          {#if pending.hop}jump host <strong class="text-foreground" data-testid="prompt-hop">{pending.hop}</strong>
          {:else}<strong class="text-foreground">{app.connectTarget}</strong>{/if}
          can't be established.
        </AlertDialog.Description>
      </AlertDialog.Header>
      {#if pending.fingerprint}
        <p class="rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-[11px] break-all">
          {pending.fingerprint}
        </p>
      {/if}
      <AlertDialog.Footer>
        <AlertDialog.Cancel onclick={cancel}>Cancel</AlertDialog.Cancel>
        <AlertDialog.Action onclick={acceptHostKey}>Trust &amp; connect</AlertDialog.Action>
      </AlertDialog.Footer>
    </AlertDialog.Content>
  </AlertDialog.Root>
{:else if pending?.kind === "HostKeyChanged"}
  <AlertDialog.Root open={true} {onOpenChange}>
    <AlertDialog.Content>
      <AlertDialog.Header>
        <AlertDialog.Title class="flex items-center gap-1.5 text-destructive">
          <TriangleAlertIcon class="size-4" /> Host key changed
        </AlertDialog.Title>
        <AlertDialog.Description class="text-destructive">{pending.message}</AlertDialog.Description>
      </AlertDialog.Header>
      {#if pending.fingerprint}
        <p class="rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-[11px] break-all">
          {pending.fingerprint}
        </p>
      {/if}
      <p class="text-sm text-destructive">
        This usually means the server was reinstalled — or someone is intercepting your connection.
        Connection refused; verify the host out-of-band before retrying.
      </p>
      <AlertDialog.Footer>
        <AlertDialog.Cancel onclick={cancel}>Close</AlertDialog.Cancel>
      </AlertDialog.Footer>
    </AlertDialog.Content>
  </AlertDialog.Root>
{:else if pending}
  <AlertDialog.Root open={true} {onOpenChange}>
    <AlertDialog.Content>
      <AlertDialog.Header>
        <AlertDialog.Title>Connection failed</AlertDialog.Title>
        <AlertDialog.Description>{pending.message}</AlertDialog.Description>
      </AlertDialog.Header>
      <AlertDialog.Footer>
        <AlertDialog.Cancel onclick={cancel}>Close</AlertDialog.Cancel>
      </AlertDialog.Footer>
    </AlertDialog.Content>
  </AlertDialog.Root>
{/if}

<InputDialog />
