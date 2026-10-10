import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// §15.4.HF1: while a prompt is open, app shortcuts must not act on the workbench
// behind it (Ctrl+W used to close the editor tab under a "New file" prompt), and
// invalid names ("..", control chars) are rejected inline instead of creating
// something outside the target folder.
export const scenario: Scenario = {
  name: "Prompt blocks Ctrl+W behind it; New file rejects '..' inline",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    const path = "/home/testuser/readme.txt";
    await page.locator(`[data-path="${path}"]`).click();
    const tab = page.locator(`[role="tablist"][aria-label="Open files"] [role="tab"][title="${path}"]`);
    await waitFor(async () => (await tab.count()) === 1, "tab open");

    await page.locator('[data-path="/home/testuser/projects"]').click();
    await page.keyboard.press("Control+N");
    const input = page.getByRole("dialog").locator("input");
    await waitFor(async () => (await input.count()) === 1, "New file prompt opens");

    await page.keyboard.press("Control+W");
    await page.waitForTimeout(200);
    assert((await tab.count()) === 1, "Ctrl+W inside the prompt did not close the editor tab");
    assert((await input.count()) === 1, "prompt still open");

    await input.fill("..");
    await waitFor(async () => (await page.locator('[data-testid="input-dialog-error"]').count()) === 1, "inline error for '..'");
    await input.press("Enter");
    await page.waitForTimeout(200);
    assert((await input.count()) === 1, "Enter with an invalid name keeps the prompt open");

    await input.fill("ok.txt");
    await waitFor(async () => (await page.locator('[data-testid="input-dialog-error"]').count()) === 0, "error clears");
    await input.press("Enter");
    await waitFor(
      async () => (await page.locator('[data-path="/home/testuser/projects/ok.txt"]').count()) === 1,
      "valid name creates the file",
    );
  },
};
