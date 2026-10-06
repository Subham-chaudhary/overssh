import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Explorer right-click -> New file / New folder must open the name prompt,
// create the entry on confirm, and show it in the tree (regression: the menu
// read its props after closing itself and threw). Ctrl+N / Ctrl+Shift+N do
// the same in the selected directory.
export const scenario: Scenario = {
  name: "Explorer creates files/folders via context menu and Ctrl+N / Ctrl+Shift+N",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    const row = page.locator('[data-path="/home/testuser/projects"]');
    await waitFor(async () => (await row.count()) === 1, "tree rendered");

    for (const [label, name] of [
      ["New file", "notes.txt"],
      ["New folder", "newdir"],
    ] as const) {
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: label }).click();
      const input = page.getByRole("dialog").locator("input");
      await waitFor(async () => (await input.count()) === 1, `${label}: name prompt opens`);
      await input.fill(name);
      await input.press("Enter");
      await waitFor(
        async () => (await page.locator(`[data-path$="/${name}"]`).count()) === 1,
        `${label}: "${name}" appears in the tree`,
      );
      assert((await page.getByRole("dialog").count()) === 0, `${label}: prompt closes after create`);
    }

    // A new file also opens in the editor.
    await waitFor(
      async () => (await page.locator('[role="tab"]', { hasText: "notes.txt" }).count()) > 0,
      "new file opens in an editor tab",
    );

    // Keyboard: select the "projects" folder, Ctrl+Shift+N -> folder created inside it.
    await row.click();
    await page.keyboard.press("Control+Shift+N");
    const input = page.getByRole("dialog").locator("input");
    await waitFor(async () => (await input.count()) === 1, "Ctrl+Shift+N opens the prompt");
    await input.fill("sub");
    await input.press("Enter");
    await waitFor(
      async () => (await page.locator('[data-path="/home/testuser/projects/sub"]').count()) === 1,
      "Ctrl+Shift+N created projects/sub inside the selected folder (and expanded it)",
    );

    // Ctrl+N with "sub" (a folder) selected -> file created inside it.
    await page.keyboard.press("Control+N");
    await waitFor(async () => (await input.count()) === 1, "Ctrl+N opens the prompt");
    await input.fill("x.md");
    await input.press("Enter");
    await waitFor(
      async () => (await page.locator('[data-path="/home/testuser/projects/sub/x.md"]').count()) === 1,
      "Ctrl+N created sub/x.md",
    );
  },
};
