<script lang="ts">
  import { formatShortcut } from "$lib/platform";
  // Application menu bar (docs/GUIDE.md §15.3.T): File / Edit / View / Go /
  // Terminal / Help. Click opens a menu, then hovering another title switches,
  // Left/Right moves between menus, Up/Down between items, Esc closes. Alt (tap)
  // or F10 focuses the bar from anywhere. Items run palette-registry commands.
  import { onMount } from "svelte";
  import * as Menubar from "$lib/components/ui/menubar/index.js";
  import { commandRegistry } from "../../lib/commands.svelte";
  import { buildMenus, resolveMenus, type MenuActions } from "./menus";

  let { actions }: { actions: MenuActions } = $props();

  let rootEl = $state<HTMLElement | null>(null);
  let value = $state("");

  const menus = $derived(resolveMenus(buildMenus(actions), commandRegistry));

  // --- Alt / F10 focus -------------------------------------------------------
  let altArmed = false;
  let returnFocusTo: HTMLElement | null = null;

  function inTerminal(t: EventTarget | null): boolean {
    return t instanceof Element && t.closest(".xterm") !== null;
  }
  function modalOpen(): boolean {
    return document.querySelector('[role="dialog"],[role="alertdialog"]') !== null;
  }

  function focusBar(): void {
    const first = rootEl?.querySelector<HTMLElement>('[data-slot="menubar-trigger"]');
    if (!first) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && !rootEl?.contains(active)) returnFocusTo = active;
    first.focus();
  }

  function restoreFocus(): void {
    const el = returnFocusTo;
    returnFocusTo = null;
    if (el && el.isConnected) el.focus();
    // Nothing (focusable) to go back to: just leave the bar.
    if (rootEl?.contains(document.activeElement) && document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Alt" && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
      altArmed = !e.repeat || altArmed;
      return;
    }
    altArmed = false; // Alt+<key> is a normal shortcut, not a menu tap
    if (e.key === "F10" && !e.ctrlKey && !e.shiftKey && !e.altKey && !inTerminal(e.target) && !modalOpen()) {
      e.preventDefault();
      focusBar();
    }
  }
  function onKeyup(e: KeyboardEvent): void {
    if (e.key !== "Alt") return;
    const armed = altArmed;
    altArmed = false;
    if (!armed || inTerminal(e.target) || modalOpen()) return;
    e.preventDefault(); // WebView2 would otherwise move focus to its own menu
    focusBar();
  }

  let selected = false;

  function onValueChange(v: string): void {
    // Remember where focus was when the first menu opens (click or keyboard).
    if (v !== "" && returnFocusTo === null) {
      const a = document.activeElement;
      if (a instanceof HTMLElement && !rootEl?.contains(a) && a !== document.body) returnFocusTo = a;
    } else if (v === "") {
      setTimeout(() => {
        if (!rootEl?.contains(document.activeElement)) returnFocusTo = null;
      }, 0);
    }
  }

  /** After picking an item focus goes back to what had it (editor, terminal...), not the menu title. */
  function onCloseAutoFocus(e: Event): void {
    if (!selected) return;
    selected = false;
    e.preventDefault();
    restoreFocus();
  }

  function choose(run: () => void): void {
    selected = true;
    setTimeout(run, 0);
  }

  /** Esc on a focused (closed) trigger gives focus back to where it came from. */
  function onBarKeydown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    const t = e.target as HTMLElement;
    // A focused title whose menu is closed: leave the bar. (Esc inside an open
    // menu is handled by the menu, and happens in the portaled content.)
    setTimeout(() => {
      if (t.getAttribute("data-state") !== "open" && value === "") restoreFocus();
    }, 0);
  }

  onMount(() => {
    window.addEventListener("keydown", onKeydown);
    window.addEventListener("keyup", onKeyup);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("keyup", onKeyup);
    };
  });
</script>

<Menubar.Root
  bind:ref={rootEl}
  bind:value
  {onValueChange}
  class="h-full gap-0.5"
  data-testid="menu-bar"
  aria-label="Application menu"
  onkeydown={onBarKeydown}
>
  {#each menus as menu (menu.id)}
    <Menubar.Menu value={menu.id}>
      <Menubar.Trigger data-testid={`menu-${menu.id}`}>{menu.label}</Menubar.Trigger>
      <Menubar.Content data-testid={`menu-${menu.id}-content`} {onCloseAutoFocus}>
        {#each menu.entries as entry, i (entry.kind === "item" ? entry.key : `sep-${i}`)}
          {#if entry.kind === "sep"}
            <Menubar.Separator />
          {:else}
            <Menubar.Item data-testid={entry.testid} onSelect={() => choose(entry.run)}>
              <span class="truncate">{entry.label}</span>
              {#if entry.hint}<Menubar.Shortcut>{formatShortcut(entry.hint)}</Menubar.Shortcut>{/if}
            </Menubar.Item>
          {/if}
        {/each}
      </Menubar.Content>
    </Menubar.Menu>
  {/each}
</Menubar.Root>
