<script lang="ts">
  // Command palette (Ctrl+Shift+P), built on shadcn's Command component and a
  // small extensible registry (src/lib/commands.svelte.ts) — other modules
  // (P3's editor, P5's terminal) can `registerCommand()` more entries later.
  // "Preferences: Color Theme" is a registered command (App.svelte) that closes
  // the palette and opens the ThemePicker quick pick (docs/GUIDE.md §14.4.Z).
  //
  // `!` command mode (docs/GUIDE.md §12 item 12): typing `!` as the first
  // character of the search box switches the list to "run on host" mode —
  // the literal typed command first, then matching history suggestions for
  // the active session's host. Enter opens a *new* terminal (never writes
  // into an existing one, per §12 item 13) via `terminalStore.openNew` and
  // records the command in history. Deleting the `!` returns to normal mode
  // automatically (it's a plain derived check on the input's text).
  import { onMount } from "svelte";
  import { app } from "../lib/stores.svelte";
  import { commandRegistry } from "../lib/commands.svelte";
  import { terminalStore } from "../lib/terminal.svelte";
  import { loadHistory, record as recordCommand, search as searchHistory } from "../lib/history.svelte";
  import * as Command from "$lib/components/ui/command/index.js";
  import { Kbd } from "$lib/components/ui/kbd/index.js";
  import TerminalIcon from "@lucide/svelte/icons/square-terminal";
  import HistoryIcon from "@lucide/svelte/icons/history";

  let query = $state("");

  onMount(() => {
    void loadHistory();
  });

  const grouped = $derived.by(() => {
    const groups = new Map<string, (typeof commandRegistry)[number][]>();
    for (const cmd of commandRegistry) {
      const key = cmd.category ?? "General";
      const list = groups.get(key);
      if (list) list.push(cmd);
      else groups.set(key, [cmd]);
    }
    return [...groups.entries()];
  });

  const sshMode = $derived(query.startsWith("!"));
  const sshCommandRaw = $derived(query.slice(1));
  const sshCommandTrimmed = $derived(sshCommandRaw.trim());
  const sshSession = $derived(app.activeSession);
  const sshHost = $derived(sshSession ? `${sshSession.user}@${sshSession.hostname}` : "");
  const sshSuggestions = $derived(
    (sshSession
      ? sshCommandTrimmed
        ? searchHistory(sshCommandTrimmed, "host", sshHost).filter((e) => e.cmd !== sshCommandTrimmed)
        : searchHistory("", "host", sshHost)
      : []
    ).slice(0, 20),
  );

  function resetPaletteState(): void {
    query = "";
  }

  function closePalette(): void {
    app.showPalette = false;
    resetPaletteState();
  }

  function runCommand(run: () => void): void {
    run();
    closePalette();
  }

  /** §12 item 12/13: always opens a *new* terminal — never writes into an
   * existing one — and records the command against the active host. */
  async function runSshCommand(command: string): Promise<void> {
    const trimmed = command.trim();
    const session = sshSession;
    if (!trimmed || !session) return;
    const host = `${session.user}@${session.hostname}`;
    closePalette();
    await terminalStore.openNew(session.id, {
      command: trimmed,
      title: trimmed,
      cwd: app.activeExplorer?.cwd,
    });
    recordCommand(host, trimmed);
  }

  function onOpenChange(isOpen: boolean): void {
    app.showPalette = isOpen;
    if (!isOpen) resetPaletteState();
  }

  /** Item 8 fix: bits-ui's own Escape handling can get stuck (a stray escape
   * layer elsewhere in the app — e.g. a hovered Tooltip — can end up
   * "responsible" for Escape instead of this dialog, see docs/GUIDE.md §12
   * item 8). A capture-phase window listener guarantees Escape always closes
   * the palette regardless of that internal state: it runs before bits-ui's own document-level listener and, since it
   * stops propagation, that listener never even sees the event. */
  function onWindowKeydownCapture(e: KeyboardEvent): void {
    if (!app.showPalette) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      app.showPalette = false;
      resetPaletteState();
    }
  }
</script>

<svelte:window onkeydowncapture={onWindowKeydownCapture} />

<Command.Dialog
  bind:open={app.showPalette}
  shouldFilter={!sshMode}
  {onOpenChange}
  title="Command Palette"
>
  <Command.Input
    bind:value={query}
    placeholder={sshMode ? `Run on ${sshHost || "…"}… (Enter runs in a new terminal)` : "Type a command…"}
  />
  <Command.List>
    {#if sshMode}
      {#if !sshSession}
        <Command.Empty>Connect to a host first</Command.Empty>
      {:else}
        <Command.Empty>No matching command.</Command.Empty>
        <Command.Group heading={`Run on ${sshHost}`}>
          {#if sshCommandTrimmed}
            <Command.Item value={`!run:${sshCommandTrimmed}`} onSelect={() => void runSshCommand(sshCommandTrimmed)}>
              <TerminalIcon /> {sshCommandTrimmed}
              <Command.Shortcut><Kbd>Enter</Kbd></Command.Shortcut>
            </Command.Item>
          {/if}
          {#each sshSuggestions as entry (entry.cmd)}
            <Command.Item value={`!hist:${entry.cmd}`} onSelect={() => void runSshCommand(entry.cmd)}>
              <HistoryIcon class="opacity-60" /> {entry.cmd}
            </Command.Item>
          {/each}
        </Command.Group>
      {/if}
    {:else}
      <Command.Empty>No matching command.</Command.Empty>

      {#each grouped as [category, cmds] (category)}
        <Command.Group heading={category}>
          {#each cmds as cmd (cmd.id)}
            <!-- `value` (not `cmd.id`) is what bits-ui's fuzzy filter scores
                 against as you type, so it must be the visible title —
                 filtering against the dotted id would silently hide items
                 whose title doesn't happen to share letters with it. -->
            <Command.Item value={cmd.title} onSelect={() => runCommand(cmd.run)}>
              {cmd.title}
              {#if cmd.keybinding}
                <Command.Shortcut><Kbd>{cmd.keybinding}</Kbd></Command.Shortcut>
              {/if}
            </Command.Item>
          {/each}
        </Command.Group>
      {/each}
    {/if}
  </Command.List>
</Command.Dialog>
