<script lang="ts">
  // Small square toolbar button used across the Source Control view.
  import type { Snippet } from "svelte";

  let {
    title,
    onclick,
    disabled = false,
    testid,
    active = false,
    children,
  }: {
    title: string;
    onclick?: (e: MouseEvent) => void;
    disabled?: boolean;
    testid?: string;
    active?: boolean;
    children: Snippet;
  } = $props();
</script>

<button
  type="button"
  {title}
  aria-label={title}
  {disabled}
  data-testid={testid}
  class="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5 {active
    ? 'bg-muted text-foreground'
    : ''}"
  onclick={(e) => {
    e.stopPropagation();
    onclick?.(e);
  }}
>
  {@render children()}
</button>
