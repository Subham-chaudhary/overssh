import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// §15.4.HF1: the title-bar close button asks before quitting with unsaved files.
export const scenario: Scenario = {
  name: "Window close with unsaved changes asks first (Cancel keeps the window)",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    await page.locator('[data-path="/home/testuser/readme.txt"]').click();
    await waitFor(async () => (await page.getByText("Hello from the fake remote filesystem.").count()) > 0, "content loaded", 15000);
    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("DIRTY");

    const closes = async () =>
      (await page.evaluate(() => window.__harness.windowCalls())).filter((c) => c.cmd === "close").length;

    await page.locator('[data-testid="win-close"]').click();
    const dialog = page.getByRole("alertdialog");
    await waitFor(async () => (await dialog.getByText("Unsaved changes", { exact: true }).count()) === 1, "confirm shown");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(200);
    assert((await closes()) === 0, "Cancel: window not closed");

    await page.locator('[data-testid="win-close"]').click();
    await waitFor(async () => (await dialog.count()) === 1, "confirm shown again");
    await dialog.getByRole("button", { name: "Quit anyway" }).click();
    await waitFor(async () => (await closes()) === 1, "Quit anyway closes the window");
  },
};
