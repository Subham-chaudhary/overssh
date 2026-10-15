import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Bug-hunt H5b: "Pause" freezes one VM's snapshot. Connecting / switching to another VM (the
// Dashboard follows the active workspace) must not keep showing the frozen snapshot of the first
// VM under the second VM's name, and the second VM must stream at the normal rate, not the paused one.
export const scenario: Scenario = {
  name: "dashboard: pause belongs to the paused VM, a second VM is live",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "1 session");
    await page.getByRole("button", { name: "Dashboard" }).click();
    await waitFor(async () => (await page.locator('[data-testid="monitor-view"]').count()) === 1, "dashboard");
    await waitFor(async () => (await page.locator('[data-testid="monitor-load"]').count()) === 1, "first snapshot");
    await page.locator('[data-testid="monitor-pause"]').click();
    assert((await page.getByText("Paused", { exact: true }).count()) === 1, "paused badge on alpha");

    await page.getByRole("button", { name: "Hosts" }).click();
    await page.locator('[aria-label="Connect beta"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 2, "2 sessions");
    await page.getByRole("button", { name: "Dashboard" }).click();
    await waitFor(async () => (await page.locator('[data-testid="monitor-view"]').count()) === 1, "dashboard again");

    const betaId = await page.evaluate(() => window.__harness.sessions().find((s) => s.label === "beta")?.id ?? "");
    assert(betaId !== "", "beta session id");
    await waitFor(
      async () => (await page.evaluate((id) => window.__harness.monitorRunning().some((m) => m.sessionId === id && m.intervalMs === 2000), betaId)) === true,
      "beta streams at the normal 2 s rate (not the paused slow rate)",
    );
    assert((await page.getByText("Paused", { exact: true }).count()) === 0, "no paused badge on beta");
  },
};
