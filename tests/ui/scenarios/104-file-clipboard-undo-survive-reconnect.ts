import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// An auto-reconnect gives the workspace a new backend session id. The explorer file
// clipboard and the file-op undo stack used to keep the old id: Paste failed with
// "The source session is no longer connected" and Ctrl+Z did nothing.
export const scenario: Scenario = {
  name: "Explorer clipboard and file undo keep working after an auto-reconnect",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    const H = "/home/testuser";
    const row = (p: string) => page.locator(`[data-path="${p}"]`);
    const exists = (p: string) => page.evaluate((x) => window.__harness.fileExists(x), p);
    const menu = async (p: string, item: string) => {
      await row(p).click({ button: "right" });
      await page.getByRole("menuitem", { name: new RegExp(`^${item}(?! path)`) }).click();
    };
    await waitFor(async () => (await row(`${H}/projects`).count()) === 1, "tree rendered");

    // A file op before the drop (undoable), and a file on the clipboard.
    await menu(`${H}/notes.md`, "Duplicate");
    await waitFor(async () => (await row(`${H}/notes copy.md`).count()) === 1, "duplicated");
    await menu(`${H}/readme.txt`, "Copy");

    const oldId = await page.evaluate(() => window.__harness.sessions()[0].id);
    await page.evaluate(() => window.__harness.dropSession(window.__harness.sessions()[0].id));
    await waitFor(async () => {
      const s = await page.evaluate(() => window.__harness.sessions());
      return s.length === 1 && s[0].id !== oldId;
    }, "reconnected with a new id", 15000);
    await waitFor(async () => (await page.locator('[data-testid="reconnect-banner"]').count()) === 0, "banner gone");
    await waitFor(async () => (await row(`${H}/projects`).count()) === 1, "tree back");

    await menu(`${H}/projects`, "Paste");
    await waitFor(async () => exists(`${H}/projects/readme.txt`), "paste after reconnect copied the file");

    // Undo the paste, then the duplicate made before the drop.
    await row(`${H}/projects`).click();
    await page.keyboard.press("Control+Z");
    await waitFor(async () => !(await exists(`${H}/projects/readme.txt`)), "undo of the paste");
    await page.keyboard.press("Control+Z");
    await waitFor(async () => !(await exists(`${H}/notes copy.md`)), "undo of the pre-drop duplicate");
    assert(await exists(`${H}/notes.md`), "original kept");
  },
};
