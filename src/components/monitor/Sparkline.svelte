<script lang="ts">
  // Tiny inline-SVG area/line chart. Stroke/fill follow `currentColor`, so pass
  // a text-* class (theme token) for the color.
  let {
    data,
    max,
    class: className = "",
    fill = true,
  }: { data: number[]; max?: number; class?: string; fill?: boolean } = $props();

  const W = 100;
  const H = 30;
  const top = $derived(Math.max(max ?? 0, ...data, 1e-9));
  const pts = $derived(
    data.map((v, i) => {
      const x = data.length <= 1 ? W : (i / (data.length - 1)) * W;
      const y = H - (Math.min(v, top) / top) * (H - 2) - 1;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }),
  );
</script>

<svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" class={`h-full w-full ${className}`} aria-hidden="true">
  {#if pts.length > 1}
    {#if fill}
      <polygon points={`0,${H} ${pts.join(" ")} ${W},${H}`} fill="currentColor" fill-opacity="0.18" />
    {/if}
    <polyline points={pts.join(" ")} fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
  {/if}
</svg>
