import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIVIDER,
  MAX_PANES,
  MIN_PANE,
  computePlacement,
  leaves,
  neighbor,
  newLeaf,
  ratioFromPointer,
  reconcile,
  removeLeaf,
  restore,
  serialize,
  setLeafKey,
  setRatio,
  splitLeaf,
  type LayoutState,
  type Node,
} from "../../src/terminal-window/splitLayout";

function single(key: string | null): LayoutState {
  const l = newLeaf(key);
  return { root: l, focusId: l.id };
}

/** [a | b] with a focused. */
function two(a: string, b: string): LayoutState {
  const s = single(a);
  const r = splitLeaf(s.root, s.focusId, "row")!;
  return { root: setLeafKey(r.root, r.leafId, b), focusId: s.focusId };
}

test("splitLeaf adds an empty pane after the split one and respects the pane limit", () => {
  let st = single("a");
  for (let i = 1; i < MAX_PANES; i++) {
    const r = splitLeaf(st.root, st.focusId, i % 2 ? "row" : "col");
    assert.ok(r);
    st = { root: r.root, focusId: r.leafId };
  }
  assert.equal(leaves(st.root).length, MAX_PANES);
  assert.equal(splitLeaf(st.root, st.focusId, "row"), null);
  assert.equal(leaves(st.root).filter((l) => l.key === null).length, MAX_PANES - 1);
});

test("removeLeaf hands the space to the sibling and names the pane to focus", () => {
  const st = two("a", "b");
  const [la, lb] = leaves(st.root);
  const r1 = removeLeaf(st.root, la.id)!;
  assert.deepEqual(leaves(r1.root).map((l) => l.key), ["b"]);
  assert.equal(r1.focus, lb.id);
  const r2 = removeLeaf(st.root, lb.id)!;
  assert.deepEqual(leaves(r2.root).map((l) => l.key), ["a"]);
  assert.equal(r2.focus, la.id);
  assert.equal(removeLeaf(r1.root, lb.id), null, "the last pane cannot be removed");
});

test("placement: two columns share the width minus the divider; nothing overlaps", () => {
  const st = two("a", "b");
  const p = computePlacement(st.root, 1000, 500);
  assert.ok(p.fits);
  assert.equal(p.panes.length, 2);
  const [a, b] = p.panes;
  assert.equal(a.x, 0);
  assert.equal(a.w + DIVIDER + b.w, 1000);
  assert.equal(b.x, a.w + DIVIDER);
  assert.equal(a.h, 500);
  assert.equal(p.dividers.length, 1);
  assert.equal(p.dividers[0].x, a.w);
});

test("placement: a nested split tiles the whole area", () => {
  const s = two("a", "b");
  const lb = leaves(s.root)[1];
  const r = splitLeaf(s.root, lb.id, "col")!;
  const p = computePlacement(r.root, 900, 600);
  assert.equal(p.panes.length, 3);
  const area = p.panes.reduce((n, q) => n + q.w * q.h, 0);
  const gaps = p.dividers.reduce((n, d) => n + d.w * d.h, 0);
  assert.equal(area + gaps, 900 * 600);
});

test("placement: pane sizes never drop under the minimum; too small a window reports it", () => {
  const st = two("a", "b");
  const split = st.root as Extract<Node, { type: "split" }>;
  const squeezed = setRatio(st.root, split.id, 0.05);
  const p = computePlacement(squeezed, 800, 400);
  assert.ok(p.panes[0].w >= MIN_PANE.w, "left pane keeps its minimum width");
  const squeezedRight = setRatio(st.root, split.id, 0.95);
  const q = computePlacement(squeezedRight, 800, 400);
  assert.ok(q.panes[1].w >= MIN_PANE.w, "right pane keeps its minimum width");
  assert.equal(computePlacement(st.root, MIN_PANE.w * 2 - 1, 400).fits, false);
  assert.equal(computePlacement(st.root, 800, MIN_PANE.h - 1).fits, false);
});

test("ratioFromPointer clamps to the pane minimums", () => {
  const st = two("a", "b");
  const d = computePlacement(st.root, 800, 400).dividers[0];
  assert.ok(Math.abs(ratioFromPointer(d, 400 + DIVIDER / 2) - 0.5) < 0.01);
  const lo = ratioFromPointer(d, -50);
  const hi = ratioFromPointer(d, 5000);
  assert.ok(lo * d.areaSize >= MIN_PANE.w - 0.5);
  assert.ok((1 - hi) * d.areaSize >= MIN_PANE.w - 0.5);
});

