<script lang="ts">
  // Custom window chrome (docs/GUIDE.md §15.3.T): the native title bar is off
  // (`decorations: false`), so this bar provides the circle window buttons, the
  // menu bar, the workspace / file title and the drag area. `compact` is the
  // detached Terminals window: buttons and a fixed title, no menu bar.
  import { onMount } from "svelte";
  import { app } from "../../lib/stores.svelte";
  import { confirmClose, winClose, winSetTitle } from "../../lib/api";
  import { basename } from "../../lib/paths";
  import WindowControls from "./WindowControls.svelte";
  import MenuBar from "./MenuBar.svelte";
  import AboutDialog from "./AboutDialog.svelte";
  import { trackWindowState, windowState } from "./windowState.svelte";

  let { compact = false, title = "Terminals" }: { compact?: boolean; title?: string } = $props();

  let aboutOpen = $state(false);

  const host = $derived(app.activeSession?.label ?? "");
  const tab = $derived(app.activeTab);
  const file = $derived(tab ? basename(tab.path) : "");
  const dirty = $derived(tab ? tab.doc !== tab.savedDoc : false);

  /** Taskbar / Alt+Tab title, the same shape as the centre text. */
  const windowTitle = $derived(
    compact ? title : [file ? `${dirty ? "● " : ""}${file}` : "", host, "OverSSH"].filter(Boolean).join(" — "),
  );

  $effect(() => {
    if (compact) return;
    document.title = windowTitle;
    winSetTitle(windowTitle).catch(() => {});
  });

  onMount(() => trackWindowState());

  /** Main window close / File > Exit: asks first when files have unsaved changes.
   * (The compact terminal window docks back instead and has nothing to lose.) */
  async function requestClose(): Promise<void> {
    if (compact) {
      winClose().catch(() => {});
      return;
    }
    // Already asked: tell the backend's close guard not to ask again (closeguard.rs).
    if (!(await app.confirmQuit())) return;
    confirmClose().catch(() => {});
  }

  const actions = {
    openPalette: () => (app.showPalette = true),
    openAbout: () => (aboutOpen = true),
    exit: () => void requestClose(),
  };
</script>

<header
  class="titlebar flex h-[34px] flex-none items-center border-b border-border bg-sidebar text-sidebar-foreground select-none"
  class:compact
  data-testid="title-bar"
  data-maximized={windowState.maximized ? "" : undefined}
  data-tauri-drag-region
>
  <WindowControls onclose={() => void requestClose()} />

  {#if !compact}
    <div class="ml-2 h-full" data-testid="menu-bar-wrap">
      <MenuBar {actions} />
    </div>
  {/if}

  <div
    class="flex h-full min-w-0 flex-1 items-center justify-center gap-1.5 px-3 text-xs"
    data-tauri-drag-region
    data-testid="title-center"
  >
    {#if compact}
      <span class="truncate text-muted-foreground" data-tauri-drag-region>{title}</span>
    {:else if file || host}
      {#if host}
        <span class="truncate text-muted-foreground" data-tauri-drag-region data-testid="title-host">{host}</span>
      {/if}
      {#if host && file}<span class="text-muted-foreground/50" data-tauri-drag-region>/</span>{/if}
      {#if file}
        <span class="truncate" data-tauri-drag-region data-testid="title-file">{file}</span>
        {#if dirty}<span class="text-primary" data-tauri-drag-region title="Unsaved changes">&bull;</span>{/if}
      {/if}
    {:else}
      <span class="truncate text-muted-foreground" data-tauri-drag-region data-testid="title-app">OverSSH</span>
    {/if}
  </div>

  <!-- balances the left side so the title stays near the centre -->
  <div class="h-full w-4 flex-none" data-tauri-drag-region></div>
</header>

{#if !compact}
  <AboutDialog bind:open={aboutOpen} />
{/if}

<style>
  .titlebar {
    /* Rounded top corners like a Windows 11 window; square when maximized. */
    border-top-left-radius: 8px;
    border-top-right-radius: 8px;
  }
  .titlebar[data-maximized] {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }
</style>
