<script lang="ts">
  // "Save current as workspace profile" / "Update from current" (docs/GUIDE.md §15.3.P).
  import { toast } from "svelte-sonner";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { app } from "../../lib/stores.svelte";
  import { PROFILE_COLORS, PROFILE_ICONS, captureProfile, describeSummary, uniqueName } from "../../lib/profiles/model";
  import { captureInput, getProfile, profileStore, saveCurrent, setProfileLook, updateFromCurrent } from "../../lib/profiles/profiles.svelte";
  import { profileUi } from "../../lib/profiles/ui.svelte";
  import ProfileIcon from "./ProfileIcon.svelte";

  let name = $state("");
  let icon = $state<string | null>(null);
  let color = $state<string | null>(null);
  let picked = $state<Record<string, boolean>>({});

  const updating = $derived(profileUi.saveFor ? getProfile(profileUi.saveFor) : undefined);
  const sessionIds = $derived(app.sessions.filter((s) => picked[s.id]).map((s) => s.id));
  // What would be saved, shown as a one-line summary.
  const preview = $derived.by(() => {
    if (!profileUi.saveOpen) return "";
    try {
      return describeSummary(captureProfile(captureInput(sessionIds), { name: "preview" }));
    } catch {
      return "";
    }
  });

  $effect(() => {
    if (!profileUi.saveOpen) return;
    const p = profileUi.saveFor ? getProfile(profileUi.saveFor) : undefined;
    name = p?.name ?? uniqueName("Workspace", profileStore.profiles.map((x) => x.name));
    icon = p?.icon ?? null;
    color = p?.color ?? null;
    picked = Object.fromEntries(app.sessions.map((s) => [s.id, true]));
  });

  function save(): void {
    if (updating) {
      const p = updateFromCurrent(updating.id, sessionIds);
      if (!p) return;
      setProfileLook(updating.id, { icon, color });
      toast.success(`Updated “${p.name}”`);
    } else {
      const p = saveCurrent({ name, icon, color, sessionIds });
      if (!p) return;
      toast.success(`Saved workspace profile “${p.name}”`);
    }
    profileUi.saveOpen = false;
  }

  const canSave = $derived((sessionIds.length > 0 || app.sessions.length === 0) && name.trim().length > 0);
</script>

<Dialog.Root bind:open={profileUi.saveOpen}>
  <Dialog.Content class="sm:max-w-md" data-testid="profile-save-dialog">
    <Dialog.Header>
      <Dialog.Title>{updating ? `Update “${updating.name}” from current` : "Save workspace profile"}</Dialog.Title>
      <Dialog.Description>
        Saves your connected hosts, explorer folders, open files, terminals and running tunnels. Passwords, keys and unsaved edits are never stored.
      </Dialog.Description>
    </Dialog.Header>

    <form
      class="flex flex-col gap-3"
      onsubmit={(e) => {
        e.preventDefault();
        if (canSave) save();
      }}
    >
      <div class="flex items-center gap-2">
        <ProfileIcon {icon} {color} size={28} />
        <Input bind:value={name} placeholder="Profile name" maxlength={80} class="h-8 flex-1" spellcheck={false} data-testid="profile-save-name" />
      </div>

      <div class="flex flex-wrap gap-1" role="group" aria-label="Icon">
        {#each PROFILE_ICONS as key (key)}
          <button
            type="button"
            class={`rounded-md p-0.5 ${icon === key ? "ring-2 ring-primary" : "opacity-70 hover:opacity-100"}`}
            aria-label={`Icon ${key}`}
            aria-pressed={icon === key}
            data-testid={`profile-icon-${key}`}
            onclick={() => (icon = icon === key ? null : key)}
          >
            <ProfileIcon icon={key} {color} size={24} />
          </button>
        {/each}
      </div>
      <div class="flex flex-wrap gap-1.5" role="group" aria-label="Colour">
        {#each PROFILE_COLORS as c (c)}
          <button
            type="button"
            class={`size-5 rounded-full border border-border ${color === c ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : ""}`}
            style={`background:${c}`}
            aria-label={`Colour ${c}`}
            aria-pressed={color === c}
            data-testid="profile-color"
            onclick={() => (color = color === c ? null : c)}
          ></button>
        {/each}
      </div>

      {#if app.sessions.length > 0}
        <div class="flex flex-col gap-0.5">
          <span class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Hosts to include</span>
          {#each app.sessions as s (s.id)}
            <label class="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-accent/50">
              <Checkbox checked={picked[s.id] === true} onCheckedChange={(v) => (picked[s.id] = v === true)} data-testid="profile-save-host" />
              <span class="truncate">{s.label}</span>
              <span class="truncate text-[11px] text-muted-foreground">{s.user}@{s.hostname}</span>
            </label>
          {/each}
        </div>
      {:else}
        <p class="text-[12px] text-muted-foreground">No host is connected; only running tunnels will be saved.</p>
      {/if}

      <p class="text-[11px] text-muted-foreground" data-testid="profile-save-preview">{preview || "Nothing to save yet."}</p>

      <Dialog.Footer>
        <Button type="button" variant="outline" size="sm" onclick={() => (profileUi.saveOpen = false)}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!canSave} data-testid="profile-save-submit">{updating ? "Update" : "Save"}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
