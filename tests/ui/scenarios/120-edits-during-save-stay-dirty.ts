import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// saveTab used to set savedDoc = tab.doc after the write returned, so text typed while a
// slow write was in flight was marked saved without ever being written (and the tab then
// closed without asking).
export const scenario: Scenario = {
  name: "Edits typed while a save is in flight stay unsaved and are written next",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    const path = "/home/testuser/readme.txt";
    await page.locator(`[data-path="${path}"]`).click();
    await waitFor(async () => (await page.getByText("Hello from the fake remote filesystem.").count()) > 0, "content loaded", 15000);
    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("AAA");

    await page.evaluate(() => window.__harness.setWriteFileDelay(800));
    await page.keyboard.press("Control+S");
    await page.waitForTimeout(150); // the write is in flight
    await page.keyboard.type("BBB");
    const writes = () => page.evaluate(() => window.__harness.writes());
    await waitFor(async () => (await writes()).length === 1, "first save done", 5000);
    await page.waitForTimeout(200);

    const first = (await writes())[0].content;
    assert(first.includes("AAA") && !first.includes("BBB"), "the first write holds the text at Ctrl+S");
    const dot = page.locator('[data-testid="title-bar"] [title="Unsaved changes"]');
    assert((await dot.count()) === 1, "text typed during the save is still unsaved");

    await page.evaluate(() => window.__harness.setWriteFileDelay(0));
    await page.keyboard.press("Control+S");
    await waitFor(async () => (await writes()).length === 2, "second save");
    assert((await writes())[1].content.includes("AAABBB"), "the second write holds the later edits");
    await waitFor(async () => (await dot.count()) === 0, "clean after the second save");
  },
};
