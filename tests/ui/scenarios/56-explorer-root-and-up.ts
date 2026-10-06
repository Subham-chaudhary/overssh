import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §14.4.X: "Set as Explorer Root" (like `cd`) on a folder row, and
// the ways back up: the header "Go to parent folder" / "Go to home folder"
// buttons, Alt+Up on the tree, and the context menu's "Go Up".
export const scenario: Scenario = {
  name: "Explorer: Set as Explorer Root, parent button, home button, Alt+Up, Go Up",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    const pathInput = page.locator('input[aria-label="Path"]');
    const projects = page.locator('[data-path="/home/testuser/projects"]');
    await waitFor(async () => (await projects.count()) === 1, "projects row rendered");
    assert((await pathInput.inputValue()) === "/home/testuser", "starts in the home folder");

    // 1. Set as Explorer Root on a folder row.
    await projects.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Set as Explorer Root" }).click();
    await waitFor(async () => (await pathInput.inputValue()) === "/home/testuser/projects", "explorer root is projects");
    await waitFor(
      async () => (await page.locator('[data-path="/home/testuser/projects/app.js"][data-parent="/home/testuser/projects"]').count()) === 1,
      "app.js is now a top-level row",
    );

    // The menu offers no "Set as Explorer Root" on a plain file row.
    await page.locator('[data-path="/home/testuser/projects/app.js"]').click({ button: "right" });
    await waitFor(async () => (await page.getByRole("menuitem", { name: /^Copy path/ }).count()) === 1, "file menu open");
    assert((await page.getByRole("menuitem", { name: "Set as Explorer Root" }).count()) === 0, "no set-root item on a file");
    await page.keyboard.press("Escape");

    // 2. Header parent button.
    await page.locator('[data-testid="explorer-go-up"]').click();
    await waitFor(async () => (await pathInput.inputValue()) === "/home/testuser", "parent button goes to /home/testuser");

    // 3. Up again, then the home button.
    await page.locator('[data-testid="explorer-go-up"]').click();
    await waitFor(async () => (await pathInput.inputValue()) === "/home", "up to /home");
    await page.locator('[data-testid="explorer-go-home"]').click();
    await waitFor(async () => (await pathInput.inputValue()) === "/home/testuser", "home button returns home");

    // 4. Alt+Up on the focused tree.
    await page.locator('[role="tree"]').focus();
    await page.keyboard.press("Alt+ArrowUp");
    await waitFor(async () => (await pathInput.inputValue()) === "/home", "Alt+Up goes to /home");

    // 5. Context menu "Go Up" (background menu), then up to the filesystem root.
    await page.locator('[data-testid="explorer-go-home"]').click();
    await waitFor(async () => (await pathInput.inputValue()) === "/home/testuser", "home again");
    await page.locator('[role="tree"]').click({ button: "right", position: { x: 5, y: 380 } });
    await page.getByRole("menuitem", { name: /^Go Up/ }).click();
    await waitFor(async () => (await pathInput.inputValue()) === "/home", "context menu Go Up");
    await page.locator('[data-testid="explorer-go-up"]').click();
    await waitFor(async () => (await pathInput.inputValue()) === "/", "up to root");
    assert(await page.locator('[data-testid="explorer-go-up"]').isDisabled(), "parent button disabled at /");
  },
};
