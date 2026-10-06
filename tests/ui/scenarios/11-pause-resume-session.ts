import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §12, feature (20): Pause snapshots the workspace (open tabs,
// unsaved content, explorer cwd) and disconnects without a dirty-confirm;
// Resume reconnects and puts it all back, re-applying unsaved content as
// dirty.
export const scenario: Scenario = {
  name: "Pause session snapshots dirty content, Resume restores it",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    const readme = page.locator('[data-path="/home/testuser/readme.txt"]');
    await waitFor(async () => (await readme.count()) === 1, "readme.txt row rendered");
    await readme.click();
    await waitFor(
      async () => (await page.getByText("Hello from the fake remote filesystem.").count()) > 0,
      "readme.txt content loaded",
      15000,
    );

    // Dirty it: click into Monaco's content area and type.
    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" EDITED");

    const tabRow = page.locator('[role="tab"][title="/home/testuser/readme.txt"]');
    await waitFor(async () => (await tabRow.locator(".bg-foreground").count()) === 1, "tab shows dirty dot");

    // Pause: disconnects without a dirty-confirm prompt (no dialog should
    // appear and block this), and the session disappears.
    await page.locator('[data-testid="pause-session"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 0, "disconnected");

    const pausedRow = page.locator('[data-testid="paused-row"][data-label="alpha"]');
    await waitFor(async () => (await pausedRow.count()) === 1, 'Hosts panel shows a "Paused" row for alpha');

    await waitFor(async () => {
      const stored = (await page.evaluate(() => window.__harness.getStore("paused"))) as
        | Array<{ label: string; tabs: Array<{ path: string; dirty: boolean; doc: string | null }> }>
        | null;
      const entry = stored?.find((p) => p.label === "alpha");
      const tab = entry?.tabs.find((t) => t.path === "/home/testuser/readme.txt");
      return !!tab?.dirty && !!tab.doc?.includes("EDITED");
    }, "persisted paused snapshot contains the dirty readme.txt content", 3000);

    // Resume: reconnects and reopens the tab with the unsaved edit restored.
    await pausedRow.locator('[aria-label="Resume alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "reconnected");
    await waitFor(async () => (await tabRow.count()) === 1, "readme.txt tab reopened");
    await waitFor(
      async () => (await page.getByText("Hello from the fake remote filesystem. EDITED").count()) > 0,
      "unsaved edit restored in the editor",
      15000,
    );
    assert((await tabRow.locator(".bg-foreground").count()) === 1, "reopened tab is dirty again");
  },
};
