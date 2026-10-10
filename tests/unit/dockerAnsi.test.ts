import { test } from "node:test";
import assert from "node:assert/strict";
import { ansiSegments } from "../../src/lib/docker/ansi";

test("plain text is one segment", () => {
  assert.deepEqual(ansiSegments("hello"), [{ t: "hello", cls: "" }]);
  assert.deepEqual(ansiSegments(""), [{ t: "", cls: "" }]);
});

test("colours, bold and reset", () => {
  const s = ansiSegments("a\x1b[31mred\x1b[1;32mgreen bold\x1b[0m plain");
  assert.deepEqual(s.map((x) => x.t), ["a", "red", "green bold", " plain"]);
  assert.equal(s[1].cls, "text-red-500");
  assert.equal(s[2].cls, "text-green-500 font-bold");
  assert.equal(s[3].cls, "");
});

test("256/truecolor sequences and other escapes are dropped without corrupting text", () => {
  const s = ansiSegments("\x1b[38;5;208morange\x1b[0m\x1b[2K\x1b[Ktail");
  assert.equal(s.map((x) => x.t).join(""), "orangetail");
  const t = ansiSegments("\x1b[38;2;1;2;3mrgb\x1b[31mred");
  assert.equal(t.map((x) => x.t).join(""), "rgbred");
  assert.equal(t[1].cls, "text-red-500");
});
