// Pure helpers for auto-reconnect (docs/GUIDE.md §13.4.A). No runes, no I/O,
// so they can be unit-tested with plain `tsx --test`.

import type { ErrorKind } from "./types";

/** Seconds to wait after the Nth failed attempt: 1, 2, 5, 10, then 30 forever. */
export const BACKOFF_STEPS_S = [1, 2, 5, 10, 30] as const;
/** Stop retrying this long after the drop; the user gets a "Retry" button. */
export const GIVE_UP_AFTER_MS = 10 * 60 * 1000;
/** A wall-clock jump bigger than this between two ticks means the PC slept. */
export const SLEEP_JUMP_MS = 30_000;
export const TICK_MS = 5_000;

/** Delay (ms) before attempt `n` (1-based) after `n - 1` failures. Attempt 1 is immediate. */
export function backoffDelayMs(attempt: number): number {
  if (attempt <= 1) return 0;
  const i = Math.min(attempt - 2, BACKOFF_STEPS_S.length - 1);
  return BACKOFF_STEPS_S[i] * 1000;
}

/** True once the next attempt would start after the give-up deadline. */
export function shouldGiveUp(elapsedMs: number, nextDelayMs: number): boolean {
  return elapsedMs + nextDelayMs > GIVE_UP_AFTER_MS;
}

/** Did the wall clock leap forward more than `SLEEP_JUMP_MS` beyond one tick (laptop sleep)? */
export function isClockJump(lastTickMs: number, nowMs: number, tickMs = TICK_MS): boolean {
  return nowMs - lastTickMs > tickMs + SLEEP_JUMP_MS;
}

export type ReconnectErrorClass = "prompt" | "fatal" | "retry";

/** How a failed reconnect attempt is handled: ask the user once, stop, or back off and retry. */
export function classifyReconnectError(kind: ErrorKind | undefined): ReconnectErrorClass {
  switch (kind) {
    case "NeedPassword":
    case "NeedPassphrase":
    case "HostKeyUnknown":
      return "prompt";
    case "HostKeyChanged":
    case "AuthFailed":
    case "Config":
      return "fatal";
    default:
      return "retry";
  }
}
