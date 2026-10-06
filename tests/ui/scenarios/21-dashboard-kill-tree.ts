import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Select a process, F9 -> signal picker -> confirm -> proc_kill; tree toggle; pause badge.
export const scenario: Scenario = {
  name: "dashboard: select + F9 kill with confirm, tree view, pause",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "1 session");
    await page.getByRole("button", { name: "Dashboard" }).click();
    await page.locator('[data-testid="monitor-tab-htop"]').click();
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 6, "rows");

    await page.locator('[data-testid="proc-row"][data-pid="1234"]').click();
    await page.keyboard.press("F9");
    await page.locator('[data-testid="signal-dialog"]').waitFor();
    await page.locator('button[data-sig="KILL"]').click();
    // confirm dialog from app.ask
    await page.getByRole("button", { name: "Send SIGKILL" }).click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.kills().length)) === 1, "proc_kill called");
    const kills = await page.evaluate(() => window.__harness.kills());
    assert(kills[0].pid === 1234 && kills[0].signal === "KILL", "killed pid 1234 with KILL");

    // tree view: children come after their parent
    await page.locator('[data-testid="proc-tree"]').click();
    const pids = await page
      .locator('[data-testid="proc-row"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-pid")));
    assert(pids.indexOf("900") > pids.indexOf("412"), "child after parent in tree");
    assert(pids.indexOf("901") === pids.indexOf("900") + 1, "grandchild right after its parent in tree");

    // pause shows the badge
    await page.locator('[data-testid="monitor-pause"]').click();
    await waitFor(async () => (await page.getByText("Paused", { exact: true }).count()) > 0, "paused badge");
  },
};
