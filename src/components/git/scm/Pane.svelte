<script lang="ts">
  // Collapsible sidebar pane (like VS Code's view panes).
  import type { Snippet } from "svelte";
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";

  let {
    title,
    count = 0,
    open = $bindable(true),
    testid,
    actions,
    children,
  }: {
    title: string;
    count?: number;
    open?: boolean;
    testid?: string;
    actions?: Snippet;
    children: Snippet;
  } = $props();
</script>

<section class="border-t border-border" data-testid={testid}>
  <div class="flex h-6 items-center gap-1 pr-1 pl-0.5 hover:bg-muted/40">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-0.5 text-left text-[11px] font-semibold tracking-wide uppercase outline-none"
      aria-expanded={open}
      data-testid={testid ? `${testid}-toggle` : undefined}
      onclick={() => (open = !open)}
    >
      {#if open}<ChevronDownIcon class="size-3.5 shrink-0" />{:else}<ChevronRightIcon class="size-3.5 shrink-0" />{/if}
      <span class="truncate">{title}</span>
      {#if count > 0}
        <span class="ml-1 rounded-full bg-muted px-1.5 text-[10px] font-normal text-muted-foreground normal-case">{count}</span>
      {/if}
    </button>
    {@render actions?.()}
  </div>
  {#if open}
    {@render children()}
  {/if}
</section>
