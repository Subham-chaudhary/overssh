<script lang="ts">
  // Explorer sidebar shell (docs/GUIDE.md §15.3.S): the session picker, then one
  // `ExplorerPane` or, when split, two stacked panes with a draggable divider.
  // All tree/keyboard/drag logic lives in ExplorerPane.svelte.
  import { app } from "../lib/stores.svelte";
  import ExplorerPane from "./ExplorerPane.svelte";
  import * as Select from "$lib/components/ui/select/index.js";

  const sessionId = $derived(app.activeSessionId);
  const ws = $derived(sessionId ? app.workspaces[sessionId] : undefined);
  const split = $derived((ws?.panes.length ?? 1) > 1);

  let stackEl: HTMLDivElement | undefined = $state();
  let dragging = $state(false);

  function onDividerDown(e: PointerEvent): void {
    if (e.button !== 0 || !sessionId) return;
    e.preventDefault();
    dragging = true;
    const sid = sessionId;
    const move = (ev: PointerEvent) => {
      if (!stackEl) return;
      const r = stackEl.getBoundingClientRect();
      if (r.height <= 0) return;
      app.setSplitRatio(sid, (ev.clientY - r.top) / r.height);
    };
    const up = () => {
      dragging = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onDividerKey(e: KeyboardEvent): void {
    if (!sessionId || !ws) return;
    const step = e.shiftKey ? 0.1 : 0.03;
    if (e.key === "ArrowUp") app.setSplitRatio(sessionId, ws.splitRatio - step);
    else if (e.key === "ArrowDown") app.setSplitRatio(sessionId, ws.splitRatio + step);
    else return;
    e.preventDefault();
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if app.sessions.length > 1}
    <div class="border-b border-border p-1.5">
      <Select.Root
        type="single"
        value={app.activeSessionId ?? undefined}
        onValueChange={(v) => v && app.setActiveSession(v)}
      >
        <Select.Trigger class="h-7 w-full text-[12px]">
          {app.activeSession?.label ?? "Select session"}
        </Select.Trigger>
        <Select.Content>
          {#each app.sessions as s (s.id)}
            <Select.Item value={s.id} label={s.label}>{s.label}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
  {/if}

  <div class="flex min-h-0 flex-1 flex-col" bind:this={stackEl} data-testid="explorer-stack" data-split={split}>
    <div
      class="flex min-h-0 min-w-0 flex-col overflow-hidden"
      style={split ? `flex: ${ws?.splitRatio ?? 0.5} 1 0%;` : "flex: 1 1 0%;"}
    >
      <ExplorerPane pane={0} {split} />
    </div>
    {#if split}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class={`h-1 flex-none cursor-row-resize border-y border-border bg-border/40 hover:bg-primary/50 ${dragging ? "bg-primary/60" : ""}`}
        role="separator"
        aria-orientation="horizontal"
        aria-valuenow={Math.round((ws?.splitRatio ?? 0.5) * 100)}
        aria-label="Resize explorer panes"
        tabindex="0"
        data-testid="explorer-split-divider"
        onpointerdown={onDividerDown}
        onkeydown={onDividerKey}
      ></div>
      <div
        class="flex min-h-0 min-w-0 flex-col overflow-hidden"
        style={`flex: ${1 - (ws?.splitRatio ?? 0.5)} 1 0%;`}
      >
        <ExplorerPane pane={1} {split} />
      </div>
    {/if}
  </div>
</div>
