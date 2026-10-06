// docs/GUIDE.md §13.4.K: Ctrl+Tab switcher, MRU order (default), hold-Ctrl
// stepping, arrow/Enter navigation, commit on Ctrl release, Esc cancel.
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

export const scenario: Scenario = {
  name: "Ctrl+Tab switcher: MRU order, hold Ctrl to step, arrows, release commits",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await page.getByRole("button", { name: "Connect alpha" }).click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    const H = "/home/testuser";
    await waitFor(async () => (await page.locator(`[data-path="${H}/projects"]`).count()) === 1, "tree rendered");

    const open = async (path: string, tab: string) => {
      await page.locator(`[role="treeitem"][data-path="${path}"]`).click();
      await waitFor(async () => (await page.getByRole("tab", { name: tab }).count()) === 1, `${tab} open`);
    };
    const active = async () =>
      page.evaluate(() => document.querySelector('[aria-label="Open files"] [role="tab"][aria-selected="true"]')?.textContent?.trim() ?? "");
    const isActive = async (name: string, msg: string) =>
      waitFor(async () => ((await active()) ?? "").includes(name), msg);

    await open(`${H}/readme.txt`, "readme.txt"); // A
    await open(`${H}/notes.md`, "notes.md"); // B
    await page.locator(`[role="treeitem"][data-path="${H}/projects"]`).click(); // expand
    await waitFor(async () => (await page.locator(`[data-path="${H}/projects/app.js"]`).count()) === 1, "projects expanded");
    await open(`${H}/projects/app.js`, "app.js"); // C
    await open(`${H}/projects/index.html`, "index.html"); // D

    // MRU now D,C,B,A. Click A then C -> C,A,D,B.
    await page.getByRole("tab", { name: "readme.txt" }).click();
    await isActive("readme.txt", "A active");
    await page.getByRole("tab", { name: "app.js" }).click();
    await isActive("app.js", "C active");

    // Quick tap: Ctrl+Tab goes to A (previous in history).
    await page.keyboard.press("Control+Tab");
    await isActive("readme.txt", "Ctrl+Tab -> A");

    // Now MRU is A,C,D,B. Hold Ctrl, Tab twice -> D, popup visible, nothing committed yet.
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await waitFor(async () => (await page.getByTestId("tab-switcher").count()) === 1, "popup appears");
    assert((await page.getByTestId("tab-switcher-item").count()) === 4, "4 items listed");
    const sel = await page.locator('[data-testid="tab-switcher-item"][aria-selected="true"]').textContent();
    assert(sel?.includes("index.html"), `highlight on index.html, got ${sel}`);
    assert((await active()).includes("readme.txt"), "not committed before Ctrl release");
    await page.keyboard.up("Control");
    await isActive("index.html", "release commits D");
    await waitFor(async () => (await page.getByTestId("tab-switcher").count()) === 0, "popup closes");

    // MRU: D,A,C,B. Arrow navigation + Enter.
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab"); // A
    await page.keyboard.press("ArrowDown"); // C
    await page.keyboard.press("ArrowDown"); // B
    await page.keyboard.press("ArrowUp"); // C
    await page.keyboard.press("ArrowDown"); // B
    await page.keyboard.press("Enter");
    await isActive("notes.md", "Enter commits B");
    await page.keyboard.up("Control");
    assert((await active()).includes("notes.md"), "Ctrl release after Enter is a no-op");

    // Esc cancels.
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Escape");
    await page.keyboard.up("Control");
    assert((await active()).includes("notes.md"), "Esc cancels");

    // Ctrl+Tab twice toggles between two files.
    await page.keyboard.press("Control+Tab");
    await isActive("index.html", "toggle 1");
    await page.keyboard.press("Control+Tab");
    await isActive("notes.md", "toggle 2");

    // Mouse click on an item commits it.
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");
    await waitFor(async () => (await page.getByTestId("tab-switcher").count()) === 1, "popup appears again");
    await page.getByTestId("tab-switcher-item").filter({ hasText: "readme.txt" }).click();
    await page.keyboard.up("Control");
    await isActive("readme.txt", "click commits A");
  },
};
