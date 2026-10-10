// Pure split-pane layout for the detached terminal window (docs/GUIDE.md §15.3.S).
//
// The layout is a binary tree: a leaf is one pane showing one terminal (by its stable
// tab key, `TerminalTab.key ?? id`, which survives auto-reconnect), a split holds two
// children side by side ("row") or stacked ("col") with a ratio for the first child.
// Everything here is plain data in / plain data out so it can be unit tested.

export type SplitDir = "row" | "col";

export interface Leaf {
  type: "leaf";
  id: string;
  /** Stable terminal key, or null while a freshly split pane waits for its new terminal. */
  key: string | null;
}

export interface Split {
  type: "split";
  id: string;
  dir: SplitDir;
  /** Share of the available space given to `a` (0..1). */
  ratio: number;
  a: Node;
  b: Node;
}

export type Node = Leaf | Split;

export const MAX_PANES = 4;
export const DIVIDER = 4;
/** Height of a pane's title strip (shown only while the window is split). */
export const PANE_HEADER = 22;
export const MIN_PANE = { w: 160, h: PANE_HEADER + 80 };

let counter = 0;
export function nextId(): string {
  counter += 1;
  return `n${counter}`;
}

export function newLeaf(key: string | null = null): Leaf {
  return { type: "leaf", id: nextId(), key };
}

export function leaves(n: Node): Leaf[] {
  return n.type === "leaf" ? [n] : [...leaves(n.a), ...leaves(n.b)];
}

export function findLeaf(n: Node, id: string): Leaf | null {
  return leaves(n).find((l) => l.id === id) ?? null;
}

function mapNode(n: Node, f: (n: Node) => Node | null): Node {
  const r = f(n);
  if (r) return r;
  if (n.type === "leaf") return n;
  return { ...n, a: mapNode(n.a, f), b: mapNode(n.b, f) };
}

/** Splits leaf `leafId`: it becomes `a`, a new empty leaf (key null) becomes `b`.
 * Returns null when the pane limit is reached or the leaf is unknown. */
export function splitLeaf(
  root: Node,
  leafId: string,
  dir: SplitDir,
  max = MAX_PANES,
): { root: Node; leafId: string } | null {
  if (leaves(root).length >= max || !findLeaf(root, leafId)) return null;
  const fresh = newLeaf(null);
  const next = mapNode(root, (n) =>
    n.type === "leaf" && n.id === leafId
      ? { type: "split", id: nextId(), dir, ratio: 0.5, a: n, b: fresh }
      : null,
  );
  return { root: next, leafId: fresh.id };
}

/** Removes a leaf; its sibling takes the parent's place. `focus` is the leaf that
 * should get focus afterwards (the sibling's nearest leaf). Null for the only pane. */
export function removeLeaf(root: Node, leafId: string): { root: Node; focus: string } | null {
  if (root.type === "leaf" || !findLeaf(root, leafId)) return null;
  let focus = "";
  const walk = (n: Node): Node => {
    if (n.type === "leaf") return n;
    if (n.a.type === "leaf" && n.a.id === leafId) {
      focus = leaves(n.b)[0].id;
      return n.b;
    }
    if (n.b.type === "leaf" && n.b.id === leafId) {
      const ls = leaves(n.a);
      focus = ls[ls.length - 1].id;
      return n.a;
    }
    return { ...n, a: walk(n.a), b: walk(n.b) };
  };
  return { root: walk(root), focus };
}

export function setRatio(root: Node, splitId: string, ratio: number): Node {
  const r = Math.min(0.95, Math.max(0.05, ratio));
  return mapNode(root, (n) => (n.type === "split" && n.id === splitId ? { ...n, ratio: r } : null));
}

export function setLeafKey(root: Node, leafId: string, key: string | null): Node {
  return mapNode(root, (n) => (n.type === "leaf" && n.id === leafId ? { ...n, key } : null));
}

// --- geometry ------------------------------------------------------------------

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanePlacement extends Rect {
  id: string;
  key: string | null;
}

export interface DividerPlacement extends Rect {
  /** Id of the split this divider resizes. */
  id: string;
  dir: SplitDir;
  /** Start (x or y) and length of the space the two children share, for drag maths. */
  areaStart: number;
  areaSize: number;
  /** Smallest/largest ratio that keeps both sides at their minimum size. */
  minRatio: number;
  maxRatio: number;
}

