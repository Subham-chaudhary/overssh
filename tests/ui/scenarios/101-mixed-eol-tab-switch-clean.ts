import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Monaco normalizes mixed line endings (CRLF + LF) in its model, so the model text
// differs from tab.doc. Switching away and back used to call model.setValue(tab.doc),
// which marked the untouched file dirty (and autosave would then rewrite it).
export const scenario: Scenario = {
  name: "A file with mixed CRLF/LF line endings stays clean after switching tabs",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    const mixed = "/home/testuser/readme.txt";
    const other = "/home/testuser/notes.md";
    await page.evaluate((p) => window.__harness.touchRemote(p, "one\r\ntwo\nthree\r\n"), mixed);

    await page.locator(`[data-path="${mixed}"]`).click();
    await waitFor(async () => (await page.locator(".monaco-editor .view-lines").getByText("three").count()) > 0, "mixed file loaded", 15000);
    await page.locator(`[data-path="${other}"]`).click();
    await waitFor(async () => (await page.locator(".monaco-editor .view-lines").getByText("# Notes").count()) > 0, "other file loaded", 15000);

    const tab = (p: string) => page.locator(`[role="tablist"][aria-label="Open files"] [role="tab"][title="${p}"]`);
    await tab(mixed).click();
    await waitFor(async () => (await page.locator(".monaco-editor .view-lines").getByText("three").count()) > 0, "back on the mixed file");
    await tab(other).click();
    await tab(mixed).click();
    await page.waitForTimeout(200);

    const dirtyDots = await tab(mixed).locator("span.rounded-full").count();
    assert(dirtyDots === 0, "the untouched mixed-EOL file is not marked dirty");
  },
};
