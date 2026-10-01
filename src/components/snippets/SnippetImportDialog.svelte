<script lang="ts">
  // Import snippets by pasting JSON (export copies it to the clipboard).
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { app } from "../../lib/stores.svelte";
  import { importSnippets } from "../../lib/history.svelte";
  import { snippetUi } from "./runner.svelte";

  let text = $state("");
  let error = $state("");

  $effect(() => {
    if (snippetUi.importOpen) {
      text = "";
      error = "";
    }
  });

  function doImport(): void {
    try {
      const n = importSnippets(text);
      app.addToast("success", `Imported ${n} snippet${n === 1 ? "" : "s"}`);
      snippetUi.importOpen = false;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<Dialog.Root open={snippetUi.importOpen} onOpenChange={(o) => (snippetUi.importOpen = o)}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Import snippets</Dialog.Title>
      <Dialog.Description>Paste JSON copied with "Export snippets".</Dialog.Description>
    </Dialog.Header>
    <textarea
      class="min-h-40 rounded-md border border-input bg-background p-2 font-mono text-xs"
      spellcheck="false"
      bind:value={text}
      data-testid="snippet-import-text"
    ></textarea>
    {#if error}<div class="text-xs text-destructive">{error}</div>{/if}
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (snippetUi.importOpen = false)}>Cancel</Button>
      <Button size="sm" disabled={!text.trim()} onclick={doImport} data-testid="snippet-import-go">Import</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