export interface Placement {
  /** False when even the minimum pane sizes do not fit: only the focused pane is shown. */
  fits: boolean;
  panes: PanePlacement[];
  dividers: DividerPlacement[];
}

/** Smallest size a subtree can be squeezed to. */
export function minSize(n: Node, min = MIN_PANE, gap = DIVIDER): { w: number; h: number } {
  if (n.type === "leaf") return { w: min.w, h: min.h };
  const a = minSize(n.a, min, gap);
  const b = minSize(n.b, min, gap);
  return n.dir === "row"
    ? { w: a.w + gap + b.w, h: Math.max(a.h, b.h) }
    : { w: Math.max(a.w, b.w), h: a.h + gap + b.h };
}

export function computePlacement(
  root: Node,
  width: number,
  height: number,
  min = MIN_PANE,
  gap = DIVIDER,
): Placement {
  const need = minSize(root, min, gap);
  const fits = width >= need.w && height >= need.h;
  const panes: PanePlacement[] = [];
  const dividers: DividerPlacement[] = [];
  if (!fits) return { fits, panes, dividers };

  const place = (n: Node, r: Rect): void => {
    if (n.type === "leaf") {
      panes.push({ id: n.id, key: n.key, ...r });
      return;
    }
    const row = n.dir === "row";
    const total = row ? r.w : r.h;
    const avail = total - gap;
    const aMin = row ? minSize(n.a, min, gap).w : minSize(n.a, min, gap).h;
    const bMin = row ? minSize(n.b, min, gap).w : minSize(n.b, min, gap).h;
    const sizeA = Math.round(Math.min(Math.max(n.ratio * avail, aMin), avail - bMin));
    const sizeB = avail - sizeA;
    if (row) {
      place(n.a, { x: r.x, y: r.y, w: sizeA, h: r.h });
      place(n.b, { x: r.x + sizeA + gap, y: r.y, w: sizeB, h: r.h });
      dividers.push({
        id: n.id,
        dir: "row",
        x: r.x + sizeA,
        y: r.y,
        w: gap,
        h: r.h,
        areaStart: r.x,
        areaSize: avail,
        minRatio: aMin / avail,
        maxRatio: 1 - bMin / avail,
      });
    } else {
      place(n.a, { x: r.x, y: r.y, w: r.w, h: sizeA });
      place(n.b, { x: r.x, y: r.y + sizeA + gap, w: r.w, h: sizeB });
      dividers.push({
        id: n.id,
        dir: "col",
        x: r.x,
        y: r.y + sizeA,
        w: r.w,
        h: gap,
        areaStart: r.y,
        areaSize: avail,
        minRatio: aMin / avail,
        maxRatio: 1 - bMin / avail,
      });
    }
  };
  place(root, { x: 0, y: 0, w: width, h: height });
  return { fits, panes, dividers };
}

/** Ratio a divider should get when the pointer is at `pos` (x for "row", y for "col"). */
export function ratioFromPointer(d: DividerPlacement, pos: number): number {
  const raw = (pos - d.areaStart - DIVIDER / 2) / d.areaSize;
  return Math.min(d.maxRatio, Math.max(d.minRatio, raw));
}

export type Direction = "left" | "right" | "up" | "down";

/** Pane to move focus to from `fromId` in `dir` (geometric: nearest centre beyond the
 * edge, preferring panes that overlap on the other axis). Null when there is none. */
export function neighbor(panes: PanePlacement[], fromId: string, dir: Direction): string | null {
  const from = panes.find((p) => p.id === fromId);
  if (!from) return null;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let best: { id: string; score: number } | null = null;
  for (const p of panes) {
    if (p.id === fromId) continue;
    const px = p.x + p.w / 2;
    const py = p.y + p.h / 2;
    const dx = px - cx;
    const dy = py - cy;
    const beyond =
      dir === "left" ? dx < 0 && p.x + p.w <= from.x + 1
      : dir === "right" ? dx > 0 && p.x >= from.x + from.w - 1
      : dir === "up" ? dy < 0 && p.y + p.h <= from.y + 1
      : dy > 0 && p.y >= from.y + from.h - 1;
    if (!beyond) continue;
    const horizontal = dir === "left" || dir === "right";
    const overlap = horizontal
      ? Math.min(from.y + from.h, p.y + p.h) - Math.max(from.y, p.y) > 0
      : Math.min(from.x + from.w, p.x + p.w) - Math.max(from.x, p.x) > 0;
    const score = (horizontal ? Math.abs(dx) : Math.abs(dy)) + (overlap ? 0 : 10_000) + (horizontal ? Math.abs(dy) : Math.abs(dx)) * 0.01;
    if (!best || score < best.score) best = { id: p.id, score };
  }
  return best?.id ?? null;
}

