<script lang="ts">
  // Drag handle that resizes the pane after it (right of a vertical bar, below a horizontal bar).
  let {
    vertical,
    size = $bindable(),
    min = 120,
    max = 800,
    testid,
  }: { vertical: boolean; size: number; min?: number; max?: number; testid?: string } = $props();

  let startPos = 0;
  let startSize = 0;
  let dragging = $state(false);

  function down(e: PointerEvent): void {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    startPos = vertical ? e.clientX : e.clientY;
    startSize = size;
    dragging = true;
    e.preventDefault();
  }

  function move(e: PointerEvent): void {
    if (!dragging) return;
    const delta = (vertical ? e.clientX : e.clientY) - startPos;
    size = Math.min(max, Math.max(min, startSize - delta));
  }

  function up(): void {
    dragging = false;
  }

  function key(e: KeyboardEvent): void {
    const step = e.shiftKey ? 48 : 16;
    const grow = vertical ? "ArrowLeft" : "ArrowUp";
    const shrink = vertical ? "ArrowRight" : "ArrowDown";
    if (e.key === grow) size = Math.min(max, size + step);
    else if (e.key === shrink) size = Math.max(min, size - step);
    else return;
    e.preventDefault();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  tabindex="0"
  aria-orientation={vertical ? "vertical" : "horizontal"}
  data-testid={testid}
  class={[
    "relative z-10 shrink-0 bg-border outline-none hover:bg-primary/60 focus-visible:bg-primary/60",
    vertical ? "w-px cursor-col-resize after:absolute after:inset-y-0 after:-left-1 after:w-2" : "h-px cursor-row-resize after:absolute after:inset-x-0 after:-top-1 after:h-2",
    dragging && "bg-primary/60",
  ]}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onkeydown={key}
></div>
