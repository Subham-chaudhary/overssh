<script lang="ts">
  // Create / edit snippet dialog with template help (§13.4.N).
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { createSnippet, updateSnippet } from "../../lib/history.svelte";
  import { snippetUi, currentHost } from "./runner.svelte";
  import { extractVariables, parseTemplate, usedBuiltins } from "./template";

  let name = $state("");
  let cmd = $state("");
  let description = $state("");
  let folder = $state("");
  let tags = $state("");
  let scope = $state<"host" | "all">("all");
  let initFor: unknown = null;

  const editing = $derived(snippetUi.edit?.snippet ?? null);
  const host = $derived(editing?.host ?? currentHost());
  const detected = $derived(extractVariables(parseTemplate(cmd)));
  const builtinsUsed = $derived(usedBuiltins(parseTemplate(cmd)));

  $effect(() => {
    const e = snippetUi.edit;
    if (!e) {
      initFor = null;
      return;
    }
    if (initFor === e) return;
    initFor = e;
    const src = e.snippet ?? e.prefill ?? {};
    name = src.name ?? "";
    cmd = src.cmd ?? "";
    description = src.description ?? "";
    folder = src.folder ?? "";
    tags = (src.tags ?? []).join(", ");
    scope = src.scope ?? (currentHost() ? "host" : "all");
  });

  function close(): void {
    snippetUi.edit = null;
  }

  function save(): void {
    if (!cmd.trim()) return;
    const data = {
      name,
      cmd,
      description,
      folder,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      scope: scope === "host" && host ? ("host" as const) : ("all" as const),
      host: scope === "host" && host ? host : undefined,
    };
    if (editing) updateSnippet(editing.id, data);
    else createSnippet(data);
    close();
  }
</script>

<Dialog.Root open={snippetUi.edit !== null} onOpenChange={(o) => !o && close()}>
  <Dialog.Content class="sm:max-w-xl" data-testid="snippet-edit-dialog">
    <Dialog.Header>
      <Dialog.Title>{editing ? "Edit snippet" : "New snippet"}</Dialog.Title>
      <Dialog.Description>A command template you can run with one click.</Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-col gap-3 text-xs">
      <label class="flex flex-col gap-1">
        <span class="font-medium text-muted-foreground">Name (optional)</span>
        <Input class="h-8 text-xs" bind:value={name} data-testid="snippet-name" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="font-medium text-muted-foreground">Command template</span>
        <textarea
          class="min-h-20 rounded-md border border-input bg-background p-2 font-mono text-xs"
          spellcheck="false"
          bind:value={cmd}
          data-testid="snippet-cmd"
          placeholder={"kubectl logs {{pod}} -n {{ns:default}}"}
        ></textarea>
      </label>
      <div class="rounded-md border border-border bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground">
        <div>
          <code>{"{{name}}"}</code> text field, <code>{"{{name:default}}"}</code> with a default,
          <code>{"{{name|a|b}}"}</code> choice list.
        </div>
        <div>
          Built-ins: <code>{"{{host}}"}</code> <code>{"{{user}}"}</code> <code>{"{{cwd}}"}</code>
          <code>{"{{clipboard}}"}</code> <code>{"{{date}}"}</code>. Use <code>{"\\{{"}</code> for a literal
          <code>{"{{"}</code>. The same name used twice is asked once.
        </div>
        {#if detected.length || builtinsUsed.length}
          <div class="mt-1 text-foreground" data-testid="snippet-detected">
            Variables: {detected.map((v) => v.name).join(", ") || "none"}{builtinsUsed.length
              ? ` · built-ins: ${builtinsUsed.join(", ")}`
              : ""}
          </div>
        {/if}
      </div>
      <label class="flex flex-col gap-1">
        <span class="font-medium text-muted-foreground">Description</span>
        <Input class="h-8 text-xs" bind:value={description} />
      </label>
      <div class="grid grid-cols-2 gap-3">
        <label class="flex flex-col gap-1">
          <span class="font-medium text-muted-foreground">Folder</span>
          <Input class="h-8 text-xs" bind:value={folder} placeholder="e.g. kubernetes" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="font-medium text-muted-foreground">Tags (comma separated)</span>
          <Input class="h-8 text-xs" bind:value={tags} />
        </label>
      </div>
      <label class="flex flex-col gap-1">
        <span class="font-medium text-muted-foreground">Available on</span>
        <select
          class="h-8 rounded-md border border-input bg-background px-2 text-xs"
          bind:value={scope}
          data-testid="snippet-scope"
        >
          <option value="all">All hosts</option>
          <option value="host" disabled={!host}>{host ? `Only ${host}` : "This host (connect first)"}</option>
        </select>
      </label>
    </div>

    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={close}>Cancel</Button>
      <Button size="sm" data-testid="snippet-save" disabled={!cmd.trim()} onclick={save}>Save</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
