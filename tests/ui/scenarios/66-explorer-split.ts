import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §15.3.S: the Explorer can be split into two stacked panes with their own root,
// path bar, selection and focus. Covers: split button, independent roots, active-pane
// highlight, copy/paste between panes (shared clipboard), drag-move / Ctrl-drag copy across
// panes, Alt+Up acting on the focused pane, "Open in Other Pane", palette commands, and
// "Close Split keeps the focused pane".
export const scenario: Scenario = {
  name: "Explorer split: two roots, copy/drag between panes, commands, close split",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    const H = "/home/testuser";
    const panes = page.locator('[data-testid="explorer-pane"]');
    const pane = (i: number) => page.locator(`[data-explorer-pane="${i}"]`);
    const row = (i: number, p: string) => pane(i).locator(`[role="treeitem"][data-path="${p}"]`);
    const pathOf = (i: number) => pane(i).locator('input[aria-label="Path"]').inputValue();
    const exists = (p: string) => page.evaluate((x) => window.__harness.fileExists(x), p);
    const isActive = async (i: number) => (await pane(i).getAttribute("data-active")) === "true";
    await waitFor(async () => (await row(0, `${H}/projects`).count()) === 1, "tree rendered");
    assert((await panes.count()) === 1, "one pane to begin with");

    // --- split: a second pane, focused, same root --------------------------------
    await pane(0).getByTestId("explorer-split").click();
    await waitFor(async () => (await panes.count()) === 2, "two panes after Split");
    await waitFor(async () => (await row(1, `${H}/projects`).count()) === 1, "second pane lists the same root");
    assert(await isActive(1), "the new pane is the focused one");
    assert((await pathOf(0)) === H && (await pathOf(1)) === H, "both panes start at home");
    assert((await page.getByTestId("explorer-split-divider").count()) === 1, "divider between panes");

    // --- independent roots ---------------------------------------------------------
    await row(1, `${H}/projects`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Set as Explorer Root" }).click();
    await waitFor(async () => (await pathOf(1)) === `${H}/projects`, "pane 1 rooted at projects");
    assert((await pathOf(0)) === H, "pane 0 root unchanged");
    await waitFor(async () => (await row(1, `${H}/projects/app.js`).count()) === 1, "pane 1 shows projects content");
    assert((await row(0, `${H}/projects/app.js`).count()) === 0, "pane 0 does not show it");

    // --- focus follows the pointer -----------------------------------------------------
    await row(0, `${H}/readme.txt`).click();
    await waitFor(async () => await isActive(0), "clicking pane 0 focuses it");
    assert(!(await isActive(1)), "pane 1 no longer focused");

    // --- copy in pane 0, paste in pane 1 (shared clipboard) -----------------------------
    await page.keyboard.press("Control+C");
    await row(1, `${H}/projects/app.js`).click();
    await waitFor(async () => await isActive(1), "pane 1 focused");
    await page.keyboard.press("Control+V");
    await waitFor(async () => (await row(1, `${H}/projects/readme.txt`).count()) === 1, "pasted into pane 1's folder");
    assert(await exists(`${H}/projects/readme.txt`), "copy exists on the server");
    assert(await exists(`${H}/readme.txt`), "source kept");

    // --- drag across panes ---------------------------------------------------------------
    async function drag(fromPane: number, from: string, toRow: string, ctrl = false): Promise<void> {
      const a = await row(fromPane, from).boundingBox();
      const b = await row(fromPane === 0 ? 1 : 0, toRow).boundingBox();
      assert(a && b, "rows have boxes");
      await page.mouse.move(a.x + 40, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(a.x + 60, a.y + a.height / 2 + 12, { steps: 3 });
      if (ctrl) await page.keyboard.down("Control");
      await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 8 });
      assert(
        (await page.locator('[data-testid="drag-ghost"]').count()) === 1,
        "drag ghost shown while dragging between panes",
      );
      await page.mouse.up();
      if (ctrl) await page.keyboard.up("Control");
    }
    // Move: pane 0's notes.md onto a file row in pane 1 (= into that row's folder).
    await drag(0, `${H}/notes.md`, `${H}/projects/index.html`);
    await waitFor(async () => (await row(1, `${H}/projects/notes.md`).count()) === 1, "drag-move landed in pane 1's folder");
    assert(!(await exists(`${H}/notes.md`)) && (await exists(`${H}/projects/notes.md`)), "moved on the server");
    await waitFor(async () => (await row(0, `${H}/notes.md`).count()) === 0, "pane 0 dropped the moved row");
    // Ctrl-drag: copy (the name clashes with the pasted one -> "copy" suffix).
    await drag(0, `${H}/readme.txt`, `${H}/projects/index.html`, true);
    await waitFor(async () => (await row(1, `${H}/projects/readme copy.txt`).count()) === 1, "Ctrl-drag copied across panes");
    assert(await exists(`${H}/readme.txt`), "Ctrl-drag kept the source");
    assert((await page.locator('[data-testid="drag-ghost"]').count()) === 0, "drag ghost cleaned up");

    // --- shortcuts act on the focused pane --------------------------------------------------
    await row(0, `${H}/readme.txt`).click();
    await waitFor(async () => await isActive(0), "pane 0 focused again");
    await page.keyboard.press("Alt+ArrowUp");
    await waitFor(async () => (await pathOf(0)) === "/home", "Alt+Up moved pane 0 only");
    assert((await pathOf(1)) === `${H}/projects`, "pane 1 untouched by Alt+Up");
    await pane(0).getByTestId("explorer-go-home").click();
    await waitFor(async () => (await pathOf(0)) === H, "pane 0 back home");

    // --- Open in Other Pane ---------------------------------------------------------------------
    await pane(1).getByTestId("explorer-go-up").click();
    await waitFor(async () => (await pathOf(1)) === H, "pane 1 went up");
    await row(0, `${H}/projects`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open in Other Pane" }).click();
    await waitFor(async () => (await pathOf(1)) === `${H}/projects`, "other pane opened projects");
    assert(await isActive(1), "the other pane takes focus");
    assert((await pathOf(0)) === H, "source pane unchanged");

    // --- palette: Close Split keeps the focused pane -----------------------------------------------
    const runCommand = async (title: string) => {
      await page.keyboard.press("Control+Shift+P");
      await waitFor(async () => (await page.locator('[data-slot="command-input"]').count()) > 0, "palette open");
      await page.locator('[data-slot="command-input"]').fill(title);
      await page.waitForTimeout(150);
      await page.locator('[data-slot="command-item"]', { hasText: title }).first().click();
      await waitFor(async () => (await page.locator('[data-slot="command-input"]').count()) === 0, "palette closed");
    };
    await runCommand("Explorer: Close Split");
    await waitFor(async () => (await panes.count()) === 1, "one pane after Close Split");
    assert((await pathOf(0)) === `${H}/projects`, "the focused pane (projects) was kept");

    // --- palette: Split again, then the pane button closes keeping *that* pane ---------------------
    await runCommand("Explorer: Split");
    await waitFor(async () => (await panes.count()) === 2, "two panes after Explorer: Split");
    await pane(0).getByTestId("explorer-go-home").click();
    await waitFor(async () => (await pathOf(0)) === H, "pane 0 at home");
    assert((await pathOf(1)) === `${H}/projects`, "pane 1 still at projects");
    await pane(0).getByTestId("explorer-split").click();
    await waitFor(async () => (await panes.count()) === 1, "closed via the pane button");
    assert((await pathOf(0)) === H, "kept the pane whose button was used");
  },
};
