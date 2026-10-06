import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §13.4.A: a network drop keeps the workspace (dirty tab included),
// shows a "reconnecting" banner with backoff, and after the mock connect succeeds
// the workspace is rebound to the NEW backend session id: the tab is still dirty,
// the explorer works, and saving (which needs the new id) succeeds.
export const scenario: Scenario = {
  name: "Auto-reconnect: drop keeps dirty tab, banner shows, new session id is bound everywhere",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    const oldId = await page.evaluate(() => window.__harness.sessions()[0].id);

    const readme = page.locator('[data-path="/home/testuser/readme.txt"]');
    await waitFor(async () => (await readme.count()) === 1, "readme.txt row rendered");
    await readme.click();
    await waitFor(async () => (await page.getByText("Hello from the fake remote filesystem.").count()) > 0, "content loaded", 15000);
    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" EDITED");
    const tabRow = page.locator('[role="tab"][title="/home/testuser/readme.txt"]');
    await waitFor(async () => (await tabRow.locator(".bg-foreground").count()) === 1, "tab dirty");

    // Drop the link; the first reconnect attempt fails, the second succeeds.
    await page.evaluate(() => {
      window.__harness.failNextConnect({ kind: "Connection", message: "network unreachable" });
      return window.__harness.dropSession(window.__harness.sessions()[0].id);
    });
    const banner = page.locator('[data-testid="reconnect-banner"]');
    await waitFor(async () => (await banner.count()) === 1, "reconnecting banner appears");
    assert((await page.locator('[data-testid="status-reconnecting"]').count()) === 1, "status bar shows reconnecting");
    assert((await tabRow.count()) === 1, "tab kept while disconnected");

    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "reconnected", 15000);
    await waitFor(async () => (await banner.count()) === 0, "banner disappears after reconnect");
    const newId = await page.evaluate(() => window.__harness.sessions()[0].id);
    assert(newId !== oldId, "backend session id changed");
    assert((await page.evaluate(() => window.__harness.connectRequests().length)) === 3, "initial connect + failed attempt + successful attempt");

    // Same tab, still dirty, edit kept.
    assert((await tabRow.count()) === 1, "same tab still open");
    assert((await tabRow.locator(".bg-foreground").count()) === 1, "tab still dirty after reconnect");
    assert((await page.getByText("EDITED").count()) > 0, "unsaved buffer kept in the editor");
    // Explorer works on the new session (mock rejects file commands on the dead id).
    await waitFor(async () => (await page.locator('[data-path="/home/testuser/projects"]').count()) === 1, "explorer listing present");
    await page.locator('[data-path="/home/testuser/projects"]').click();
    await waitFor(async () => (await page.locator('[data-path="/home/testuser/projects/app.js"]').count()) === 1, "folder expands on the new session");
    // Saving uses the remapped session id (the mock throws for the old one).
    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.press("Control+S");
    await waitFor(async () => (await tabRow.locator(".bg-foreground").count()) === 0, "save succeeds on the new session", 5000);
    const writes = await page.evaluate(() => window.__harness.writes());
    assert(writes.some((w) => w.path === "/home/testuser/readme.txt" && w.content.includes("EDITED")), "write reached the fake backend");
  },
};
