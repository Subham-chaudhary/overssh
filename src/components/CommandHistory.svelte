<script lang="ts">
  // Sidebar "Commands" view (docs/GUIDE.md §11 "Command history" / §11.4 and
  // §13.4.N snippets). Reads/writes the shared `history` store from
  // `lib/history.svelte.ts` (capture happens in `Terminal.svelte`); this
  // component is a browser/editor over history entries and snippets, and it
  // hosts the snippet dialogs (run form, editor, picker, import).
  import { onMount } from "svelte";
  import { app } from "../lib/stores.svelte";
  import {
    loadHistory,
    search,
    searchSnippets,
    togglePin,
    remove,
    deleteSnippet,
    duplicateSnippet,
    exportSnippets,
    type HistoryScope,
  } from "../lib/history.svelte";
  import type { HistoryEntry, Snippet } from "../lib/types";
  import { snippetUi, startRun, execute, copyText } from "./snippets/runner.svelte";
  import { hasVariables } from "./snippets/template";
  import SnippetRunDialog from "./snippets/SnippetRunDialog.svelte";
  import SnippetEditDialog from "./snippets/SnippetEditDialog.svelte";
  import SnippetPicker from "./snippets/SnippetPicker.svelte";
  import SnippetImportDialog from "./snippets/SnippetImportDialog.svelte";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { ToggleGroup, ToggleGroupItem } from "$lib/components/ui/toggle-group/index.js";
  import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
  } from "$lib/components/ui/tooltip/index.js";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import CopyPlusIcon from "@lucide/svelte/icons/copy-plus";
  import PlayIcon from "@lucide/svelte/icons/play";
  import TextCursorIcon from "@lucide/svelte/icons/text-cursor";
  import PinIcon from "@lucide/svelte/icons/pin";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import UploadIcon from "@lucide/svelte/icons/upload";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import PlusIcon from "@lucide/svelte/icons/plus";

  let query = $state("");
  let scope = $state<HistoryScope>("host");

  onMount(() => {
    void loadHistory();
  });

  const currentHost = $derived(
    app.activeSession ? `${app.activeSession.user}@${app.activeSession.hostname}` : null,
  );

  function setScope(value: string | undefined): void {
    if (value === "host" || value === "all") scope = value;
    // bits-ui's single ToggleGroup can be clicked back to "" (deselected);
    // ignore that and keep whatever scope was already active.
  }

  const results = $derived.by((): HistoryEntry[] => {
    if (scope === "host") {
      return currentHost ? search(query, "host", currentHost) : [];
    }
    return search(query, "all", currentHost ?? "");
  });

  // Pinned history entries are represented by their snippet (§13.4.N).
  const snippets = $derived(searchSnippets(query, scope, currentHost));
  const recent = $derived(results.filter((e) => !e.pinned));

  function hostLabel(host: string): string {
    return app.sessions.find((s) => `${s.user}@${s.hostname}` === host)?.label ?? host;
  }

  /** §12 item 3: always opens a brand-new terminal — never writes into an
   * existing one (it might be running htop, or anything else that isn't
   * expecting input). */
  function runInTerminal(entry: HistoryEntry): void {
    void execute(null, entry.cmd, "new", {});
  }

  function snippetTitle(s: Snippet): string {
    return s.name || s.cmd.split("\n")[0];
  }

  async function exportAll(): Promise<void> {
    await copyText(exportSnippets());
  }
</script>

