import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §13.4.F: explorer file ops are undoable/redoable (Ctrl+Z,
// Ctrl+Shift+Z / Ctrl+Y while the tree has focus): rename (tab retargets back and
// forth), duplicate/copy (remove / copy again), delete (recreated from a snapshot).
export const scenario: Scenario = {
  name: "Explorer file ops undo/redo: rename, duplicate, delete",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    const H = "/home/testuser";
    const row = (p: string) => page.locator(`[data-path="${p}"]`);
    const tabs = page.locator('[role="tablist"][aria-label="Open files"] [role="tab"]');
    const tabAt = (p: string) => page.locator(`[role="tablist"][aria-label="Open files"] [role="tab"][title="${p}"]`);
    const exists = (p: string) => page.evaluate((x) => window.__harness.fileExists(x), p);
    const menu = async (p: string, item: string) => {
      await row(p).click({ button: "right" });
      await page.getByRole("menuitem", { name: new RegExp(`^${item}(?! path)`) }).click();
    };
    const focusTree = async () => {
      await row(`${H}/projects`).click(); // a folder click keeps focus in the tree
    };
    await waitFor(async () => (await row(`${H}/projects`).count()) === 1, "tree rendered");

    // --- rename ---------------------------------------------------------------
    await row(`${H}/readme.txt`).click();
    await waitFor(async () => (await tabAt(`${H}/readme.txt`).count()) === 1, "readme tab open");
    await menu(`${H}/readme.txt`, "Rename");
    const input = page.getByRole("dialog").locator("input");
    await input.fill("guide.md");
    await input.press("Enter");
    await waitFor(async () => (await tabAt(`${H}/guide.md`).count()) === 1, "renamed");
    await focusTree();
    await page.keyboard.press("Control+Z");
    await waitFor(async () => (await tabAt(`${H}/readme.txt`).count()) === 1, "undo rename retargets the tab back");
    assert((await tabs.count()) === 1, "one tab after undo");
    assert(await exists(`${H}/readme.txt`), "file back under its old name");
    await page.keyboard.press("Control+Shift+Z");
    await waitFor(async () => (await tabAt(`${H}/guide.md`).count()) === 1, "redo rename");
    await page.keyboard.press("Control+Z");
    await waitFor(async () => (await exists(`${H}/readme.txt`)), "undo again");

    // --- duplicate ----------------------------------------------------------------
    await menu(`${H}/notes.md`, "Duplicate");
    await waitFor(async () => await exists(`${H}/notes copy.md`), "duplicated");
    await focusTree();
    await page.keyboard.press("Control+Z");
    await waitFor(async () => !(await exists(`${H}/notes copy.md`)), "undo duplicate removes the copy");
    await waitFor(async () => (await row(`${H}/notes copy.md`).count()) === 0, "tree row gone");
    await page.keyboard.press("Control+Y");
    await waitFor(async () => await exists(`${H}/notes copy.md`), "redo duplicate copies again");

    // --- delete -------------------------------------------------------------------
    const before = await page.evaluate((p) => window.__harness.fileContent(p), `${H}/notes.md`);
    await menu(`${H}/notes.md`, "Delete");
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await waitFor(async () => !(await exists(`${H}/notes.md`)), "deleted");
    await focusTree();
    await page.keyboard.press("Control+Z");
    await waitFor(async () => await exists(`${H}/notes.md`), "undo delete restores the file");
    assert((await page.evaluate((p) => window.__harness.fileContent(p), `${H}/notes.md`)) === before, "restored content is identical");
    await waitFor(async () => (await row(`${H}/notes.md`).count()) === 1, "restored file shown in the tree");
    await page.keyboard.press("Control+Shift+Z");
    await waitFor(async () => !(await exists(`${H}/notes.md`)), "redo delete removes it again");
  },
};
