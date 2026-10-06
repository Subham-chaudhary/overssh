import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §13.4.F: explorer Copy / Cut / Paste / Duplicate (menu + Ctrl+C/X/V),
// VS Code "copy" naming, cut+paste = move that retargets tabs, delete closing clean
// tabs / marking dirty ones deleted (save recreates), and pointer drag-move / Ctrl-drag copy.
export const scenario: Scenario = {
  name: "Explorer copy/cut/paste/duplicate/delete/drag keep tabs in sync",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    const H = "/home/testuser";
    const row = (p: string) => page.locator(`[data-path="${p}"]`);
    const tabs = page.locator('[role="tablist"][aria-label="Open files"] [role="tab"]');
    const tabAt = (p: string) => page.locator(`[role="tablist"][aria-label="Open files"] [role="tab"][title^="${p}"]`);
    const exists = (p: string) => page.evaluate((x) => window.__harness.fileExists(x), p);
    const menu = async (p: string, item: string) => {
      await row(p).click({ button: "right" });
      await page.getByRole("menuitem", { name: new RegExp(`^${item}(?! path)`) }).click();
    };
    await waitFor(async () => (await row(`${H}/projects`).count()) === 1, "tree rendered");

    // --- copy via menu; paste via menu into a folder --------------------------
    await menu(`${H}/readme.txt`, "Copy");
    await menu(`${H}/projects`, "Paste");
    await waitFor(async () => (await row(`${H}/projects/readme.txt`).count()) === 1, "pasted without suffix (no clash)");
    assert(await exists(`${H}/projects/readme.txt`), "copy exists on the server");
    assert(await exists(`${H}/readme.txt`), "source still exists after copy");

    // --- Ctrl+V twice -> "copy", "copy 2" ---------------------------------------
    await row(`${H}/projects`).click(); // select the folder (focus stays in the tree)
    await page.keyboard.press("Control+V");
    await waitFor(async () => (await row(`${H}/projects/readme copy.txt`).count()) === 1, "Ctrl+V -> 'readme copy.txt'");
    await page.keyboard.press("Control+V");
    await waitFor(async () => (await row(`${H}/projects/readme copy 2.txt`).count()) === 1, "Ctrl+V -> 'readme copy 2.txt'");

    // --- Duplicate -------------------------------------------------------------
    await menu(`${H}/notes.md`, "Duplicate");
    await waitFor(async () => (await row(`${H}/notes copy.md`).count()) === 1, "Duplicate -> 'notes copy.md'");

    // --- cut + paste = move; open tab is retargeted ------------------------------
    const index = `${H}/projects/index.html`;
    await row(index).click();
    await waitFor(async () => (await tabAt(index).count()) === 1, "index.html tab open");
    await menu(index, "Cut");
    await waitFor(async () => (await row(index).evaluate((el) => el.classList.contains("opacity-50"))), "cut row is dimmed");
    await menu(`${H}/notes.md`, "Paste");
    await waitFor(async () => (await row(`${H}/index.html`).count()) === 1, "moved to the home dir");
    assert(!(await exists(index)), "source gone after cut+paste");
    assert((await tabAt(`${H}/index.html`).count()) === 1, "tab retargeted to the new location");
    assert((await tabAt(index).count()) === 0, "no tab left on the old path");
    assert((await tabs.count()) === 1, "still exactly one tab");
    assert(!(await row(`${H}/index.html`).evaluate((el) => el.classList.contains("opacity-50"))), "dimming cleared after paste");

    // --- delete: clean tab closes -------------------------------------------------
    const confirmDelete = async () => {
      const dlg = page.getByRole("alertdialog");
      await waitFor(async () => (await dlg.count()) === 1, "delete confirm opens");
      await dlg.getByRole("button", { name: "Delete" }).click();
    };
    await menu(`${H}/index.html`, "Delete");
    await confirmDelete();
    await waitFor(async () => (await tabs.count()) === 0, "clean tab closed on delete");
    assert(!(await exists(`${H}/index.html`)), "deleted on the server");

    // --- delete: dirty tab stays, marked deleted, save recreates ------------------
    const readme = `${H}/readme.txt`;
    await row(readme).click();
    await waitFor(async () => (await page.getByText("Hello from the fake remote filesystem.").count()) > 0, "readme loaded");
    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" KEEPME");
    await menu(readme, "Delete");
    await waitFor(async () => (await page.getByRole("alertdialog").getByText("unsaved changes").count()) > 0, "confirm mentions unsaved changes");
    await confirmDelete();
    await waitFor(async () => (await tabAt(readme).locator('[data-deleted="true"]').count()) === 1, "dirty tab marked deleted");
    assert((await tabAt(readme).textContent())?.includes("(deleted)") === true, "tab title says (deleted)");
    assert(!(await exists(readme)), "file really deleted");
    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.press("Control+S");
    await waitFor(async () => await exists(readme), "save recreated the file");
    assert((await page.evaluate((p) => window.__harness.fileContent(p), readme))?.includes("KEEPME") === true, "recreated with the unsaved content");
    await waitFor(async () => (await tabAt(readme).locator('[data-deleted="true"]').count()) === 0, "deleted mark cleared after save");
    await waitFor(async () => (await row(readme).count()) === 1, "file back in the tree");

    // --- pointer drag: move, Ctrl-drag copy, never into itself ---------------------
    async function drag(from: string, to: string, ctrl = false): Promise<void> {
      const a = await row(from).boundingBox();
      const b = await row(to).boundingBox();
      assert(a && b, "rows have boxes");
      await page.mouse.move(a.x + 40, a.y + a.height / 2);
      await page.mouse.down();
      await page.mouse.move(a.x + 60, a.y + a.height / 2 + 12, { steps: 3 });
      if (ctrl) await page.keyboard.down("Control");
      await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 6 });
      await page.mouse.up();
      if (ctrl) await page.keyboard.up("Control");
    }
    const copyMd = `${H}/notes copy.md`;
    await drag(copyMd, `${H}/projects`);
    await waitFor(async () => (await row(`${H}/projects/notes copy.md`).count()) === 1, "drag moved the file into projects");
    assert(!(await exists(copyMd)), "drag-move removed the source");

    await drag(`${H}/notes.md`, `${H}/projects`, true);
    await waitFor(async () => (await row(`${H}/projects/notes.md`).count()) === 1, "Ctrl-drag copied the file");
    assert(await exists(`${H}/notes.md`), "Ctrl-drag kept the source");

    await drag(`${H}/projects`, `${H}/projects/readme.txt`);
    assert(await exists(`${H}/projects/readme.txt`), "dropping a folder onto its own child is ignored");
    assert((await page.locator('[data-testid="drag-ghost"]').count()) === 0, "drag ghost cleaned up");
  },
};