<TooltipProvider delayDuration={300}>
  <div class="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
    <div class="flex flex-none flex-col gap-2 border-b border-sidebar-border p-2">
      <Input placeholder="Search commands…" bind:value={query} class="h-7 text-xs" spellcheck="false" />
      <div class="flex items-center gap-1.5">
        <ToggleGroup type="single" value={scope} onValueChange={setScope} size="sm" class="flex-1">
          <ToggleGroupItem value="host" class="flex-1 text-[11px]">This host</ToggleGroupItem>
          <ToggleGroupItem value="all" class="flex-1 text-[11px]">All hosts</ToggleGroupItem>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="flex h-7 w-7 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                aria-label="New snippet"
                data-testid="snippet-new"
                onclick={() => (snippetUi.edit = { snippet: null })}
              >
                <PlusIcon size={14} />
              </button>
            {/snippet}
          </TooltipTrigger>
          <TooltipContent side="bottom">New snippet</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="flex h-7 w-7 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Import snippets"
                onclick={() => (snippetUi.importOpen = true)}
              >
                <UploadIcon size={14} />
              </button>
            {/snippet}
          </TooltipTrigger>
          <TooltipContent side="bottom">Import snippets (paste JSON)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="flex h-7 w-7 flex-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                aria-label="Export snippets"
                disabled={snippets.length === 0}
                onclick={() => void exportAll()}
              >
                <DownloadIcon size={14} />
              </button>
            {/snippet}
          </TooltipTrigger>
          <TooltipContent side="bottom">Export snippets (copies JSON)</TooltipContent>
        </Tooltip>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto">
      {#if app.sessions.length === 0 && snippets.length === 0}
        <div class="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
          Connect to a host to use command history.
        </div>
      {:else if scope === "host" && !currentHost && snippets.length === 0}
        <div class="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
          No active session.
        </div>
      {:else if recent.length === 0 && snippets.length === 0}
        <div class="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
          {query.trim() ? "No matching commands." : "No commands yet — run something in the terminal."}
        </div>
      {:else}
        {#if snippets.length > 0}
          <div class="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            Snippets
          </div>
          <ul>
            {#each snippets as snip (snip.id)}
              <li>
                {@render snippetRow(snip)}
              </li>
            {/each}
          </ul>
        {/if}
        {#if recent.length > 0}
          <div class="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            Recent
          </div>
          <ul>
            {#each recent as entry (entry.host + "\u0000" + entry.cmd)}
              <li>
                {@render row(entry)}
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>
  </div>
</TooltipProvider>

{#snippet row(entry: HistoryEntry)}
  <div
    class="group flex items-center gap-1.5 px-2 py-1 hover:bg-accent"
    data-testid="history-row"
    data-cmd={entry.cmd}
  >
    <div class="min-w-0 flex-1">
      <div class="truncate font-mono text-[12px] text-sidebar-foreground" title={entry.cmd}>
        {entry.cmd}
      </div>
      <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
        {#if scope === "all"}
          <Badge variant="outline" class="text-[9px] font-normal">{hostLabel(entry.host)}</Badge>
        {/if}
        <span>×{entry.count}</span>
      </div>
    </div>
    <div class="flex flex-none items-center gap-0.5 opacity-0 group-hover:opacity-100">
      <Tooltip>
        <TooltipTrigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
              aria-label="Copy"
              onclick={() => void copyText(entry.cmd)}
            >
              <CopyIcon size={12} />
            </button>
          {/snippet}
        </TooltipTrigger>
        <TooltipContent side="bottom">Copy</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
              aria-label="Insert"
              onclick={() => void execute(null, entry.cmd, "insert", {})}
            >
              <TextCursorIcon size={12} />
            </button>
          {/snippet}
        </TooltipTrigger>
        <TooltipContent side="bottom">Insert (no Enter)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
              aria-label="Run in terminal"
              data-testid="history-run"
              onclick={() => runInTerminal(entry)}
            >
              <PlayIcon size={12} />
            </button>
          {/snippet}
        </TooltipTrigger>
        <TooltipContent side="bottom">Run in terminal</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
              aria-label="Pin as snippet"
              onclick={() => togglePin(entry.host, entry.cmd)}
            >
              <PinIcon size={12} />
            </button>
          {/snippet}
        </TooltipTrigger>
        <TooltipContent side="bottom">Pin as snippet</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="rounded p-1 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
              aria-label="Delete"
              onclick={() => remove(entry.host, entry.cmd)}
            >
              <Trash2Icon size={12} />
            </button>
          {/snippet}
        </TooltipTrigger>
        <TooltipContent side="bottom">Delete</TooltipContent>
      </Tooltip>
    </div>
  </div>
{/snippet}

{#snippet snipBtn(label: string, testid: string | undefined, danger: boolean, onclick: () => void, icon: typeof PlayIcon)}
  {@const Icon = icon}
  <Tooltip>
    <TooltipTrigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class={`rounded p-1 text-muted-foreground ${danger ? "hover:bg-destructive/20 hover:text-destructive" : "hover:bg-background hover:text-foreground"}`}
          aria-label={label}
          data-testid={testid}
          {onclick}
        >
          <Icon size={12} />
        </button>
      {/snippet}
    </TooltipTrigger>
    <TooltipContent side="bottom">{label}</TooltipContent>
  </Tooltip>
{/snippet}

{#snippet snippetRow(snip: Snippet)}
  <div
    class="group flex items-center gap-1.5 px-2 py-1 hover:bg-accent"
    data-testid="snippet-row"
    data-cmd={snip.cmd}
  >
    <button
      type="button"
      class="min-w-0 flex-1 cursor-pointer text-left"
      title={snip.description || snip.cmd}
      onclick={() => void startRun(snip, "run")}
    >
      <div class="truncate text-[12px] text-sidebar-foreground {snip.name ? '' : 'font-mono'}">
        {snippetTitle(snip)}
      </div>
      {#if snip.name}
        <div class="truncate font-mono text-[10px] text-muted-foreground">{snip.cmd}</div>
      {/if}
      <div class="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
        {#if hasVariables(snip.cmd)}<Badge variant="secondary" class="text-[9px] font-normal">vars</Badge>{/if}
        {#if snip.folder}<Badge variant="outline" class="text-[9px] font-normal">{snip.folder}</Badge>{/if}
        {#if snip.scope === "host" && scope === "all" && snip.host}
          <Badge variant="outline" class="text-[9px] font-normal">{hostLabel(snip.host)}</Badge>
        {/if}
        {#each snip.tags as tag (tag)}<span>#{tag}</span>{/each}
        {#if snip.useCount > 0}<span>x{snip.useCount}</span>{/if}
      </div>
    </button>
    <div class="flex flex-none items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
      {@render snipBtn("Run snippet", "snippet-run-row", false, () => void startRun(snip, "run"), PlayIcon)}
      {@render snipBtn("Insert snippet", undefined, false, () => void startRun(snip, "insert"), TextCursorIcon)}
      {@render snipBtn("Copy snippet", undefined, false, () => void startRun(snip, "copy"), CopyIcon)}
      {@render snipBtn("Edit snippet", "snippet-edit", false, () => (snippetUi.edit = { snippet: snip }), PencilIcon)}
      {@render snipBtn("Duplicate snippet", undefined, false, () => void duplicateSnippet(snip.id), CopyPlusIcon)}
      {@render snipBtn("Delete snippet", "snippet-delete", true, () => deleteSnippet(snip.id), Trash2Icon)}
    </div>
  </div>
{/snippet}

<SnippetRunDialog />
<SnippetEditDialog />
<SnippetPicker />
<SnippetImportDialog />
