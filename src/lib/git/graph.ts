// Commit graph lane assignment (docs/GUIDE.md §14.4.G2). Pure: no DOM, no store.
//
// Input: commits in `--topo-order` (children before parents). Output: one
// `GraphRow` per commit with the lines to draw inside that row's cell. Each row
// is `ROW` units high; lines run between lane columns at y = 0 (top edge),
// 0.5 (the commit dot) and 1 (bottom edge). Adjacent rows join up because a
// lane that leaves row N at the bottom enters row N+1 at the top in the same
// lane.

export const GRAPH_PALETTE_SIZE = 8;

export interface GraphInput {
  sha: string;
  parents: string[];
}

export interface GraphLine {
  fromLane: number;
  /** 0 = top edge, 0.5 = dot, 1 = bottom edge */
  fromY: 0 | 0.5 | 1;
  toLane: number;
  toY: 0 | 0.5 | 1;
  /** Index into the palette (`color % GRAPH_PALETTE_SIZE`). */
  color: number;
}

export interface GraphRow {
  sha: string;
  /** Lane of the commit dot. */
  col: number;
  /** Palette index of the dot. */
  color: number;
  lines: GraphLine[];
  /** Highest lane index used by this row + 1 (dot and lines). */
  lanes: number;
  /** More than one parent. */
  isMerge: boolean;
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Max `lanes` over all rows. */
  maxLanes: number;
}

function firstFree(lanes: (string | null)[]): number {
  const i = lanes.indexOf(null);
  return i === -1 ? lanes.length : i;
}

export function layoutGraph(commits: readonly GraphInput[]): GraphLayout {
  const lanes: (string | null)[] = []; // sha each lane is waiting for
  const colors: number[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];
  let maxLanes = 0;

  for (const c of commits) {
    const before = lanes.slice();
    const incoming: number[] = [];
    before.forEach((s, k) => {
      if (s === c.sha) incoming.push(k);
    });

    let col: number;
    if (incoming.length > 0) {
      col = incoming[0];
    } else {
      // A branch tip nobody points to: start a new lane.
      col = firstFree(lanes);
      colors[col] = nextColor++;
    }
    const color = colors[col];
    const lines: GraphLine[] = [];

    // Lanes entering the row: converge on the dot, or run straight through.
    before.forEach((s, k) => {
      if (s === null) return;
      if (s === c.sha) lines.push({ fromLane: k, fromY: 0, toLane: col, toY: 0.5, color: colors[k] });
      else lines.push({ fromLane: k, fromY: 0, toLane: k, toY: 1, color: colors[k] });
    });
    for (const k of incoming) lanes[k] = null;
    lanes[col] = null;

    // Lanes leaving the row: one per parent.
    c.parents.forEach((p, i) => {
      const j = lanes.indexOf(p);
      if (j !== -1) {
        // Parent already has a lane (another child reached it first): join it.
        lines.push({ fromLane: col, fromY: 0.5, toLane: j, toY: 1, color: colors[j] });
      } else if (i === 0) {
        lanes[col] = p;
        colors[col] = color;
        lines.push({ fromLane: col, fromY: 0.5, toLane: col, toY: 1, color });
      } else {
        const nl = firstFree(lanes);
        lanes[nl] = p;
        colors[nl] = nextColor++;
        lines.push({ fromLane: col, fromY: 0.5, toLane: nl, toY: 1, color: colors[nl] });
      }
    });

    let used = col + 1;
    for (const l of lines) used = Math.max(used, l.fromLane + 1, l.toLane + 1);
    maxLanes = Math.max(maxLanes, used);
    rows.push({ sha: c.sha, col, color, lines, lanes: used, isMerge: c.parents.length > 1 });
  }
  return { rows, maxLanes };
}

/** Pseudo-sha of the synthetic "Uncommitted Changes" row. */
export const UNCOMMITTED = "*uncommitted*";

/** Prepends the uncommitted-changes pseudo commit (parent = HEAD) to `commits`. */
export function withUncommitted<T extends GraphInput>(commits: readonly T[], headSha: string): GraphInput[] {
  return [{ sha: UNCOMMITTED, parents: [headSha] }, ...commits];
}
