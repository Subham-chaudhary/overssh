import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutGraph, UNCOMMITTED, withUncommitted } from "../../src/lib/git/graph";

const L = (rows: ReturnType<typeof layoutGraph>["rows"]) => rows.map((r) => r.col);

test("linear history stays in lane 0 with one color", () => {
  const g = layoutGraph([
    { sha: "c", parents: ["b"] },
    { sha: "b", parents: ["a"] },
    { sha: "a", parents: [] },
  ]);
  assert.deepEqual(L(g.rows), [0, 0, 0]);
  assert.equal(g.maxLanes, 1);
  assert.equal(new Set(g.rows.map((r) => r.color)).size, 1);
  assert.equal(
    g.rows[2].lines.some((l) => l.toY === 1),
    false,
    "root has no outgoing line",
  );
  assert.equal(g.rows[0].lines.length, 1);
});

test("merge commit opens a second lane for the second parent", () => {
  const g = layoutGraph([
    { sha: "m", parents: ["b", "f"] },
    { sha: "f", parents: ["a"] },
    { sha: "b", parents: ["a"] },
    { sha: "a", parents: [] },
  ]);
  assert.deepEqual(L(g.rows), [0, 1, 0, 1]);
  assert.equal(g.maxLanes, 2);
  const m = g.rows[0];
  assert.equal(m.isMerge, true);
  const out = m.lines.filter((l) => l.fromY === 0.5);
  assert.deepEqual(out.map((l) => l.toLane).sort(), [0, 1]);
  assert.notEqual(out[0].color, out[1].color);
  // f's parent `a` is not yet waiting anywhere (b has not been seen), so f keeps lane 1.
  const f = g.rows[1];
  assert.ok(f.lines.some((l) => l.fromLane === 1 && l.fromY === 0.5 && l.toLane === 1 && l.toY === 1));
  // b: its parent `a` already waits in lane 1, so b curves into it and lane 0 ends.
  const b = g.rows[2];
  assert.ok(b.lines.some((l) => l.fromLane === 0 && l.fromY === 0.5 && l.toLane === 1 && l.toY === 1));
  // a sits in lane 1 (where it was waiting).
  assert.equal(g.rows[3].col, 1);
});

test("branch point: the second child curves into the parent's lane", () => {
  const g = layoutGraph([
    { sha: "x", parents: ["a"] },
    { sha: "y", parents: ["a"] },
    { sha: "a", parents: [] },
  ]);
  assert.deepEqual(L(g.rows), [0, 1, 0]);
  assert.ok(g.rows[1].lines.some((l) => l.fromLane === 1 && l.fromY === 0.5 && l.toLane === 0 && l.toY === 1));
});

test("two children waiting on one parent converge on its dot", () => {
  // a is awaited in lanes 0 (from x) and 1 (from the merge's second parent chain).
  const g = layoutGraph([
    { sha: "m", parents: ["x", "y"] },
    { sha: "x", parents: ["a"] },
    { sha: "y", parents: ["a"] },
    { sha: "a", parents: [] },
  ]);
  assert.deepEqual(L(g.rows), [0, 0, 1, 0]);
  const a = g.rows[3];
  assert.deepEqual(a.lines.filter((l) => l.toY === 0.5).map((l) => l.fromLane), [0]);
});

test("a freed lane is reused and gets a fresh color", () => {
  const g = layoutGraph([
    { sha: "m", parents: ["b", "f"] },
    { sha: "f", parents: [] },
    { sha: "b", parents: ["c"] },
    { sha: "t", parents: [] },
    { sha: "c", parents: [] },
  ]);
  assert.equal(g.rows[3].col, 1, "lane 1 was freed when f (root) ended");
  assert.notEqual(g.rows[3].color, g.rows[1].color);
});

test("octopus merge uses one lane per extra parent", () => {
  const g = layoutGraph([
    { sha: "o", parents: ["a", "b", "c"] },
    { sha: "b", parents: [] },
    { sha: "c", parents: [] },
    { sha: "a", parents: [] },
  ]);
  assert.equal(g.rows[0].lines.filter((l) => l.fromY === 0.5).length, 3);
  assert.equal(g.maxLanes, 3);
  assert.deepEqual(L(g.rows), [0, 1, 2, 0]);
});

test("unloaded parents keep their lane open to the bottom", () => {
  const g = layoutGraph([{ sha: "c", parents: ["missing"] }]);
  assert.ok(g.rows[0].lines.some((l) => l.toY === 1));
});

test("uncommitted pseudo-row links to HEAD", () => {
  const g = layoutGraph(withUncommitted([{ sha: "h", parents: [] }], "h"));
  assert.equal(g.rows[0].sha, UNCOMMITTED);
  assert.deepEqual(L(g.rows), [0, 0]);
});

test("lines of adjacent rows join up", () => {
  const commits = [
    { sha: "m2", parents: ["m1", "x2"] },
    { sha: "x2", parents: ["x1"] },
    { sha: "m1", parents: ["b", "y1"] },
    { sha: "y1", parents: ["a"] },
    { sha: "x1", parents: ["a"] },
    { sha: "b", parents: ["a"] },
    { sha: "a", parents: [] },
  ];
  const g = layoutGraph(commits);
  for (let i = 0; i < g.rows.length - 1; i++) {
    const bottoms = new Set(g.rows[i].lines.filter((l) => l.toY === 1).map((l) => l.toLane));
    const tops = new Set(g.rows[i + 1].lines.filter((l) => l.fromY === 0).map((l) => l.fromLane));
    assert.deepEqual(tops, bottoms, `row ${i} to ${i + 1}`);
  }
});
