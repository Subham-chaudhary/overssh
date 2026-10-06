import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §13.4.D: a save conflict offers Compare, which opens a Monaco diff
// editor (server left, buffer right). "Save merged" writes the right side guarded by
// the fresh server mtime.
export const scenario: Scenario = {
  name: "Save conflict -> Compare opens diff editor -> Save merged writes with the new server mtime",
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
    await page.keyboard.type("MYEDIT");

    // Someone else changes the file on the server.
    await page.evaluate((p) => window.__harness.touchRemote(p, "SERVERSIDE text\n"), path);
    await page.keyboard.press("Control+S");
    await waitFor(async () => (await page.getByText("File changed on server").count()) > 0, "conflict dialog");
    await page.getByRole("button", { name: "Compare", exact: true }).click();

    const view = page.locator('[data-testid="diff-view"]');
    await waitFor(async () => (await view.count()) === 1, "diff view visible");
    await waitFor(async () => (await view.locator(".monaco-diff-editor").count()) === 1, "monaco diff editor created", 15000);
    await waitFor(async () => (await view.getByText("SERVERSIDE").count()) > 0, "server version shown");
    await waitFor(async () => (await view.getByText("MYEDIT").count()) > 0, "buffer version shown");

    // Toggle inline and back, still the same editor.
    await view.locator('[data-testid="diff-toggle-inline"]').click();
    await view.locator('[data-testid="diff-toggle-inline"]').click();

    // Edit the right side, then Save merged.
    await view.locator(".modified .view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("MERGED");
    await view.locator('[data-testid="diff-save-merged"]').click();

    await waitFor(async () => (await page.evaluate(() => window.__harness.writes())).length > 0, "a write happened");
    const writes = await page.evaluate(() => window.__harness.writes());
    const w = writes[writes.length - 1];
    assert(w.path === path, `wrote ${w.path}`);
    assert(w.content.includes("MYEDIT") && w.content.includes("MERGED"), `merged content written: ${JSON.stringify(w.content)}`);
    assert(w.expectedMtime === 1_700_000_100, `expectedMtime is the fresh server mtime, got ${w.expectedMtime}`);
    await waitFor(async () => (await page.locator('[data-testid="diff-view"]').count()) === 0, "diff view closed after save");
    assert((await page.getByText("MERGED").count()) > 0, "editor shows the merged text");

    // Compare any time via the tab context menu (no conflict), then Cancel.
    const tabEl = page.locator(`[role="tablist"][aria-label="Open files"] [role="tab"][title="${path}"]`);
    await tabEl.hover();
    await tabEl.click({ button: "right" });
    await waitFor(async () => (await page.getByRole("menuitem").count()) > 0, "tab context menu opens");
    await page.getByRole("menuitem", { name: "Compare with Saved on Server" }).click();
    await waitFor(async () => (await page.locator('[data-testid="diff-view"]').count()) === 1, "manual compare opens");
    await page.locator('[data-testid="diff-cancel"]').click();
    await waitFor(async () => (await page.locator('[data-testid="diff-view"]').count()) === 0, "cancel closes diff");
  },
};
