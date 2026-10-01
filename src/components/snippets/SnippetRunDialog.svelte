<script lang="ts">
  // Variable form for running a snippet (§13.4.N): one field per variable,
  // live preview, then Run (active terminal) / Run in new terminal / Insert / Copy.
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { snippetUi, execute, type RunMode } from "./runner.svelte";
  import { extractVariables, initialValues, parseTemplate, renderTemplate } from "./template";

  let values = $state<Record<string, string>>({});
  let initFor: unknown = null;

  const snippet = $derived(snippetUi.run?.snippet ?? null);
  const tokens = $derived(snippet ? parseTemplate(snippet.cmd) : []);
  const vars = $derived(extractVariables(tokens));
  const preview = $derived(renderTemplate(tokens, values, snippetUi.run?.builtins ?? {}));

  $effect(() => {
    // (Re)initialise the form whenever a new run request opens.
    const r = snippetUi.run;
    if (!r) {
      initFor = null;
      return;
    }
    if (initFor === r) return;
    initFor = r;
    values = initialValues(extractVariables(parseTemplate(r.snippet.cmd)), r.snippet.lastValues);
  });

  function close(): void {
    snippetUi.run = null;
  }

  async function go(mode: RunMode): Promise<void> {
    if (!snippet) return;
    const ok = await execute(snippet, preview, mode, { ...values });
    if (ok) close();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void go(e.ctrlKey ? "new" : "run");
    }
  }
</script>

<Dialog.Root open={snippetUi.run !== null} onOpenChange={(o) => !o && close()}>
  <Dialog.Content class="sm:max-w-lg" data-testid="snippet-run-dialog">
    <Dialog.Header>
      <Dialog.Title>{snippet?.name || "Run snippet"}</Dialog.Title>
      <Dialog.Description>
        {snippet?.description || "Fill in the variables, then run. Enter runs in the active terminal, Ctrl+Enter in a new one."}
      </Dialog.Description>
    </Dialog.Header>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="flex flex-col gap-3" onkeydown={onKey}>
      {#each vars as v (v.name)}
        <label class="flex flex-col gap-1 text-xs">
          <span class="font-medium text-muted-foreground">{v.name}</span>
          {#if v.options}
            <select
              class="h-8 rounded-md border border-input bg-background px-2 text-xs"
              data-testid="snippet-field"
              data-var={v.name}
              bind:value={values[v.name]}
            >
              {#each v.options as o (o)}
                <option value={o}>{o}</option>
              {/each}
            </select>
          {:else}
            <Input
              class="h-8 font-mono text-xs"
              data-testid="snippet-field"
              data-var={v.name}
              spellcheck="false"
              autocomplete="off"
              bind:value={values[v.name]}
            />
          {/if}
        </label>
      {/each}

      <div class="flex flex-col gap-1">
        <span class="text-xs font-medium text-muted-foreground">Preview</span>
        <pre
          class="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs break-all whitespace-pre-wrap"
          data-testid="snippet-preview">{preview}</pre>
      </div>
    </div>

    <Dialog.Footer class="flex-wrap gap-1.5 sm:justify-between">
      <div class="flex gap-1.5">
        <Button variant="outline" size="sm" data-testid="snippet-copy" onclick={() => void go("copy")}>Copy</Button>
        <Button variant="outline" size="sm" data-testid="snippet-insert" onclick={() => void go("insert")}>Insert</Button>
      </div>
      <div class="flex gap-1.5">
        <Button variant="outline" size="sm" data-testid="snippet-run-new" onclick={() => void go("new")}>
          Run in new terminal
        </Button>
        <Button size="sm" data-testid="snippet-run" onclick={() => void go("run")}>Run in active terminal</Button>
      </div>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
