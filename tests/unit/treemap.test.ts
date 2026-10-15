import { test } from "node:test";
import assert from "node:assert/strict";
import { squarify } from "../../src/lib/treemap";

const box = { x: 0, y: 0, w: 100, h: 100 };
const finite = (r: { x: number; y: number; w: number; h: number }) => [r.x, r.y, r.w, r.h].every(Number.isFinite);

test("zero, negative and non-finite sizes are dropped", () => {
  assert.deepEqual(squarify([{ id: "a", value: 0 }, { id: "b", value: -3 }], box), []);
  const r = squarify([{ id: "a", value: Infinity }, { id: "b", value: NaN }, { id: "c", value: 4 }], box);
  assert.deepEqual(r.map((x) => x.id), ["c"]);
  assert.ok(r.every(finite));
});

test("one huge item next to tiny ones never produces NaN rectangles", () => {
  const r = squarify([{ id: "a", value: 1e18 }, { id: "b", value: 1 }, { id: "c", value: 1 }], box);
  assert.equal(r.length, 3);
  assert.ok(r.every(finite), JSON.stringify(r));
  assert.ok(Math.abs(r.reduce((s, x) => s + x.w * x.h, 0) - 10000) < 1);
});

test("areas tile the box", () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ id: String(i), value: (i % 9) + 1 }));
  const r = squarify(items, { x: 0, y: 0, w: 800, h: 500 });
  assert.equal(r.length, 200);
  assert.ok(Math.abs(r.reduce((s, x) => s + x.w * x.h, 0) - 400000) < 1e-6);
});
