import type { Scenario } from "../scenario";
import { waitFor } from "../scenario";

export const scenario: Scenario = {
  name: "Ctrl+Tab / Ctrl+Shift+Tab cycle tabs in the active workspace",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.evaluate(() => window.__harness.setReadFileDelay(0));

    // Connecting already switches the sidebar to Explorer (stores.svelte.ts) —
    // do *not* also click the Explorer icon here: it's already the active
    // view, so a click would toggle it back off (§12 item 17).
    await page.getByRole("button", { name: "Connect alpha" }).click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    await waitFor(async () => (await page.locator('[role="treeitem"]').count()) > 0, "explorer tree rendered");

    await page.locator('[role="treeitem"][data-path="/home/testuser/readme.txt"]').click();
    await waitFor(async () => (await page.getByRole("tab", { name: "readme.txt" }).count()) === 1, "readme.txt tab open");
    await page.locator('[role="treeitem"][data-path="/home/testuser/notes.md"]').click();
    await waitFor(async () => (await page.getByRole("tab", { name: "notes.md" }).count()) === 1, "notes.md tab open");

    await waitFor(
      async () => (await page.getByRole("tab", { name: "notes.md" }).getAttribute("aria-selected")) === "true",
      "notes.md (opened last) is active",
    );

    await page.keyboard.press("Control+Tab");
    await waitFor(
      async () => (await page.getByRole("tab", { name: "readme.txt" }).getAttribute("aria-selected")) === "true",
      "Ctrl+Tab wraps around to readme.txt",
    );

    await page.keyboard.press("Control+Shift+Tab");
    await waitFor(
      async () => (await page.getByRole("tab", { name: "notes.md" }).getAttribute("aria-selected")) === "true",
      "Ctrl+Shift+Tab goes back to notes.md",
    );
  },
};
