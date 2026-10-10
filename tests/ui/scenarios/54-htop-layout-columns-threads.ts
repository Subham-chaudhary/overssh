import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// htop tab (§14.4.H): header meters, column picker (persisted), threads + kernel
// toggles, user filter, tree fold with the keyboard, narrow width hides columns.
export const scenario: Scenario = {
  name: "htop tab: meters, column picker, threads/kernel toggles, user filter, tree fold, responsive columns",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "1 session");
    await page.getByRole("button", { name: "Dashboard" }).click();

    // Overview has no process table; htop is its own tab next to Overview/Disk/Cron
    await waitFor(async () => (await page.locator('[data-testid="cpu-core"]').count()) === 4, "overview meters");
    assert((await page.locator('[data-testid="proc-row"]').count()) === 0, "no process table in Overview");
    // (the Services tab may carry a failed-units count badge, so strip trailing digits)
    const tabs = (await page.locator('[data-testid="monitor-tabs"] [role="tab"]').allInnerTexts()).map((s) => s.replace(/\d+$/, ""));
    assert(tabs.join("|") === "Overview|htop|Services|Disk usage|Cron", `tab order, got ${tabs.join("|")}`);
    await page.locator('[data-testid="monitor-tab-htop"]').click();

    // header meters
    await waitFor(async () => (await page.locator('[data-testid="htop-cpu-core"]').count()) === 4, "4 per-core bars");
    for (const id of ["htop-mem", "htop-swap", "htop-tasks", "htop-load", "htop-uptime"]) {
      assert((await page.locator(`[data-testid="${id}"]`).count()) === 1, `${id} present`);
    }
    assert((await page.locator('[data-testid="htop-load"]').innerText()).includes("0.52"), "load average shown");

    // default columns: SHR on, PPID off
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 6, "6 rows (kernel hidden)");
    assert((await page.locator('th[data-col="shr"]').count()) === 1, "SHR column visible by default");
    assert((await page.locator('th[data-col="ppid"]').count()) === 0, "PPID hidden by default");

    // column picker + persistence
    await page.locator('[data-testid="proc-columns"]').click();
    await page.locator('[data-testid="proc-col-ppid"]').click();
    await waitFor(async () => (await page.locator('th[data-col="ppid"]').count()) === 1, "PPID column appears");
    await page.keyboard.press("Escape");
    const saved = await page.evaluate(() => localStorage.getItem("overssh.htop.v1") ?? "");
    assert(saved.includes('"ppid"'), "column choice persisted");

    // kernel threads toggle (K)
    await page.locator('[data-testid="proc-hide-kernel"]').click();
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 7, "kernel thread row shown");
    await page.locator('[data-testid="proc-hide-kernel"]').click();
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 6, "kernel thread hidden again");

    // threads toggle restarts the stream with threads on, adds thread rows
    await page.locator('[data-testid="proc-threads"]').click();
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 8, "2 thread rows added");
    assert(
      (await page.evaluate(() => window.__harness.monitorRunning().some((m) => m.threads))) === true,
      "backend asked for threads",
    );
    await page.locator('[data-testid="proc-threads"]').click();
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 6, "thread rows gone");
    await waitFor(async () => await page.evaluate(() => window.__harness.monitorRunning().every((m) => !m.threads)), "threads off");

    // user filter
    await page.locator('[data-testid="proc-user"]').click();
    await page.getByRole("option", { name: "alice" }).click();
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 2, "alice owns 2 processes");
    await page.locator('[data-testid="proc-user"]').click();
    await page.getByRole("option", { name: "All users" }).click();
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 6, "all users again");

    // tree view: Left folds the selected parent, Right unfolds
    await page.locator('[data-testid="proc-tree"]').click();
    await waitFor(async () => (await page.locator('[data-testid="proc-toggle"]').count()) > 0, "fold toggles in tree");
    await page.locator('[data-testid="proc-row"][data-pid="412"]').click();
    await page.keyboard.press("ArrowLeft");
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 4, "children of 412 folded");
    await page.keyboard.press("ArrowRight");
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 6, "children unfolded");

    // responsive: a narrow window hides low-priority columns, wide shows them
    assert((await page.locator('th[data-col="pri"]').count()) === 1, "PRI visible at 1280px");
    await page.setViewportSize({ width: 760, height: 720 });
    await waitFor(async () => (await page.locator('th[data-col="pri"]').count()) === 0, "PRI hidden when narrow");
    assert((await page.locator('th[data-col="command"]').count()) === 1, "Command always visible");
    assert((await page.locator('th[data-col="cpu"]').count()) === 1, "CPU% always visible");
    await page.setViewportSize({ width: 1280, height: 720 });
    await waitFor(async () => (await page.locator('th[data-col="pri"]').count()) === 1, "PRI back when wide");
  },
};
