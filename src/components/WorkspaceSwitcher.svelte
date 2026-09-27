<script lang="ts">
  // Strip of connected sessions above the editor: one pill per session.
  // Clicking a pill switches the active workspace; × disconnects; Pause
  // (docs/GUIDE.md §12, "Pause session") disconnects but keeps open files,
  // moving the session into a dimmed "paused" pill with Resume/discard.
  import { app } from "../lib/stores.svelte";
  import { reconnect, reconnectClock, retryNow, cancelReconnect } from "../lib/reconnect.svelte";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import XIcon from "@lucide/svelte/icons/x";
  import PauseIcon from "@lucide/svelte/icons/pause";
  import PlayIcon from "@lucide/svelte/icons/play";

  // Auto-reconnect (§13.4.A): one banner row per dropped workspace.
  const dropped = $derived(Object.values(reconnect.items).filter((i) => !i.background));

  function bannerText(i: (typeof dropped)[number]): string {
    switch (i.status) {
      case "waiting": {
        const s = Math.max(0, Math.ceil(((i.nextAt ?? 0) - reconnectClock.now) / 1000));
        return `Connection to ${i.label} lost. Reconnecting in ${s}s (attempt ${i.attempt + 1})`;
      }
      case "paused":
        return `Connection to ${i.label} lost. Paused: your files are kept.`;
      case "prompting":
        return `Reconnecting to ${i.label}: waiting for your answer`;
      case "failed":
        return `Disconnected from ${i.label}${i.lastError ? `: ${i.lastError}` : ""}`;
      default:
        return `Reconnecting to ${i.label} (attempt ${Math.max(1, i.attempt)})`;
    }
  }
</script>

{#each dropped as item (item.sessionId)}
  <div
    class={`flex min-w-0 flex-none flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-2.5 py-1 text-[12px] ${item.status === "failed" ? "bg-destructive/15 text-destructive" : "bg-warning/15 text-foreground"}`}
    data-testid="reconnect-banner"
    data-status={item.status}
    data-session-id={item.sessionId}
    role="status"
  >
    <span class="min-w-[8rem] flex-1 truncate" title={bannerText(item)}>{bannerText(item)}</span>
    {#if item.status === "waiting" || item.status === "failed" || item.status === "paused"}
      <button
        type="button"
        class="flex-none rounded-sm border border-border px-2 py-0.5 hover:bg-accent"
        data-testid="reconnect-retry"
        onclick={() => retryNow(item.sessionId)}
      >
        {item.status === "failed" ? "Retry" : item.status === "paused" ? "Continue" : "Retry now"}
      </button>
    {/if}
    <button
      type="button"
      class="flex-none rounded-sm border border-border px-2 py-0.5 hover:bg-accent"
      data-testid="reconnect-cancel"
      onclick={() => void cancelReconnect(item.sessionId)}
    >
      {item.status === "failed" || item.status === "paused" ? "Close workspace" : "Cancel"}
    </button>
  </div>
{/each}

{#if app.sessions.length > 0 || app.pausedSessions.length > 0}
  <div class="flex min-w-0 flex-none items-center gap-1 overflow-x-auto border-b border-border bg-sidebar px-1.5 py-1" role="tablist" aria-label="Connected sessions">
    {#each app.sessions as s (s.id)}
      <div class={`flex flex-none items-stretch overflow-hidden rounded-sm border ${s.id === app.activeSessionId ? "border-border bg-background" : "border-transparent"}`}>
        <button
          type="button"
          class={`flex items-center gap-1.5 bg-transparent py-1 pr-1.5 pl-2 text-[12px] whitespace-nowrap ${s.id === app.activeSessionId ? "text-foreground" : "text-muted-foreground"}`}
          role="tab"
          aria-selected={s.id === app.activeSessionId}
          onclick={() => app.setActiveSession(s.id)}
        >
          <span class={`size-1.5 flex-none rounded-full ${s.id in reconnect.items ? "animate-pulse bg-warning" : s.id === app.activeSessionId ? "bg-success" : "bg-muted-foreground"}`}></span>
          <span class="max-w-[10rem] truncate @lg/main:max-w-[16rem]">{s.label}</span>
        </button>
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="flex items-center justify-center px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={`Pause ${s.label}`}
                data-testid="pause-session"
                onclick={() => void app.pauseSession(s.id)}
              >
                <PauseIcon size={12} />
              </button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>Pause session: disconnect but keep open files</Tooltip.Content>
        </Tooltip.Root>
        <button
          type="button"
          class="flex items-center justify-center px-1.5 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
          title="Disconnect"
          aria-label={`Disconnect ${s.label}`}
          onclick={() => void app.disconnectSession(s.id)}
        >
          <XIcon size={12} />
        </button>
      </div>
    {/each}

    {#each app.pausedSessions as p (p.id)}
      <div
        class="flex flex-none items-stretch overflow-hidden rounded-sm border border-transparent opacity-60"
        data-testid="paused-session-pill"
        data-label={p.label}
      >
        <span class="flex items-center gap-1.5 bg-transparent py-1 pr-1.5 pl-2 text-[12px] whitespace-nowrap text-muted-foreground">
          <span class="size-1.5 flex-none rounded-full bg-muted-foreground"></span>
          <span class="max-w-[10rem] truncate @lg/main:max-w-[16rem]">{p.label}</span>
        </span>
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="flex items-center justify-center px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={`Resume ${p.label}`}
                onclick={() => void app.resumeSession(p.id)}
              >
                <PlayIcon size={12} />
              </button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>Resume</Tooltip.Content>
        </Tooltip.Root>
        <button
          type="button"
          class="flex items-center justify-center px-1.5 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
          title="Discard"
          aria-label={`Discard paused session ${p.label}`}
          onclick={() => app.discardPausedSession(p.id)}
        >
          <XIcon size={12} />
        </button>
      </div>
    {/each}
  </div>
{/if}
