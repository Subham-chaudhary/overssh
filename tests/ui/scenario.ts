// Shared scenario contract for tests/ui/run.ts's auto-discovery. Add a new
// scenario by dropping a `tests/ui/scenarios/<name>.ts` file that exports
// `scenario` (or a default export) matching this shape — `run.ts` picks it up
// automatically, no registration needed.
import type { Page } from "playwright-core";

export interface ScenarioCtx {
  /** A fresh page, already navigated to the harness and with the app mounted
   * (i.e. `#app` is attached) before `run()` is called. */
  page: Page;
  /** The harness URL this page was loaded from (rarely needed directly). */
  baseUrl: string;
}

/** Context passed to an optional `beforeLoad` hook — just the fresh page,
 * *before* `run.ts` navigates it to the harness. Use `page.addInitScript(...)`
 * here to inject state that must exist before the app (and mockBackend.ts)
 * boot, since by the time `run()` is called the app has already mounted and
 * self-triggered loads (e.g. `hosts.svelte.ts`'s `initHosts()`) have already
 * fired. */
export interface BeforeLoadCtx {
  page: Page;
}

export interface Scenario {
  /** Short, unique, human-readable name shown in the PASS/FAIL report. */
  name: string;
  /** Optional: runs once, right after the scenario's page is created but
   * *before* `run.ts` navigates it to the harness URL. The only reliable way
   * to seed state (e.g. a broken persisted "profiles" store) that the app
   * must see on its very first load — see `mockBackend.ts`'s
   * `window.__HARNESS_SEED_STORES__`. */
  beforeLoad?(ctx: BeforeLoadCtx): Promise<void>;
  /** Throw (or let a Playwright assertion/timeout throw) to fail the
   * scenario. An uncaught in-page exception during `run()` also fails it,
   * even if `run()` itself doesn't throw — `run.ts` watches `pageerror`. */
  run(ctx: ScenarioCtx): Promise<void>;
}

/** Small polling helper (Playwright's own `expect` isn't available outside
 * @playwright/test): retries `check()` until it returns true or `timeoutMs`
 * elapses, then throws `message`. */
export async function waitFor(
  check: () => Promise<boolean> | boolean,
  message: string,
  timeoutMs = 8000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${message}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}
