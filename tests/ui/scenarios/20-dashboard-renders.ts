import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Connect alpha, open Dashboard: CPU meters + process rows render; sort and filter work;
// leaving the Dashboard stops polling.
export const scenario: Scenario = {
  name: "dashboard shows CPU meters and processes; sort + filter; stops polling when left",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "1 session");

    await page.getByRole("button", { name: "Dashboard" }).click();
    await waitFor(async () => (await page.locator('[data-testid="monitor-session"]').count()) === 1, "sidebar lists session");
    await waitFor(async () => (await page.locator('[data-testid="cpu-core"]').count()) === 4, "4 per-core meters");
    await waitFor(async () => (await page.locator('[data-testid="mem-meter"]').count()) === 1, "memory meter");
    await waitFor(async () => (await page.locator('[data-testid="spark-cpu"]').count()) === 1, "cpu sparkline");
    // processes moved to the htop tab (§14.4.H): the Overview has none
    assert((await page.locator('[data-testid="proc-row"]').count()) === 0, "overview has no process table");
    await page.locator('[data-testid="monitor-tab-htop"]').click();
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 6, "6 process rows");

    // default sort: CPU desc -> nginx first
    const firstPid = () => page.locator('[data-testid="proc-row"]').first().getAttribute("data-pid");
    assert((await firstPid()) === "1234", "highest CPU process first");

    // sort by PID: first click on a key that defaults to ascending
    await page.locator('th[data-col="pid"]').click();
    await waitFor(async () => (await firstPid()) === "1", "pid ascending puts PID 1 first");
    await page.locator('th[data-col="pid"]').click();
    await waitFor(async () => (await firstPid()) === "2345", "pid descending flips order");

    // filter
    await page.locator('[data-testid="proc-filter"]').fill("nginx");
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 1, "filter narrows to 1 row");
    await page.locator('[data-testid="proc-filter"]').fill("");
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 6, "filter cleared");

    // polling runs at the chosen interval for the visible session
    assert((await page.evaluate(() => window.__harness.monitorRunning().length)) >= 1, "monitor stream started");

    // leave the dashboard -> streams stop
    await page.getByRole("button", { name: "Hosts" }).click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.monitorRunning().length)) === 0, "monitor streams stopped after leaving");
  },
};
