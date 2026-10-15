import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Bug-hunt H5b: leaving and re-entering the Services tab while a list refresh is still in flight
// must leave exactly one 5 s polling chain. Before the fix the old tick re-armed its timer next to
// the new one, so every cycle ran two `systemctl list-units` on the VM (and it doubled again with
// each such tab flip).
export const scenario: Scenario = {
  name: "services tab: flipping tabs during a refresh keeps a single polling chain",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "1 session");
    await page.getByRole("button", { name: "Dashboard" }).click();
    await waitFor(async () => (await page.locator('[data-testid="monitor-tab-services"]').count()) === 1, "tabs");

    await page.evaluate(() => window.__systemd.set({ listDelayMs: 700 }));
    await page.locator('[data-testid="monitor-tab-services"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__systemd.calls().filter((c) => c.cmd === "systemd_list").length)) >= 1, "first list call");
    // The first refresh is in flight (700 ms): leave and come back.
    await page.locator('[data-testid="monitor-tab-overview"]').click();
    await page.locator('[data-testid="monitor-tab-services"]').click();
    // Let that refresh settle, then count the list calls over two and a bit poll cycles.
    await waitFor(async () => (await page.locator('[data-testid="svc-row"]').count()) > 0, "rows after the refresh", 8000);
    await page.waitForTimeout(1500);
    const before = await page.evaluate(() => window.__systemd.calls().filter((c) => c.cmd === "systemd_list").length);
    await page.waitForTimeout(13_000);
    const after = await page.evaluate(() => window.__systemd.calls().filter((c) => c.cmd === "systemd_list").length);
    const n = after - before;
    // One chain: a cycle every ~5.7 s (5 s timer + 0.7 s answer) = 2 calls in 13 s (3 at the very most).
    // Two chains: 4 or more.
    assert(n >= 1 && n <= 3, `expected a single polling chain (<= 3 list calls in 13 s), got ${n}`);
    await page.evaluate(() => window.__systemd.set({ listDelayMs: 0 }));
  },
};
