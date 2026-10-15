import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Monaco's `addCommand` registers a global keybinding that is never removed, and the
// last one wins. The diff view's Ctrl+S (Save merged) used to stay bound after the
// diff closed, so Ctrl+S in the normal editor called a disposed diff model and saved nothing.
export const scenario: Scenario = {
  name: "Ctrl+S in the editor still saves after a Compare view was opened and closed",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    const path = "/home/testuser/readme.txt";
    await page.locator(`[data-path="${path}"]`).click();
    await waitFor(async () => (await page.getByText("Hello from the fake remote filesystem.").count()) > 0, "content loaded", 15000);

    // Open Compare from the tab menu, wait for the diff editor, then cancel.
    const tabEl = page.locator(`[role="tablist"][aria-label="Open files"] [role="tab"][title="${path}"]`);
    await tabEl.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Compare with Saved on Server" }).click();
    const view = page.locator('[data-testid="diff-view"]');
    await waitFor(async () => (await view.locator(".monaco-diff-editor").count()) === 1, "diff editor created", 15000);
    await page.locator('[data-testid="diff-cancel"]').click();
    await waitFor(async () => (await view.count()) === 0, "diff closed");

    // Edit in the normal editor and press Ctrl+S.
    const before = (await page.evaluate(() => window.__harness.writes())).length;
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("AFTERDIFF");
    await page.keyboard.press("Control+S");
    await waitFor(
      async () => (await page.evaluate(() => window.__harness.writes())).length > before,
      "Ctrl+S wrote the file",
      5000,
    );
    const writes = await page.evaluate(() => window.__harness.writes());
    const w = writes[writes.length - 1];
    assert(w.path === path && w.content.includes("AFTERDIFF"), `wrote the edited buffer: ${JSON.stringify(w)}`);

    // Inside a diff view, Ctrl+S is still "Save merged".
    await tabEl.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Compare with Saved on Server" }).click();
    await waitFor(async () => (await view.locator(".monaco-diff-editor").count()) === 1, "diff editor again", 15000);
    await view.locator(".modified .view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("INDIFF");
    const n = (await page.evaluate(() => window.__harness.writes())).length;
    await page.keyboard.press("Control+S");
    await waitFor(async () => (await page.evaluate(() => window.__harness.writes())).length > n, "Ctrl+S in the diff saved");
    const last = (await page.evaluate(() => window.__harness.writes())).pop()!;
    assert(last.content.includes("INDIFF"), `diff Ctrl+S wrote the merged side: ${JSON.stringify(last)}`);
    await waitFor(async () => (await view.count()) === 0, "diff closed after Save merged");
  },
};
