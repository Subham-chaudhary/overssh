<script lang="ts" module>
  export const LANE_W = 14;
  export const ROW_H = 26;
  export const PALETTE = ["#3b9eff", "#e5534b", "#46b85c", "#d4a72c", "#b072f0", "#2cc4b8", "#ef7d3a", "#e0629f"];
</script>

<script lang="ts">
  import type { GraphRow } from "../../../lib/git/graph";

  let {
    row,
    width,
    head = false,
    hollow = false,
    plain = false,
  }: {
    row: GraphRow;
    /** Pixel width of the cell (lanes beyond it are clipped). */
    width: number;
    /** This commit is HEAD: bigger dot with a ring. */
    head?: boolean;
    /** Uncommitted-changes row: hollow dot. */
    hollow?: boolean;
    /** Search is active: dots only, no lines (the rows are no longer adjacent). */
    plain?: boolean;
  } = $props();

  const x = (lane: number) => lane * LANE_W + LANE_W / 2;
  const color = (c: number) => PALETTE[c % PALETTE.length];

  function d(l: GraphRow["lines"][number]): string {
    const x1 = x(l.fromLane);
    const y1 = l.fromY * ROW_H;
    const x2 = x(l.toLane);
    const y2 = l.toY * ROW_H;
    if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`;
    const ym = (y1 + y2) / 2;
    return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
  }
</script>

<svg {width} height={ROW_H} viewBox={`0 0 ${width} ${ROW_H}`} class="block shrink-0" aria-hidden="true" data-testid="graph-cell" data-lane={row.col}>
  {#if !plain}
    {#each row.lines as l, i (i)}
      <path d={d(l)} fill="none" stroke={color(l.color)} stroke-width="2" stroke-linecap="round" stroke-dasharray={hollow && l.fromY === 0.5 ? "3 3" : undefined} />
    {/each}
  {/if}
  {#if hollow}
    <circle cx={x(row.col)} cy={ROW_H / 2} r="4" fill="var(--editor-bg, #1e1e1e)" stroke={color(row.color)} stroke-width="2" stroke-dasharray="2 2" />
  {:else if head}
    <circle cx={x(row.col)} cy={ROW_H / 2} r="5.5" fill="var(--editor-bg, #1e1e1e)" stroke={color(row.color)} stroke-width="2" />
    <circle cx={x(row.col)} cy={ROW_H / 2} r="2.5" fill={color(row.color)} />
  {:else if row.isMerge}
    <circle cx={x(row.col)} cy={ROW_H / 2} r="3.5" fill="var(--editor-bg, #1e1e1e)" stroke={color(row.color)} stroke-width="2" />
  {:else}
    <circle cx={x(row.col)} cy={ROW_H / 2} r="4" fill={color(row.color)} stroke="var(--editor-bg, #1e1e1e)" stroke-width="1" />
  {/if}
</svg>
