// docs/GUIDE.md §13.4.K: Ctrl+W closes, Ctrl+Shift+T reopens the last closed
// file; inside a terminal the same keys act on terminals.
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

export const scenario: Scenario = {
  name: "Ctrl+W / Ctrl+Shift+T / Ctrl+T for files and terminals",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await page.getByRole("button", { name: "Connect alpha" }).click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    const H = "/home/testuser";
    await waitFor(async () => (await page.locator(`[data-path="${H}/readme.txt"]`).count()) === 1, "tree rendered");

    const tabs = async () => page.locator('[aria-label="Open files"] [role="tab"]').count();
    await page.locator(`[role="treeitem"][data-path="${H}/readme.txt"]`).click();
    await page.locator(`[role="treeitem"][data-path="${H}/notes.md"]`).click();
    await waitFor(async () => (await tabs()) === 2, "2 file tabs");

    await page.keyboard.press("Control+w");
    await waitFor(async () => (await page.getByRole("tab", { name: "notes.md" }).count()) === 0, "Ctrl+W closes notes.md");
    await page.keyboard.press("Control+Shift+T");
    await waitFor(async () => (await page.getByRole("tab", { name: "notes.md" }).count()) === 1, "Ctrl+Shift+T reopens notes.md");
    await waitFor(
      async () => (await page.getByRole("tab", { name: "notes.md" }).getAttribute("aria-selected")) === "true",
      "reopened tab is active",
    );

    // Terminals: Ctrl+` opens + focuses one; Ctrl+T / Ctrl+W / Ctrl+Shift+T act on terminals.
    await page.keyboard.press("Control+`");
    const terms = async () => page.locator('[data-testid="terminal-tab"]').count();
    await waitFor(async () => (await terms()) === 1, "first terminal");
    await waitFor(
      async () => page.evaluate(() => document.activeElement?.closest(".xterm") !== null && document.activeElement !== null),
      "xterm focused",
    );
    await page.keyboard.press("Control+t");
    await waitFor(async () => (await terms()) === 2, "Ctrl+T opens a second terminal");
    assert((await tabs()) === 2, "Ctrl+T in terminal does not touch file tabs");
    await waitFor(async () => page.evaluate(() => document.activeElement?.closest(".xterm") != null), "xterm focused again");
    await page.keyboard.press("Control+w");
    await waitFor(async () => (await terms()) === 1, "Ctrl+W closes a terminal");
    assert((await tabs()) === 2, "Ctrl+W in terminal does not close file tabs");
    await page.keyboard.press("Control+Shift+T");
    await waitFor(async () => (await terms()) === 2, "Ctrl+Shift+T reopens the terminal");
  },
};
