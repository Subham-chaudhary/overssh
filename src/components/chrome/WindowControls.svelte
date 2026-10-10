<script lang="ts">
  // Circle window buttons (docs/GUIDE.md §15.3.T). Order: minimize (blue),
  // maximize / restore (yellow), close (red) -- the Windows order, left to
  // right, so close is the one farthest from the corner. Idle: hollow rings
  // tinted by the theme; hovering the group fills them; the hovered circle
  // grows a little and shows its glyph.
  import { winClose, winMinimize, winToggleMaximize } from "../../lib/api";
  import { windowState } from "./windowState.svelte";

  let { onclose }: { onclose?: () => void } = $props();

  const maximized = $derived(windowState.maximized);

  function safe(p: Promise<void>): void {
    p.catch(() => {});
  }
</script>

<div
  class="controls"
  role="group"
  aria-label="Window controls"
  data-testid="window-controls"
  data-inactive={windowState.focused ? undefined : ""}
>
  <button
    type="button"
    class="btn min"
    aria-label="Minimize"
    title="Minimize"
    data-testid="win-minimize"
    onclick={() => safe(winMinimize())}
  >
    <span class="dot">
      <svg viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 4h5" /></svg>
    </span>
  </button>
  <button
    type="button"
    class="btn max"
    aria-label={maximized ? "Restore" : "Maximize"}
    title={maximized ? "Restore" : "Maximize"}
    data-testid="win-maximize"
    data-maximized={maximized ? "" : undefined}
    onclick={() => safe(winToggleMaximize())}
  >
    <span class="dot">
      {#if maximized}
        <svg viewBox="0 0 8 8" aria-hidden="true"><path d="M2.5 2.5V1.5h4v4h-1M1.5 2.5h4v4h-4z" /></svg>
      {:else}
        <svg viewBox="0 0 8 8" aria-hidden="true"><path d="M1.75 1.75h4.5v4.5h-4.5z" /></svg>
      {/if}
    </span>
  </button>
  <button
    type="button"
    class="btn close"
    aria-label="Close"
    title="Close"
    data-testid="win-close"
    onclick={() => (onclose ? onclose() : safe(winClose()))}
  >
    <span class="dot">
      <svg viewBox="0 0 8 8" aria-hidden="true"><path d="M2 2l4 4M6 2l-4 4" /></svg>
    </span>
  </button>
</div>

<style>
  .controls {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 4px;
    height: 100%;
    -webkit-app-region: no-drag;
  }
  .btn {
    --c: var(--chrome-min, #61afef);
    display: grid;
    place-items: center;
    width: 20px;
    height: 24px;
    padding: 0;
    border: 0;
    background: transparent;
    border-radius: 9999px;
    cursor: default;
    outline: none;
  }
  .btn.min {
    --c: var(--chrome-min, #61afef);
  }
  .btn.max {
    --c: var(--chrome-max, #e5c07b);
  }
  .btn.close {
    --c: var(--chrome-close, var(--destructive, #e06c75));
  }
  .dot {
    display: grid;
    place-items: center;
    box-sizing: border-box;
    width: 12px;
    height: 12px;
    border-radius: 9999px;
    border: 1.5px solid color-mix(in srgb, var(--c) 62%, transparent);
    background: color-mix(in srgb, var(--c) 10%, transparent);
    color: color-mix(in srgb, var(--c) 28%, #000);
    transition:
      transform 120ms cubic-bezier(0.3, 0.7, 0.3, 1.3),
      background-color 120ms ease,
      border-color 120ms ease,
      box-shadow 120ms ease;
  }
  .dot svg {
    width: 8px;
    height: 8px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0;
    transition: opacity 100ms ease;
  }
  /* Group hover / keyboard focus inside the group: every circle fills. */
  .controls:hover .dot,
  .controls:focus-within .dot {
    background: var(--c);
    border-color: var(--c);
  }
  .controls:hover .dot svg,
  .controls:focus-within .dot svg {
    opacity: 0.9;
  }
  /* The circle under the pointer grows a little. */
  .btn:hover .dot,
  .btn:focus-visible .dot {
    transform: scale(1.18);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 24%, transparent);
  }
  .btn:active .dot {
    transform: scale(1.04);
  }
  .btn:focus-visible {
    box-shadow: 0 0 0 2px var(--ring, currentColor);
  }
  /* Unfocused window: neutral rings. */
  .controls[data-inactive] .dot {
    border-color: color-mix(in srgb, var(--muted-foreground, #888) 45%, transparent);
    background: transparent;
  }
  .controls[data-inactive]:hover .dot,
  .controls[data-inactive]:focus-within .dot {
    background: var(--c);
    border-color: var(--c);
  }
  @media (prefers-reduced-motion: reduce) {
    .dot,
    .dot svg {
      transition: none;
    }
    .btn:hover .dot,
    .btn:focus-visible .dot,
    .btn:active .dot {
      transform: none;
    }
  }
</style>
