<script lang="ts">
  // Shown when an action needs root and sudo cannot run without a password (§15.3.V).
  // OverSSH never asks for or stores a password: the user runs the command themselves.
  import { systemd } from "../../../lib/systemd/systemd.svelte";
  import { shortError } from "../../../lib/systemd/model";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import TerminalIcon from "@lucide/svelte/icons/square-terminal";

  const p = $derived(systemd.sudoPrompt);
  const title = $derived(
    p?.kind === "sudoPassword"
      ? "Root access needs a password"
      : p?.kind === "sudoMissing"
        ? "sudo is not installed"
        : "sudo is not allowed for this user",
  );
  const body = $derived(
    p?.kind === "sudoPassword"
      ? "This action needs root and sudo asks for a password. OverSSH never asks for or stores passwords. Run the command in a terminal and type the password there, or copy it."
      : p?.kind === "sudoMissing"
        ? "This action needs root, but sudo is not available on the host. Log in as root (for example with su) and run the command yourself."
        : "This action needs root, but your user may not run sudo on this host. Ask an administrator, or run the command as root yourself.",
  );
</script>

<Dialog.Root open={p !== null} onOpenChange={(o) => { if (!o) systemd.sudoPrompt = null; }}>
  <Dialog.Content class="max-w-lg" data-testid="svc-sudo-dialog" data-kind={p?.kind}>
    <Dialog.Header>
      <Dialog.Title data-testid="svc-sudo-title">{title}</Dialog.Title>
      <Dialog.Description>{body}</Dialog.Description>
    </Dialog.Header>
    {#if p}
      <pre class="overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-muted px-2 py-1.5 font-mono text-[12px]" data-testid="svc-sudo-command">{p.command}</pre>
      {#if p.stderr.trim()}
        <p class="truncate text-[11px] text-muted-foreground" title={p.stderr}>{shortError(p.stderr)}</p>
      {/if}
      <Dialog.Footer class="gap-2">
        <Button variant="outline" onclick={() => (systemd.sudoPrompt = null)} data-testid="svc-sudo-close">Close</Button>
        <Button variant="outline" class="gap-1" onclick={() => void systemd.copyCommand(p)} data-testid="svc-sudo-copy"><CopyIcon class="size-3.5" /> Copy command</Button>
        <Button class="gap-1" onclick={() => void systemd.runInTerminal(p)} data-testid="svc-sudo-run"><TerminalIcon class="size-3.5" /> Run in terminal</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
