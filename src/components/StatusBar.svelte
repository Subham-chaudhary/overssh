<script lang="ts">
  import { app } from "../lib/stores.svelte";
  import { settings } from "../lib/settings.svelte";
  import { THEMES } from "../lib/themes";
  import { reconnect } from "../lib/reconnect.svelte";
  import RefreshIcon from "@lucide/svelte/icons/refresh-cw";
  import CircleIcon from "@lucide/svelte/icons/circle";
  import SaveIcon from "@lucide/svelte/icons/save";

  const session = $derived(app.activeSession);
  const tab = $derived(app.activeTab);
  const reconnectItem = $derived(session ? reconnect.items[session.id] : undefined);
  const reconnectCount = $derived(Object.keys(reconnect.items).length);
  const dropModeLabel = $derived(
    settings.connection.pauseOnDrop
      ? settings.connection.resumeOnRestore
        ? "Pause, auto-continue"
        : "Pause, continue by hand"
      : settings.connection.autoReconnect
        ? "Auto-reconnect"
        : "Off",
  );

  /** Auto-reconnect -> Pause (manual) -> Pause (auto-continue) -> Off -> ... */
  function cycleDropMode(): void {
    const c = settings.connection;
    if (!c.pauseOnDrop && c.autoReconnect) {
      c.pauseOnDrop = true;
      c.resumeOnRestore = false;
    } else if (c.pauseOnDrop && !c.resumeOnRestore) {
      c.resumeOnRestore = true;
    } else if (c.pauseOnDrop) {
      c.pauseOnDrop = false;
      c.resumeOnRestore = false;
      c.autoReconnect = false;
    } else {
      c.autoReconnect = true;
    }
  }
  const themeLabel = $derived(THEMES[settings.theme]?.label ?? settings.theme);

  const autoSaveLabel = $derived.by(() => {
    switch (settings.files.autoSave) {
      case "off":
        return "Auto Save: Off";
      case "afterDelay":
        return `Auto Save: After Delay (${settings.files.autoSaveDelay}ms)`;
      case "onFocusChange":
        return "Auto Save: On Focus Change";
      case "onWindowChange":
        return "Auto Save: On Window Change";
    }
  });
</script>

<!-- @container: items drop out as the window narrows (container queries on this footer). -->
<footer class="@container flex h-[22px] flex-none items-center justify-between gap-3 overflow-hidden bg-statusbar px-2.5 text-[11px] whitespace-nowrap text-statusbar-foreground">
  <div class="flex min-w-0 shrink items-center gap-3 overflow-hidden">
    {#if reconnectItem || (reconnectCount > 0 && !session)}
      {@const it = reconnectItem ?? Object.values(reconnect.items)[0]}
      <span class="flex items-center gap-1 font-medium text-warning" data-testid="status-reconnecting">
        <RefreshIcon class={`size-3 ${it.status === "failed" || it.status === "paused" ? "" : "animate-spin"}`} />
        {it.status === "failed" ? "Disconnected" : it.status === "paused" ? "Paused (connection lost)" : `Reconnecting (attempt ${Math.max(1, it.attempt)})`}
      </span>
    {:else if app.connecting}
      <span class="flex items-center gap-1 font-medium opacity-90">
        <CircleIcon class="size-2 animate-pulse fill-current" /> Connecting…
      </span>
    {:else if session}
      <span class="flex min-w-0 items-center gap-1 font-medium text-success">
        <CircleIcon class="size-2 flex-none fill-current" /> <span class="truncate">{session.label}</span>
      </span>
      <span class="hidden truncate opacity-75 @md:inline">{session.user}@{session.hostname}</span>
    {:else}
      <span class="flex items-center gap-1 opacity-75">
        <CircleIcon class="size-2" /> Not connected
      </span>
    {/if}
    {#if app.sessions.length > 1}
      <span class="hidden opacity-75 @lg:inline">{app.sessions.length} sessions</span>
    {/if}
  </div>
  <div class="flex min-w-0 shrink-[2] items-center justify-end gap-3 overflow-hidden">
    {#if tab}
      <span class="min-w-0 max-w-[40cqw] truncate opacity-90" title={tab.path}>{tab.path}</span>
      <span class="hidden opacity-75 @2xl:inline">{tab.language}</span>
      <span class="flex-none opacity-75">Ln {tab.line}, Col {tab.col}</span>
    {/if}
    <button
      type="button"
      class="flex flex-none items-center gap-1 opacity-75 hover:opacity-100"
      title="On a network drop: reconnect automatically, pause (continue by hand), pause and continue when the network is back, or do nothing. Click to change."
      data-testid="auto-reconnect-toggle"
      onclick={cycleDropMode}
    >
      <RefreshIcon class="size-3" /> <span class="hidden @3xl:inline">On drop: {dropModeLabel}</span>
    </button>
    <span class="hidden items-center gap-1 opacity-75 @2xl:flex" title={autoSaveLabel}>
      <SaveIcon class="size-3" /> <span class="hidden @4xl:inline">{autoSaveLabel}</span>
    </span>
    <span class="hidden opacity-75 @3xl:inline">{themeLabel}</span>
  </div>
</footer>
