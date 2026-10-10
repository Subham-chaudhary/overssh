<script lang="ts">
  // "Workspace profiles" section at the top of the Hosts sidebar view (docs/GUIDE.md §15.3.P).
  import { describeSummary } from "../../lib/profiles/model";
  import { hasCapturable, openSaveDialog, profileStore } from "../../lib/profiles/profiles.svelte";
  import { isOpening, openProfile } from "../../lib/profiles/restore.svelte";
  import { profileUi } from "../../lib/profiles/ui.svelte";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import ProfileIcon from "./ProfileIcon.svelte";
  import LayersIcon from "@lucide/svelte/icons/layers";
  import PlayIcon from "@lucide/svelte/icons/play";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import SettingsIcon from "@lucide/svelte/icons/settings-2";
  import StarIcon from "@lucide/svelte/icons/star";

  let collapsed = $state(false);
</script>

<div data-testid="profiles-section">
  <div class="flex items-center gap-1 px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
    <button type="button" class="flex flex-1 items-center gap-1.5 text-left uppercase" aria-expanded={!collapsed} onclick={() => (collapsed = !collapsed)} data-testid="profiles-toggle">
      <LayersIcon class="size-3" /> Workspace profiles
      <span class="font-normal normal-case" data-testid="profiles-count">{profileStore.profiles.length || ""}</span>
    </button>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button {...props} type="button" class="rounded-sm p-0.5 hover:bg-accent hover:text-foreground disabled:opacity-40" aria-label="Save current workspace as a profile" data-testid="profiles-save" onclick={() => openSaveDialog()} disabled={!hasCapturable()}>
            <PlusIcon class="size-3.5" />
          </button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>Save current workspace as profile</Tooltip.Content>
    </Tooltip.Root>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button {...props} type="button" class="rounded-sm p-0.5 hover:bg-accent hover:text-foreground" aria-label="Manage workspace profiles" data-testid="profiles-manage" onclick={() => (profileUi.manageOpen = true)}>
            <SettingsIcon class="size-3.5" />
          </button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>Manage workspace profiles</Tooltip.Content>
    </Tooltip.Root>
  </div>
  {#if !collapsed}
    {#if profileStore.profiles.length === 0}
      <div class="px-3 pb-1 text-[12px] text-muted-foreground" data-testid="profiles-empty">Save your open hosts, files and terminals to reopen them in one click.</div>
    {:else}
      <ul class="flex flex-col gap-px px-1" data-testid="profiles-list">
        {#each profileStore.profiles as p (p.id)}
          <li class="group relative flex h-8 items-center gap-1.5 rounded-sm px-2 hover:bg-accent" data-testid="profile-row" data-profile-id={p.id} data-name={p.name}>
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-2 bg-transparent text-left text-[13px] text-sidebar-foreground disabled:opacity-60"
              disabled={isOpening()}
              title={describeSummary(p)}
              onclick={() => void openProfile(p.id)}
            >
              <ProfileIcon icon={p.icon} color={p.color} size={18} />
              <span class="truncate">{p.name}</span>
              {#if profileStore.startupId === p.id}<StarIcon class="size-3 flex-none fill-current text-amber-500" aria-label="Opens at startup" />{/if}
              <span class="truncate text-[11px] text-muted-foreground">{p.hosts.length} host{p.hosts.length === 1 ? "" : "s"}</span>
            </button>
            <button
              type="button"
              class="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 disabled:opacity-30"
              aria-label={`Open ${p.name}`}
              disabled={isOpening()}
              data-testid="profile-row-open"
              onclick={() => void openProfile(p.id)}
            >
              <PlayIcon class="size-3.5" />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
