<script lang="ts">
  // Strip shown in the main window while the terminal panel lives in its own window.
  import { terminalStore } from "../lib/terminal.svelte";
  import SquareTerminalIcon from "@lucide/svelte/icons/square-terminal";
</script>

<div
  class="flex h-7 flex-none items-center gap-2 border-b border-border bg-sidebar px-3 text-[12px] text-muted-foreground"
  data-testid="terminal-detached-bar"
>
  <SquareTerminalIcon size={14} />
  <span>
    Terminals are in a separate window
    {#if terminalStore.tabs.length > 0}
      ({terminalStore.tabs.length})
    {/if}
  </span>
  <button
    type="button"
    class="ml-auto rounded px-2 py-0.5 hover:bg-accent hover:text-foreground"
    data-testid="terminal-focus-window"
    onclick={() => terminalStore.focusWindow()}
  >
    Show window
  </button>
  <button
    type="button"
    class="rounded px-2 py-0.5 text-foreground hover:bg-accent"
    data-testid="terminal-dock-back"
    onclick={() => void terminalStore.dock()}
  >
    Dock back
  </button>
</div>