// --- keeping the layout in step with the tab list ---------------------------------

export interface LayoutState {
  root: Node;
  focusId: string;
}

/**
 * Brings the layout in line with the open terminals:
 *  - a pane whose terminal is gone collapses (its sibling takes the space); the last
 *    pane stays and simply shows whatever is active;
 *  - the active terminal is shown in the focused pane, unless another pane already
 *    shows it, in which case that pane gets focus;
 *  - if the focused pane was the one that collapsed, the terminal in the pane that
 *    took over becomes the active one (`activate`), instead of the store's neighbour.
 * A pane waiting for its new terminal (key null) keeps focus until one arrives.
 */
export function reconcile(
  state: LayoutState,
  tabKeys: readonly string[],
  activeKey: string | null,
): { state: LayoutState; activate: string | null } {
  let { root, focusId } = state;
  let focusCollapsed = false;
  const alive = new Set(tabKeys);

  for (const l of leaves(root)) {
    if (l.key === null || alive.has(l.key)) continue;
    const r = removeLeaf(root, l.id);
    if (r) {
      root = r.root;
      if (l.id === focusId) {
        focusId = r.focus;
        focusCollapsed = true;
      }
    } else {
      root = setLeafKey(root, l.id, null); // last pane: its terminal is gone
    }
  }
  if (!findLeaf(root, focusId)) focusId = leaves(root)[0].id;

  let activate: string | null = null;
  const focus = findLeaf(root, focusId)!;
  if (focus.key === null && !focusCollapsed && leaves(root).length > 1) {
    // A new pane is waiting for its terminal: if the active one is not shown yet, it is for this pane.
    if (activeKey && !leaves(root).some((l) => l.key === activeKey)) {
      root = setLeafKey(root, focusId, activeKey);
    }
    return { state: { root, focusId }, activate };
  }
  if (focusCollapsed && focus.key !== null) {
    if (focus.key !== activeKey) activate = focus.key;
  } else if (activeKey) {
    const shown = leaves(root).find((l) => l.key === activeKey);
    if (shown) focusId = shown.id;
    else root = setLeafKey(root, focusId, activeKey);
  }
  return { state: { root, focusId }, activate };
}

// --- persistence ------------------------------------------------------------------

export function serialize(state: LayoutState): string {
  return JSON.stringify(state);
}

function validNode(n: unknown, depth = 0): n is Node {
  if (depth > 6 || typeof n !== "object" || n === null) return false;
  const o = n as Record<string, unknown>;
  if (o.type === "leaf") return typeof o.id === "string" && (o.key === null || typeof o.key === "string");
  if (o.type !== "split") return false;
  return (
    typeof o.id === "string" &&
    (o.dir === "row" || o.dir === "col") &&
    typeof o.ratio === "number" &&
    validNode(o.a, depth + 1) &&
    validNode(o.b, depth + 1)
  );
}

/** Gives every node a fresh id (so restored ids never clash with the counter). */
function reid(n: Node, ids: Map<string, string>): Node {
  const id = nextId();
  ids.set(n.id, id);
  if (n.type === "leaf") return { ...n, id };
  return { ...n, id, ratio: Math.min(0.95, Math.max(0.05, n.ratio)), a: reid(n.a, ids), b: reid(n.b, ids) };
}

/** Parses a stored layout; drops panes whose terminal no longer exists. Returns null
 * unless at least two panes survive (a single pane is the default state anyway). */
export function restore(raw: string | null, tabKeys: readonly string[]): LayoutState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const p = parsed as { root?: unknown; focusId?: unknown };
  if (!p || !validNode(p.root)) return null;
  const ids = new Map<string, string>();
  let root = reid(p.root, ids);
  const alive = new Set(tabKeys);
  for (const l of leaves(root)) {
    if (l.key !== null && alive.has(l.key)) continue;
    const r = removeLeaf(root, l.id);
    if (!r) return null;
    root = r.root;
  }
  const ls = leaves(root);
  if (ls.length < 2 || ls.length > MAX_PANES) return null;
  const wanted = typeof p.focusId === "string" ? ids.get(p.focusId) : undefined;
  const focusId = wanted && findLeaf(root, wanted) ? wanted : ls[0].id;
  return { root, focusId };
}
