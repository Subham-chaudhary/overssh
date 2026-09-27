<script lang="ts">
  // Ctrl+Tab switcher popup (docs/GUIDE.md §13.4.K, §14.4.W). Keys are handled by
  // App.svelte (main window) or TerminalWindow.svelte; this only renders the list
  // and handles mouse clicks. Shown as a focused modal: a blurred, slightly dimmed
  // full-window backdrop with the list centered on it.
  import { tabSwitcher } from "../lib/tabswitch.svelte";
  import { cn } from "$lib/utils.js";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import SquareTerminalIcon from "@lucide/svelte/icons/square-terminal";

  $effect(() => {
    if (!tabSwitcher.visible) return;
    document
      .querySelector('[data-testid="tab-switcher"] [aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  });

  const isTerminal = $derived(tabSwitcher.kind === "terminal");
</script>

{#if tabSwitcher.visible}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
    style="backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);"
    data-testid="tab-switcher-backdrop"
    onmousedown={(e) => {
      e.preventDefault();
      if (e.target === e.currentTarget) tabSwitcher.cancel();
    }}
  >
    <div
      class="animate-in fade-in-0 zoom-in-95 w-[480px] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-primary/30 duration-100"
      data-testid="tab-switcher"
      data-kind={tabSwitcher.kind}
      role="listbox"
      aria-label={isTerminal ? "Switch terminal" : "Switch tab"}
    >
      <div class="flex items-center gap-2 border-b border-border px-4 py-2.5">
        {#if isTerminal}
          <SquareTerminalIcon size={16} class="text-primary" />
        {:else}
          <FileTextIcon size={16} class="text-primary" />
        {/if}
        <span class="text-sm font-semibold" data-testid="tab-switcher-title">
          {isTerminal ? "Terminals" : "Files"}
        </span>
        <span class="ml-auto text-[11px] text-muted-foreground">Tab / arrows to move, release Ctrl to switch</span>
      </div>
      <div class="max-h-[60vh] overflow-y-auto p-1.5">
        {#each tabSwitcher.items as item, i (item.id)}
          <div
            role="option"
            tabindex="-1"
            aria-selected={i === tabSwitcher.index}
            data-testid="tab-switcher-item"
            class={cn(
              "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm",
              i === tabSwitcher.index ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
            )}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => tabSwitcher.select(i)}
            onkeydown={() => {}}
          >
            {#if isTerminal}
              <SquareTerminalIcon size={16} class="flex-none text-muted-foreground" />
            {:else}
              <FileTextIcon size={16} class="flex-none text-muted-foreground" />
            {/if}
            <span class="truncate">{item.title}</span>
            {#if item.dirty}
              <span class="size-2 flex-none rounded-full bg-primary" aria-label="unsaved"></span>
            {/if}
            <span class="ml-auto min-w-0 truncate text-xs text-muted-foreground" dir="rtl">
              <bdi>{item.detail}</bdi>
            </span>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
