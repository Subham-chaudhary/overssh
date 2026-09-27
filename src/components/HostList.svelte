<script lang="ts">
  // Hosts sidebar: Paused / Pinned / Saved / SSH config (docs/GUIDE.md §11
  // "Host profiles", §12 hosts redesign). Pure view over `hostStore`
  // (src/lib/hosts.svelte.ts) — this component never triggers a load itself;
  // `hostStore` is loaded exactly once, self-triggered by that module.
  // Clicking a row opens the connect form prefilled from it; the small
  // chevron connects immediately (same as a double-click), skipping the form.
  import { app } from "../lib/stores.svelte";
  import {
    hostStore,
    filteredItems,
    refreshConfigHosts,
    setPinned,
    renameHost,
    removeHost,
    type HostItem,
  } from "../lib/hosts.svelte";
  import QuickConnect from "./QuickConnect.svelte";
  import ConnectDialog, { type ConnectFormInitial } from "./ConnectDialog.svelte";
  import Loader from "./Loader.svelte";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import ServerIcon from "@lucide/svelte/icons/server";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import PinIcon from "@lucide/svelte/icons/pin";
  import PinOffIcon from "@lucide/svelte/icons/pin-off";
  import BookmarkIcon from "@lucide/svelte/icons/bookmark";
  import SettingsIcon from "@lucide/svelte/icons/settings-2";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import MoreHorizontalIcon from "@lucide/svelte/icons/more-horizontal";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import PlugZapIcon from "@lucide/svelte/icons/plug-zap";
  import PauseIcon from "@lucide/svelte/icons/pause";
  import PlayIcon from "@lucide/svelte/icons/play";
  import XIcon from "@lucide/svelte/icons/x";
  import type { PausedSession } from "../lib/stores.svelte";

  const filter = $derived(hostStore.filter.trim().toLowerCase());
  const filtered = $derived(filteredItems());
  const pinned = $derived(filtered.filter((h) => h.source === "saved" && h.pinned));
  const saved = $derived(filtered.filter((h) => h.source === "saved" && !h.pinned));
  const configHosts = $derived(filtered.filter((h) => h.source === "config"));

  // --- connect form dialog (shared for ssh-config hosts + saved hosts) -----
  let dialogOpen = $state(false);
  let dialogMode = $state<"connect" | "edit">("connect");
  let dialogTitle = $state("Connect");
  let dialogAlias = $state<string | null>(null);
  let dialogHostId = $state<string | null>(null);
  let dialogInitial = $state<ConnectFormInitial>({});

  function openItemDialog(item: HostItem, mode: "connect" | "edit" = "connect"): void {
    dialogMode = mode;
    dialogTitle = mode === "edit" ? `Edit "${item.name}"` : item.name;
    dialogAlias = item.alias;
    dialogHostId = item.id;
    dialogInitial = {
      name: item.name,
      hostname: item.hostname,
      user: item.user ?? "",
      port: item.port,
      identityFile: item.identityFile,
      proxyJump: item.proxyJump,
    };
    dialogOpen = true;
  }

  function quickConnect(item: HostItem): void {
    void app.connect(
      {
        alias: item.alias ?? undefined,
        hostname: item.hostname,
        user: item.user ?? undefined,
        port: item.port,
        identityFile: item.identityFile ?? undefined,
        proxyJump: item.proxyJump ?? undefined,
      },
      item.name,
    );
  }

  // A plain onclick opens the connect-form dialog; a native dblclick should
  // quick-connect instead (this file's own header comment). But the *first*
  // click of a double-click already fires a "click" event, and opening the
  // dialog synchronously from it renders a full-screen overlay before the
  // second click lands — so the second click hits the overlay, not this row,
  // and the browser's dblclick event never fires on the button at all. Delay
  // the single-click action long enough to fold in on a following dblclick.
  const DBLCLICK_WINDOW_MS = 250;
  let pendingClick: ReturnType<typeof setTimeout> | undefined;

  function rowClick(openSingle: () => void): void {
    if (pendingClick) return; // a click is already pending — let it resolve as-is
    pendingClick = setTimeout(() => {
      pendingClick = undefined;
      openSingle();
    }, DBLCLICK_WINDOW_MS);
  }

  function rowDblClick(connect: () => void): void {
    if (pendingClick) {
      clearTimeout(pendingClick);
      pendingClick = undefined;
    }
    connect();
  }

  function doRefresh(): void {
    void refreshConfigHosts();
  }

  async function doRename(item: HostItem): Promise<void> {
    const name = await app.ask({
      title: "Rename connection",
      input: { value: item.name },
      confirmLabel: "Rename",
    });
    if (name && item.id) renameHost(item.id, name);
  }

  async function doDelete(item: HostItem): Promise<void> {
    const ok = await app.ask({
      title: "Delete connection",
      message: `Remove "${item.name}" from your saved connections? This won't touch the server.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok && item.id) removeHost(item.id);
  }
</script>

{#snippet pausedRow(p: PausedSession)}
  <li
    class="group relative flex h-7 items-center gap-1.5 rounded-sm px-2 opacity-70 hover:bg-accent hover:opacity-100"
    data-testid="paused-row"
    data-label={p.label}
  >
    <span class="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[13px] text-sidebar-foreground">
      <PauseIcon class="size-3.5 shrink-0 text-muted-foreground" />
      <span class="truncate">{p.label}</span>
    </span>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Resume ${p.label}`}
            onclick={() => void app.resumeSession(p.id)}
          >
            <PlayIcon class="size-3.5" />
          </button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>Resume</Tooltip.Content>
    </Tooltip.Root>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label={`Discard paused session ${p.label}`}
            onclick={() => app.discardPausedSession(p.id)}
          >
            <XIcon class="size-3.5" />
          </button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>Discard</Tooltip.Content>
    </Tooltip.Root>
  </li>
{/snippet}

{#snippet savedRow(item: HostItem)}
  <li
    class="group relative flex h-7 items-center gap-1.5 rounded-sm px-2 hover:bg-accent"
    data-testid="saved-host-row"
    data-id={item.id}
  >
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-1.5 bg-transparent text-left text-[13px] text-sidebar-foreground"
      disabled={app.connecting}
      onclick={() => rowClick(() => openItemDialog(item))}
      ondblclick={() => rowDblClick(() => quickConnect(item))}
    >
      <ServerIcon class="size-3.5 shrink-0 text-muted-foreground" />
      <span class="truncate">{item.name}</span>
      <span class="truncate text-[11px] text-muted-foreground">{item.user}@{item.hostname}</span>
      {#if item.proxyJump}
        <span class="shrink-0 truncate text-[10px] text-muted-foreground" title={`ProxyJump ${item.proxyJump}`}
          >via {item.proxyJump}</span
        >
      {/if}
    </button>

    {#if app.connecting && app.connectTarget === item.name}
      <Loader delay={0} />
    {:else}
      <button
        type="button"
        class="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100"
        title="Connect"
        aria-label={`Connect ${item.name}`}
        onclick={() => quickConnect(item)}
      >
        <ChevronRightIcon class="size-3.5" />
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
              title="More actions"
              aria-label={`More actions for ${item.name}`}
            >
              <MoreHorizontalIcon class="size-3.5" />
            </button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="start">
          <DropdownMenu.Item onSelect={() => quickConnect(item)}>
            <PlugZapIcon /> Connect
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => openItemDialog(item, "edit")}>
            <PencilIcon /> Edit…
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => item.id && setPinned(item.id, !item.pinned)}>
            {#if item.pinned}<PinOffIcon /> Unpin{:else}<PinIcon /> Pin{/if}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => doRename(item)}>
            <PencilIcon /> Rename
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item variant="destructive" onSelect={() => doDelete(item)}>
            <Trash2Icon /> Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/if}
  </li>
{/snippet}

<div class="flex h-full min-h-0 flex-col">
  <div class="flex items-center gap-1 px-2 pt-2 pb-1.5">
    <Input
      type="text"
      class="h-7 flex-1 text-[13px]"
      placeholder="Filter hosts…"
      bind:value={hostStore.filter}
      spellcheck="false"
      data-testid="host-filter"
    />
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="flex size-7 flex-none items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            disabled={hostStore.status === "loading"}
            aria-label="Refresh"
            data-testid="hosts-refresh"
            onclick={doRefresh}
          >
            <RefreshCwIcon class={`size-3.5 ${hostStore.status === "loading" ? "animate-spin" : ""}`} />
          </button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>Refresh hosts</Tooltip.Content>
    </Tooltip.Root>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto pb-1">
    {#if app.pausedSessions.length > 0}
      <div class="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <PauseIcon class="size-3" /> Paused
      </div>
      <ul class="flex flex-col gap-px px-1" data-testid="paused-list">
        {#each app.pausedSessions as p (p.id)}
          {@render pausedRow(p)}
        {/each}
      </ul>
    {/if}

    {#if pinned.length > 0}
      <div class="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <PinIcon class="size-3" /> Pinned
      </div>
      <ul class="flex flex-col gap-px px-1">
        {#each pinned as item (item.key)}
          {@render savedRow(item)}
        {/each}
      </ul>
    {/if}

    {#if saved.length > 0}
      <div class="flex items-center gap-1.5 px-3 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <BookmarkIcon class="size-3" /> Saved
      </div>
      <ul class="flex flex-col gap-px px-1">
        {#each saved as item (item.key)}
          {@render savedRow(item)}
        {/each}
      </ul>
    {/if}

    <div class="flex items-center gap-1.5 px-3 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      <SettingsIcon class="size-3" /> SSH config
    </div>
    {#if hostStore.status === "loading" && configHosts.length === 0 && saved.length === 0 && pinned.length === 0}
      <div class="px-3 py-2 text-[12px] text-muted-foreground">Loading ~/.ssh/config…</div>
    {:else if hostStore.status === "error"}
      <div class="px-3 py-2 text-[12px] text-destructive">{hostStore.error}</div>
    {:else if configHosts.length === 0}
      <div class="px-3 py-2 text-[12px] text-muted-foreground" data-testid="hosts-empty">
        {filter ? "No matches." : "No hosts found."}
      </div>
    {:else}
      <ul class="flex flex-col gap-px px-1" data-testid="host-list">
        {#each configHosts as host (host.key)}
          <li
            class="group relative flex h-7 items-center gap-1.5 rounded-sm px-2 hover:bg-accent"
            data-testid="host-row"
            data-alias={host.alias}
          >
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-1.5 bg-transparent text-left text-[13px] text-sidebar-foreground"
              disabled={app.connecting}
              onclick={() => rowClick(() => openItemDialog(host))}
              ondblclick={() => rowDblClick(() => quickConnect(host))}
            >
              <ServerIcon class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="truncate font-medium">{host.alias}</span>
              <span class="truncate text-[11px] text-muted-foreground"
                >{host.user ? `${host.user}@` : ""}{host.hostname}</span
              >
              {#if host.proxyJump}
                <span
                  class="shrink-0 truncate text-[10px] text-muted-foreground"
                  title={`ProxyJump ${host.proxyJump}`}
                  data-testid="via-hint">via {host.proxyJump}</span
                >
              {/if}
            </button>
            {#if app.connecting && app.connectTarget === host.name}
              <Loader delay={0} />
            {:else}
              <button
                type="button"
                class="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100"
                title="Connect"
                aria-label={`Connect ${host.name}`}
                onclick={() => quickConnect(host)}
              >
                <ChevronRightIcon class="size-3.5" />
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <button
                      {...props}
                      type="button"
                      class="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
                      title="More actions"
                      aria-label={`More actions for ${host.name}`}
                    >
                      <MoreHorizontalIcon class="size-3.5" />
                    </button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="start">
                  <DropdownMenu.Item onSelect={() => quickConnect(host)}>
                    <PlugZapIcon /> Connect
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => openItemDialog(host)}>
                    <PencilIcon /> Edit &amp; save as new…
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="border-t border-border">
    <QuickConnect />
  </div>
</div>

<ConnectDialog
  bind:open={dialogOpen}
  mode={dialogMode}
  title={dialogTitle}
  alias={dialogAlias}
  hostId={dialogHostId}
  initial={dialogInitial}
/>
