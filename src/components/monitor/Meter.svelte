<script lang="ts">
  // htop-style horizontal meter: label on the left, stacked colored segments in
  // a track, value text on the right. Segment values are percent of the track.
  let {
    label,
    segments,
    text,
    height = "h-3",
    testid,
  }: {
    label: string;
    segments: { value: number; class: string; title?: string }[];
    text?: string;
    height?: string;
    testid?: string;
  } = $props();
</script>

<div class="flex items-center gap-2 font-mono text-[11px]" data-testid={testid}>
  <span class="w-8 flex-none text-right text-muted-foreground">{label}</span>
  <div class={`relative flex min-w-0 flex-1 overflow-hidden rounded-sm bg-muted ${height}`}>
    {#each segments as seg}
      <div
        class={`${seg.class} h-full transition-[width] duration-300`}
        style={`width:${Math.max(0, Math.min(100, seg.value))}%`}
        title={seg.title}
      ></div>
    {/each}
  </div>
  {#if text !== undefined}
    <span class="w-24 flex-none text-right tabular-nums text-foreground">{text}</span>
  {/if}
</div>
