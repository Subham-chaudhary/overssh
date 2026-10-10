<script lang="ts" module>
  export interface MenuItem {
    label: string;
    onclick?: () => void;
    danger?: boolean;
    disabled?: boolean;
    sep?: boolean;
    shortcut?: string;
  }
</script>

<script lang="ts">
  // Small fixed-position popup menu at the cursor (right-click on Docker rows).
  let { x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void } = $props();

  let el = $state<HTMLDivElement | null>(null);
  let left = $state(0);
  let top = $state(0);
  $effect(() => {
    left = x;
    top = y;
    if (!el) return;
    const r = el.getBoundingClientRect();
    left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
  });
</script>

<svelte:window onpointerdown={(e) => { if (el && !el.contains(e.target as Node)) onClose(); }} onkeydown={(e) => { if (e.key === "Escape") onClose(); }} onblur={onClose} />

<div
  bind:this={el}
  role="menu"
  tabindex="-1"
  data-testid="docker-menu"
  class="fixed z-50 min-w-44 rounded-md border border-border bg-popover p-1 text-[12px] text-popover-foreground shadow-md"
  style={`left:${left}px;top:${top}px`}
  oncontextmenu={(e) => e.preventDefault()}
>
  {#each items as it, i (i)}
    {#if it.sep}
      <div class="my-1 h-px bg-border" role="separator"></div>
    {:else}
      <button
        type="button"
        role="menuitem"
        disabled={it.disabled}
        data-testid="docker-menu-item"
        class={`flex w-full items-center justify-between gap-6 rounded-sm px-2 py-1 text-left hover:bg-accent disabled:opacity-40 ${it.danger ? "text-destructive" : ""}`}
        onclick={() => {
          onClose();
          it.onclick?.();
        }}
      >
        <span>{it.label}</span>
        {#if it.shortcut}<span class="font-mono text-[10px] text-muted-foreground">{it.shortcut}</span>{/if}
      </button>
    {/if}
  {/each}
</div>
