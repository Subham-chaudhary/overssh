import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §12, feature (20): if a paused tab's file no longer exists on
// resume (NotFound), the tab is kept (with saved content, if any) and
// Editor.svelte shows a warning banner instead of failing the tab.
export const scenario: Scenario = {
  name: "Resume keeps a tab whose file was deleted while paused, with a warning banner",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    const notes = page.locator('[data-path="/home/testuser/notes.md"]');
    await waitFor(async () => (await notes.count()) === 1, "notes.md row rendered");
    await notes.click();
    await waitFor(
      async () => (await page.getByText("This is fake file content").count()) > 0,
      "notes.md content loaded",
      15000,
    );

    await page.locator('[data-testid="pause-session"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 0, "disconnected");

    // The server-side file is gone by the time we resume.
    await page.evaluate(() => window.__harness.deleteFile("/home/testuser/notes.md"));

    const pausedRow = page.locator('[data-testid="paused-row"][data-label="alpha"]');
    await waitFor(async () => (await pausedRow.count()) === 1, "paused row shown");
    await pausedRow.locator('[aria-label="Resume alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "reconnected");

    const tabRow = page.locator('[role="tab"][title="/home/testuser/notes.md"]');
    await waitFor(async () => (await tabRow.count()) === 1, "notes.md tab kept open despite being deleted");
    await tabRow.click();
    await waitFor(
      async () => (await page.locator('[data-testid="missing-file-banner"]').count()) === 1,
      "missing-file banner shown",
    );
    assert(
      (await page.locator('[data-testid="missing-file-banner"]').innerText()).includes("no longer exists"),
      "banner text mentions the file no longer existing",
    );
  },
};
