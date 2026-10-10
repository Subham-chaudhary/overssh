<script lang="ts">
  // Quick picker for "Workspace Profiles: Open…" (docs/GUIDE.md §15.3.P). Same look as the
  // theme picker / tab switcher: blurred backdrop, centered list, type to filter, arrows + Enter.
  import { tick, untrack } from "svelte";
  import { cn } from "$lib/utils.js";
  import { describeSummary } from "../../lib/profiles/model";
  import { profileStore, setOptions } from "../../lib/profiles/profiles.svelte";
  import { openProfile } from "../../lib/profiles/restore.svelte";
  import { profileUi } from "../../lib/profiles/ui.svelte";
  import ProfileIcon from "./ProfileIcon.svelte";
  import LayersIcon from "@lucide/svelte/icons/layers";
  import StarIcon from "@lucide/svelte/icons/star";

  let query = $state("");
  let index = $state(0);
  let input = $state<HTMLInputElement>();

  // Most recently opened first, then the saved order.
  const sorted = $derived(
    profileStore.profiles
      .map((p, i) => ({ p, i }))
      .sort((a, b) => (b.p.lastOpenedAt ?? 0) - (a.p.lastOpenedAt ?? 0) || a.i - b.i)
      .map((x) => x.p),
  );
  const flat = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? sorted.filter((p) => p.name.toLowerCase().includes(q) || p.hosts.some((h) => h.ref.name.toLowerCase().includes(q))) : sorted;
  });

  $effect(() => {
    if (!profileUi.pickerOpen) return;
    untrack(() => {
      query = "";
      index = 0;
    });
    void tick().then(() => input?.focus());
  });

  $effect(() => {
    if (!profileUi.pickerOpen) return;
    void index;
    void tick().then(() =>
      document.querySelector('[data-testid="profile-picker"] [aria-selected="true"]')?.scrollIntoView({ block: "nearest" }),
    );
  });

  function close(): void {
    profileUi.pickerOpen = false;
  }

  function commit(i = index): void {
    const p = flat[i];
    if (!p) return;
    close();
    void openProfile(p.id);
  }

  function move(delta: number): void {
    if (flat.length === 0) return;
    index = (index + delta + flat.length) % flat.length;
  }

  function onKeydownCapture(e: KeyboardEvent): void {
    if (!profileUi.pickerOpen) return;
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
    else close();
  }
</script>

<svelte:window onkeydowncapture={onKeydownCapture} />

{#if profileUi.pickerOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="motion-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/30"
    style="backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);"
    data-testid="profile-picker-backdrop"
    onmousedown={(e) => {
      if (e.target === e.currentTarget) {
        e.preventDefault();
        close();
      }
    }}
  >
    <div
      class="motion-pop w-[480px] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-primary/30"
      data-testid="profile-picker"
      role="listbox"
      aria-label="Open workspace profile"
    >
      <div class="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <LayersIcon size={16} class="text-primary" />
        <span class="text-sm font-semibold">Open workspace profile</span>
        <span class="ml-auto text-[11px] text-muted-foreground">Enter to open, Esc to cancel</span>
      </div>
      <div class="border-b border-border px-3 py-2">
        <input
          bind:this={input}
          bind:value={query}
          oninput={() => (index = 0)}
          class="w-full bg-transparent text-sm placeholder:text-muted-foreground"
          placeholder="Search workspace profiles…"
          spellcheck="false"
          data-testid="profile-picker-input"
        />
      </div>
      <div class="max-h-[55vh] overflow-y-auto p-1.5">
        {#each flat as p, i (p.id)}
          <div
            role="option"
            tabindex="-1"
            aria-selected={i === index}
            data-testid="profile-picker-item"
            data-profile-id={p.id}
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
            <ProfileIcon icon={p.icon} color={p.color} size={24} />
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5 truncate font-medium">
                {p.name}
                {#if profileStore.startupId === p.id}<StarIcon class="size-3 flex-none fill-current text-amber-500" aria-label="Opens at startup" />{/if}
              </span>
              <span class="block truncate text-[11px] text-muted-foreground">{describeSummary(p)}</span>
            </span>
          </div>
        {/each}
        {#if flat.length === 0}
          <div class="px-3 py-6 text-center text-xs text-muted-foreground" data-testid="profile-picker-empty">
            {profileStore.profiles.length === 0 ? "No workspace profiles yet. Use “Workspace Profiles: Save Current…”." : "No matching profile."}
          </div>
        {/if}
      </div>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        <label class="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={profileStore.options.closeOthers}
            onchange={(e) => setOptions({ closeOthers: e.currentTarget.checked })}
            data-testid="profile-opt-close-others"
          />
          Close other workspaces first
        </label>
        <label class="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={profileStore.options.mode === "parallel"}
            onchange={(e) => setOptions({ mode: e.currentTarget.checked ? "parallel" : "sequential" })}
            data-testid="profile-opt-parallel"
          />
          Restore hosts in the background while connecting
        </label>
      </div>
    </div>
  </div>
{/if}
