<script lang="ts">
  // Colour-theme quick picker (Ctrl+Alt+T, "Preferences: Color Theme") —
  // docs/GUIDE.md §14.4.Z. Same look as TabSwitcher: a blurred, dimmed
  // full-window backdrop with the list centered on it. Arrow keys move and
  // live-preview the theme, Enter keeps it, Esc (or a click outside) restores
  // the theme that was active when the picker opened.
  import { tick, untrack } from "svelte";
  import { settings } from "../lib/settings.svelte";
  import { hintThemeFade } from "../lib/motion";
  import { THEME_LIST, type ThemeDef, type ThemeId } from "../lib/themes";
  import { themeSwatches } from "../lib/appearance";
  import { themePicker, closeThemePicker } from "../lib/themepicker.svelte";
  import { cn } from "$lib/utils.js";
  import PaletteIcon from "@lucide/svelte/icons/palette";
  import CheckIcon from "@lucide/svelte/icons/check";

  let query = $state("");
  let index = $state(0);
  let original = $state<ThemeId>(settings.theme);
  let committed = false;
  let input = $state<HTMLInputElement>();

  // Dark first, then light; filtered by the search box. `flat` keeps the
  // keyboard order identical to what is drawn.
  const groups = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const match = (t: ThemeDef) => q === "" || t.label.toLowerCase().includes(q) || t.id.includes(q);
    return [
      { label: "Dark", themes: THEME_LIST.filter((t) => t.isDark && match(t)) },
      { label: "Light", themes: THEME_LIST.filter((t) => !t.isDark && match(t)) },
    ].filter((g) => g.themes.length > 0);
  });
  const flat = $derived(groups.flatMap((g) => g.themes));

  // Reset state each time the picker opens (untracked: only `open` is a trigger).
  $effect(() => {
    if (!themePicker.open) return;
    untrack(() => {
      original = settings.theme;
      committed = false;
      query = "";
      index = Math.max(0, flat.findIndex((t) => t.id === original));
    });
    void tick().then(() => input?.focus());
  });

  // Live-preview the highlighted row and keep it in view.
  $effect(() => {
    if (!themePicker.open) return;
    const t = flat[index];
    if (t && untrack(() => settings.theme) !== t.id) {
      hintThemeFade();
      settings.theme = t.id;
    }
    void tick().then(() =>
      document.querySelector('[data-testid="theme-picker"] [aria-selected="true"]')?.scrollIntoView({ block: "nearest" }),
    );
  });

  function move(delta: number): void {
    if (flat.length === 0) return;
    index = (index + delta + flat.length) % flat.length;
  }

  function commit(i = index): void {
    const t = flat[i];
    if (t) settings.theme = t.id;
    committed = true;
    closeThemePicker();
  }

  function cancel(): void {
    if (!committed) {
      hintThemeFade();
      settings.theme = original;
    }
    closeThemePicker();
  }

  function onKeydownCapture(e: KeyboardEvent): void {
    if (!themePicker.open) return;
    // The palette's close can steal focus back after we open; type-to-filter anyway.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) input?.focus();
    const handled = ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape", "Tab"];
    if (!handled.includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) move(1);
    else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) move(-1);
    else if (e.key === "Home") index = 0;
    else if (e.key === "End") index = Math.max(0, flat.length - 1);
    else if (e.key === "Enter") commit();
    else cancel();
  }
</script>

<svelte:window onkeydowncapture={onKeydownCapture} />

{#if themePicker.open}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="motion-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/30"
    style="backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);"
    data-testid="theme-picker-backdrop"
    onmousedown={(e) => {
      if (e.target === e.currentTarget) {
        e.preventDefault();
        cancel();
      }
    }}
  >
    <div
      class="motion-pop w-[480px] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-primary/30"
      data-testid="theme-picker"
      role="listbox"
      aria-label="Color theme"
    >
      <div class="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <PaletteIcon size={16} class="text-primary" />
        <span class="text-sm font-semibold">Color Theme</span>
        <span class="ml-auto text-[11px] text-muted-foreground">Arrows to preview, Enter to apply, Esc to cancel</span>
      </div>
      <div class="border-b border-border px-3 py-2">
        <input
          bind:this={input}
          bind:value={query}
          oninput={() => (index = 0)}
          class="w-full bg-transparent text-sm placeholder:text-muted-foreground"
          placeholder="Search themes…"
          spellcheck="false"
          data-testid="theme-picker-input"
        />
      </div>
      <div class="max-h-[55vh] overflow-y-auto p-1.5">
        {#each groups as group (group.label)}
          <div class="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{group.label}</div>
          {#each group.themes as theme (theme.id)}
            {@const i = flat.indexOf(theme)}
            <div
              role="option"
              tabindex="-1"
              aria-selected={i === index}
              data-testid="theme-picker-item"
              data-theme-id={theme.id}
              class={cn(
                "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm",
                i === index ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
              )}
              onmousedown={(e) => e.preventDefault()}
              onmousemove={() => {
                if (index !== i) index = i;
              }}
              onclick={() => commit(i)}
              onkeydown={() => {}}
            >
              <span class="truncate">{theme.label}</span>
              {#if theme.id === original}
                <CheckIcon size={13} class="flex-none text-muted-foreground" aria-label="current theme" />
              {/if}
              <span class="ml-auto flex flex-none overflow-hidden rounded-sm border border-border/80" aria-hidden="true">
                {#each themeSwatches(theme) as color, k (k)}
                  <span class="h-4 w-3.5" style={`background:${color}`}></span>
                {/each}
              </span>
            </div>
          {/each}
        {/each}
        {#if flat.length === 0}
          <div class="px-3 py-6 text-center text-xs text-muted-foreground">No matching theme.</div>
        {/if}
      </div>
    </div>
  </div>
{/if}
