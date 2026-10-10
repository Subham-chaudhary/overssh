<script lang="ts">
  // Manage workspace profiles (docs/GUIDE.md §15.3.P): open, rename, update from current,
  // duplicate, delete, reorder, "open at startup", and edit terminals / hosts inside a profile.
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { app } from "../../lib/stores.svelte";
  import { describeSummary } from "../../lib/profiles/model";
  import {
    duplicate,
    editTerminal,
    moveProfile,
    openSaveDialog,
    profileStore,
    removeHostEntry,
    removeProfile,
    removeTerminal,
    renameProfile,
    setOptions,
    setStartupProfile,
  } from "../../lib/profiles/profiles.svelte";
  import { openProfile } from "../../lib/profiles/restore.svelte";
  import { profileUi } from "../../lib/profiles/ui.svelte";
  import ProfileIcon from "./ProfileIcon.svelte";
  import PlayIcon from "@lucide/svelte/icons/play";
  import SaveIcon from "@lucide/svelte/icons/save";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import ChevronUpIcon from "@lucide/svelte/icons/chevron-up";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import StarIcon from "@lucide/svelte/icons/star";
  import XIcon from "@lucide/svelte/icons/x";

  let renaming = $state<string | null>(null);
  let renameValue = $state("");
  let expanded = $state<string | null>(null);

  function startRename(id: string, name: string): void {
    renaming = id;
    renameValue = name;
  }

  function commitRename(): void {
    if (renaming) renameProfile(renaming, renameValue);
    renaming = null;
  }

  async function doDelete(id: string, name: string): Promise<void> {
    const ok = await app.ask({
      title: "Delete workspace profile",
      message: `Delete “${name}”? Your hosts and files are not touched.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) removeProfile(id);
  }

  function open(id: string): void {
    profileUi.manageOpen = false;
    void openProfile(id);
  }

  function update(id: string): void {
    openSaveDialog(id);
  }
</script>

<Dialog.Root bind:open={profileUi.manageOpen}>
  <Dialog.Content class="sm:max-w-2xl" data-testid="profile-manage-dialog">
    <Dialog.Header>
      <Dialog.Title>Workspace profiles</Dialog.Title>
      <Dialog.Description>
        A profile reopens a set of hosts with their explorer folders, files, terminals and tunnels. It never stores passwords.
      </Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
      <label class="flex cursor-pointer items-center gap-1.5">
        <input type="checkbox" checked={profileStore.options.closeOthers} onchange={(e) => setOptions({ closeOthers: e.currentTarget.checked })} data-testid="manage-opt-close-others" />
        Close other workspaces when opening
      </label>
      <label class="flex cursor-pointer items-center gap-1.5">
        <input type="checkbox" checked={profileStore.options.mode === "parallel"} onchange={(e) => setOptions({ mode: e.currentTarget.checked ? "parallel" : "sequential" })} data-testid="manage-opt-parallel" />
        Restore hosts in the background while connecting
      </label>
      <Button variant="outline" size="sm" class="ml-auto h-7" onclick={() => openSaveDialog()} data-testid="manage-save-current">Save current…</Button>
    </div>

    <div class="max-h-[55vh] overflow-y-auto rounded-md border border-border" data-testid="profile-manage-list">
      {#each profileStore.profiles as p, i (p.id)}
        <div class="border-b border-border last:border-b-0" data-testid="profile-manage-row" data-profile-id={p.id} data-name={p.name}>
          <div class="flex items-center gap-2 px-2 py-1.5">
            <ProfileIcon icon={p.icon} color={p.color} size={26} />
            <div class="min-w-0 flex-1">
              {#if renaming === p.id}
                <Input
                  bind:value={renameValue}
                  class="h-7 text-[13px]"
                  maxlength={80}
                  autofocus
                  spellcheck={false}
                  data-testid="profile-rename-input"
                  onkeydown={(e) => {
                    if (e.key === "Enter") commitRename();
                    else if (e.key === "Escape") {
                      e.stopPropagation();
                      renaming = null;
                    }
                  }}
                  onblur={commitRename}
                />
              {:else}
                <button type="button" class="block max-w-full truncate text-left text-[13px] font-medium hover:underline" data-testid="profile-name" onclick={() => (expanded = expanded === p.id ? null : p.id)}>
                  {p.name}
                </button>
              {/if}
              <div class="truncate text-[11px] text-muted-foreground" data-testid="profile-summary">{describeSummary(p)}</div>
            </div>
            <button
              type="button"
              class={`rounded-sm p-1 ${profileStore.startupId === p.id ? "text-amber-500" : "text-muted-foreground hover:text-foreground"}`}
              title={profileStore.startupId === p.id ? "Opens at startup (click to turn off)" : "Open at startup"}
              aria-label={`Open ${p.name} at startup`}
              aria-pressed={profileStore.startupId === p.id}
              data-testid="profile-startup"
              onclick={() => setStartupProfile(profileStore.startupId === p.id ? null : p.id)}
            >
              <StarIcon class={`size-3.5 ${profileStore.startupId === p.id ? "fill-current" : ""}`} />
            </button>
            <button type="button" class="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30" aria-label="Move up" disabled={i === 0} data-testid="profile-up" onclick={() => moveProfile(p.id, -1)}><ChevronUpIcon class="size-3.5" /></button>
            <button type="button" class="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30" aria-label="Move down" disabled={i === profileStore.profiles.length - 1} data-testid="profile-down" onclick={() => moveProfile(p.id, 1)}><ChevronDownIcon class="size-3.5" /></button>
            <button type="button" class="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="Open" aria-label={`Open ${p.name}`} data-testid="profile-open" onclick={() => open(p.id)}><PlayIcon class="size-3.5" /></button>
            <button type="button" class="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="Rename" aria-label={`Rename ${p.name}`} data-testid="profile-rename" onclick={() => startRename(p.id, p.name)}><PencilIcon class="size-3.5" /></button>
            <button type="button" class="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30" title="Update from current" aria-label={`Update ${p.name} from current`} disabled={app.sessions.length === 0} data-testid="profile-update" onclick={() => update(p.id)}><SaveIcon class="size-3.5" /></button>
            <button type="button" class="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="Duplicate" aria-label={`Duplicate ${p.name}`} data-testid="profile-duplicate" onclick={() => duplicate(p.id)}><CopyIcon class="size-3.5" /></button>
            <button type="button" class="rounded-sm p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title="Delete" aria-label={`Delete ${p.name}`} data-testid="profile-delete" onclick={() => doDelete(p.id, p.name)}><Trash2Icon class="size-3.5" /></button>
          </div>

          {#if expanded === p.id}
            <div class="flex flex-col gap-2 bg-muted/30 px-3 py-2 text-[12px]" data-testid="profile-details">
              {#each p.hosts as h (h.id)}
                <div class="rounded-md border border-border bg-background/60 p-2" data-testid="profile-host" data-host={h.ref.name}>
                  <div class="flex items-center gap-2">
                    <span class="truncate font-medium">{h.ref.name}</span>
                    <span class="truncate text-muted-foreground">{h.ref.user ? `${h.ref.user}@` : ""}{h.ref.hostname}{h.ref.port !== 22 ? `:${h.ref.port}` : ""}</span>
                    {#if h.tunnelOnly}<span class="rounded bg-muted px-1 text-[10px] text-muted-foreground">tunnel only</span>{/if}
                    <button type="button" class="ml-auto rounded-sm p-0.5 text-muted-foreground hover:text-destructive" aria-label={`Remove ${h.ref.name} from profile`} data-testid="profile-host-remove" onclick={() => removeHostEntry(p.id, h.id)}><XIcon class="size-3.5" /></button>
                  </div>
                  {#if h.explorer}
                    <div class="mt-1 text-muted-foreground">Explorer: {h.explorer.panes.map((x) => x.cwd).join("  |  ")}</div>
                  {/if}
                  {#if h.files.length > 0}
                    <div class="mt-0.5 truncate text-muted-foreground" title={h.files.map((f) => f.path).join("\n")}>{h.files.length} open file{h.files.length === 1 ? "" : "s"}</div>
                  {/if}
                  {#if h.forwards.length > 0}
                    <div class="mt-0.5 truncate text-muted-foreground">Tunnels: {h.forwards.map((f) => f.label || `${f.bindPort}`).join(", ")}</div>
                  {/if}
                  {#each h.terminals as t, ti (ti)}
                    <div class="mt-1 flex items-center gap-1.5" data-testid="profile-terminal">
                      <span class="w-14 flex-none text-muted-foreground">Terminal {ti + 1}</span>
                      <Input class="h-6 w-24 text-[11px]" placeholder="Title" value={t.title ?? ""} spellcheck={false} onchange={(e) => editTerminal(p.id, h.id, ti, { title: e.currentTarget.value.trim() || null })} />
                      <Input class="h-6 flex-1 text-[11px]" placeholder="Start folder" value={t.cwd ?? ""} spellcheck={false} onchange={(e) => { const v = e.currentTarget.value.trim(); editTerminal(p.id, h.id, ti, { cwd: v.startsWith("/") ? v : null }); }} />
                      <Input class="h-6 flex-1 text-[11px]" placeholder="Startup command" value={t.command ?? ""} spellcheck={false} data-testid="profile-terminal-command" onchange={(e) => editTerminal(p.id, h.id, ti, { command: e.currentTarget.value.trim() || null })} />
                      <button type="button" class="rounded-sm p-0.5 text-muted-foreground hover:text-destructive" aria-label={`Remove terminal ${ti + 1}`} onclick={() => removeTerminal(p.id, h.id, ti)}><XIcon class="size-3.5" /></button>
                    </div>
                  {/each}
                </div>
              {/each}
              {#if p.terminals.detached}
                <div class="text-muted-foreground">Terminals open in their own window{p.terminals.layout ? " with a split layout" : ""}.</div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
      {#if profileStore.profiles.length === 0}
        <div class="px-4 py-8 text-center text-[13px] text-muted-foreground" data-testid="profile-manage-empty">
          No workspace profiles yet. Connect to your hosts, arrange your workspace, then choose “Save current…”.
        </div>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
