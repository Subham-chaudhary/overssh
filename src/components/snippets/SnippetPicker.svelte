<script lang="ts">
  // Quick picker for "Snippets: Run Snippet…" (palette), reusing shadcn Command.
  import * as Command from "$lib/components/ui/command/index.js";
  import { searchSnippets } from "../../lib/history.svelte";
  import { snippetUi, currentHost, startRun } from "./runner.svelte";
  import type { Snippet } from "../../lib/types";

  const list = $derived(snippetUi.picker ? searchSnippets("", "host", currentHost()) : []);

  function label(s: Snippet): string {
    return s.name || s.cmd.split("\n")[0];
  }

  function pick(s: Snippet): void {
    snippetUi.picker = false;
    void startRun(s);
  }
</script>

<Command.Dialog bind:open={snippetUi.picker} title="Run snippet" description="Pick a snippet to run">
  <Command.Input placeholder="Search snippets…" data-testid="snippet-picker-input" />
  <Command.List>
    <Command.Empty>No snippets. Create one in the Commands view.</Command.Empty>
    {#each list as s (s.id)}
      <Command.Item
        value={`${label(s)} ${s.cmd} ${s.tags.join(" ")} ${s.id}`}
        onSelect={() => pick(s)}
        data-testid="snippet-picker-item"
      >
        <div class="flex min-w-0 flex-col">
          <span class="truncate">{label(s)}</span>
          {#if s.name}<span class="truncate font-mono text-[10px] text-muted-foreground">{s.cmd}</span>{/if}
        </div>
      </Command.Item>
    {/each}
  </Command.List>
</Command.Dialog>