test("neighbor finds the pane in the arrow direction", () => {
  const s = two("a", "b");
  const [la, lb] = leaves(s.root);
  const r = splitLeaf(s.root, lb.id, "col")!; // a | (b over new)
  const p = computePlacement(r.root, 1000, 600);
  assert.equal(neighbor(p.panes, la.id, "right"), lb.id, "right of a is the top-right pane");
  assert.equal(neighbor(p.panes, lb.id, "left"), la.id);
  assert.equal(neighbor(p.panes, lb.id, "down"), r.leafId);
  assert.equal(neighbor(p.panes, r.leafId, "up"), lb.id);
  assert.equal(neighbor(p.panes, la.id, "left"), null);
  assert.equal(neighbor(p.panes, la.id, "up"), null);
});

test("reconcile: a closed terminal collapses its pane and the sibling's terminal becomes active", () => {
  const st = two("a", "b"); // focus on a
  const r = reconcile(st, ["b"], "b"); // a was closed; the store picked b as the neighbour
  assert.deepEqual(leaves(r.state.root).map((l) => l.key), ["b"]);
  assert.equal(r.activate, null);

  const three = splitLeaf(st.root, leaves(st.root)[1].id, "col")!;
  const t: LayoutState = { root: setLeafKey(three.root, three.leafId, "c"), focusId: leaves(st.root)[0].id };
  // focused pane a closes; the store would activate "c" (an arbitrary neighbour) but the pane that took over shows b.
  const r2 = reconcile(t, ["b", "c"], "c");
  assert.equal(leaves(r2.state.root).length, 2);
  assert.equal(r2.activate, "b", "the terminal in the pane that took over is activated");
});

test("reconcile: unfocused pane closing keeps focus; last pane just follows the active terminal", () => {
  const st = two("a", "b");
  const lb = leaves(st.root)[1];
  const r = reconcile({ ...st, focusId: leaves(st.root)[0].id }, ["a"], "a");
  assert.deepEqual(leaves(r.state.root).map((l) => l.key), ["a"]);
  assert.equal(r.activate, null);
  assert.ok(!leaves(r.state.root).some((l) => l.id === lb.id));

  const solo = reconcile(single("a"), ["a", "z"], "z");
  assert.deepEqual(leaves(solo.state.root).map((l) => l.key), ["z"]);
});

test("reconcile: activating a terminal shown elsewhere moves focus; a hidden one replaces the focused pane", () => {
  const st = two("a", "b");
  const [la, lb] = leaves(st.root);
  const toB = reconcile(st, ["a", "b", "c"], "b");
  assert.equal(toB.state.focusId, lb.id);
  assert.deepEqual(leaves(toB.state.root).map((l) => l.key), ["a", "b"]);
  const toC = reconcile(st, ["a", "b", "c"], "c");
  assert.equal(toC.state.focusId, la.id);
  assert.deepEqual(leaves(toC.state.root).map((l) => l.key), ["c", "b"]);
});

test("reconcile: a new pane waits for its terminal and takes the next active one", () => {
  const s = single("a");
  const r = splitLeaf(s.root, s.focusId, "row")!;
  const pending: LayoutState = { root: r.root, focusId: r.leafId };
  // Nothing opened yet: layout untouched, focus stays on the new pane.
  const same = reconcile(pending, ["a"], "a");
  assert.equal(same.state.focusId, r.leafId);
  assert.deepEqual(leaves(same.state.root).map((l) => l.key), ["a", null]);
  // The new terminal arrives and becomes active.
  const filled = reconcile(pending, ["a", "n"], "n");
  assert.deepEqual(leaves(filled.state.root).map((l) => l.key), ["a", "n"]);
  assert.equal(filled.state.focusId, r.leafId);
});

test("reconcile: a rebound terminal (same key) keeps its pane", () => {
  // After an auto-reconnect the PTY id changes but the tab key does not; only keys are compared.
  const st = two("k1", "k2");
  const r = reconcile(st, ["k1", "k2"], "k1");
  assert.equal(r.state.root, st.root, "layout object unchanged");
});

test("serialize / restore round-trips and drops panes whose terminal vanished", () => {
  const st = two("a", "b");
  const raw = serialize(st);
  const back = restore(raw, ["a", "b"])!;
  assert.deepEqual(leaves(back.root).map((l) => l.key), ["a", "b"]);
  assert.equal(back.focusId, leaves(back.root)[0].id);
  assert.equal(restore(raw, ["a"]), null, "a single surviving pane is not a split");
  assert.equal(restore("not json", ["a"]), null);
  assert.equal(restore(null, ["a"]), null);
  assert.equal(restore(JSON.stringify({ root: { type: "split" }, focusId: "x" }), ["a"]), null);
});
