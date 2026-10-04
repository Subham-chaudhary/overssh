<script lang="ts">
  import type { GitRef } from "../../../lib/git/log";
  import GitBranchIcon from "@lucide/svelte/icons/git-branch";
  import TagIcon from "@lucide/svelte/icons/tag";
  import CloudIcon from "@lucide/svelte/icons/cloud";
  import GitCommitIcon from "@lucide/svelte/icons/git-commit-horizontal";

  let { ref }: { ref: GitRef } = $props();

  const style = $derived(
    ref.current
      ? "bg-primary text-primary-foreground border-primary"
      : ref.kind === "branch"
        ? "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40"
        : ref.kind === "remote"
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40"
          : ref.kind === "tag"
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40"
            : "bg-muted text-foreground border-border",
  );
</script>

<span
  class={["inline-flex h-[18px] max-w-[220px] shrink-0 items-center gap-1 rounded-sm border px-1.5 text-[11px] leading-none", style]}
  data-testid="ref-badge"
  data-ref-kind={ref.kind}
  data-ref-name={ref.name}
  data-current={ref.current ? "true" : undefined}
  title={ref.current ? `${ref.name} (HEAD)` : `${ref.kind}: ${ref.name}`}
>
  {#if ref.kind === "tag"}
    <TagIcon class="size-3 shrink-0" />
  {:else if ref.kind === "remote"}
    <CloudIcon class="size-3 shrink-0" />
  {:else if ref.kind === "head"}
    <GitCommitIcon class="size-3 shrink-0" />
  {:else}
    <GitBranchIcon class="size-3 shrink-0" />
  {/if}
  <span class="truncate">{ref.name}</span>
</span>
