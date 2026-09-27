import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backoffDelayMs,
  classifyReconnectError,
  GIVE_UP_AFTER_MS,
  isClockJump,
  shouldGiveUp,
} from "../../src/lib/reconnectLogic";

test("backoff schedule is 0, 1, 2, 5, 10, 30, 30 ...", () => {
  const got = [1, 2, 3, 4, 5, 6, 7, 50].map(backoffDelayMs);
  assert.deepEqual(got, [0, 1000, 2000, 5000, 10000, 30000, 30000, 30000]);
});

test("gives up after about 10 minutes", () => {
  assert.equal(shouldGiveUp(0, 1000), false);
  assert.equal(shouldGiveUp(GIVE_UP_AFTER_MS - 10_000, 30_000), true);
  assert.equal(shouldGiveUp(GIVE_UP_AFTER_MS - 60_000, 30_000), false);
});

test("clock jump needs more than 30 s beyond one tick", () => {
  assert.equal(isClockJump(0, 5_000), false);
  assert.equal(isClockJump(0, 12_000), false);
  assert.equal(isClockJump(0, 5_000 + 30_001), true);
});

test("error classes", () => {
  assert.equal(classifyReconnectError("NeedPassword"), "prompt");
  assert.equal(classifyReconnectError("HostKeyChanged"), "fatal");
  assert.equal(classifyReconnectError("Connection"), "retry");
  assert.equal(classifyReconnectError(undefined), "retry");
});
