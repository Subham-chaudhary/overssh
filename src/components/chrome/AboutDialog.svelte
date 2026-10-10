<script lang="ts">
  // About OverSSH (Help menu). Version comes from the Tauri app config.
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import Logo from "../Logo.svelte";
  import { appVersion } from "../../lib/api";

  let { open = $bindable(false) }: { open: boolean } = $props();

  let version = $state("");
  $effect(() => {
    if (!open || version) return;
    appVersion()
      .then((v) => (version = v))
      .catch(() => (version = "dev"));
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-sm" data-testid="about-dialog">
    <Dialog.Header class="items-center text-center">
      <Logo size={72} />
      <Dialog.Title>OverSSH</Dialog.Title>
      <Dialog.Description>
        Browse, edit and open terminals on your VMs over plain SSH and SFTP. Nothing to install on the server.
      </Dialog.Description>
    </Dialog.Header>
    <p class="text-center text-xs text-muted-foreground" data-testid="about-version">Version {version || "..."}</p>
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (open = false)}>Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
