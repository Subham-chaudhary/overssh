import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_COLS, MAX_ROWS, parseCast } from "../../src/components/recordings/cast";

test("a hostile header cannot ask for a gigantic terminal", () => {
  const c = parseCast(JSON.stringify({ version: 2, width: 1e9, height: 1e9 }) + "\n" + JSON.stringify([0.1, "o", "x"]));
  assert.equal(c.width, MAX_COLS);
  assert.equal(c.height, MAX_ROWS);
  const d = parseCast(JSON.stringify({ width: "80", height: -3, title: 7 }));
  assert.deepEqual([d.width, d.height, d.title], [80, 24, ""]);
});

test("a header that is not an object is rejected with the friendly message", () => {
  for (const bad of ["null", "[1,2]", "42", "", "{nope"]) {
    assert.throws(() => parseCast(bad + "\n"), /Not an asciinema recording/);
  }
});

test("truncated and malformed event lines are skipped; idle gaps are capped", () => {
  const text = [
    JSON.stringify({ version: 2, width: 60, height: 10 }),
    JSON.stringify([0.5, "o", "a"]),
    "garbage",
    JSON.stringify([60, "o", "b"]),
    '[61, "o", "tru',
  ].join("\n");
  const c = parseCast(text, 2);
  assert.equal(c.events.length, 2);
  assert.equal(c.events[1].at, 2.5);
  assert.equal(c.duration, 2.5);
});
