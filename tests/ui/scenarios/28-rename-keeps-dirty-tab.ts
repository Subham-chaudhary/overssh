import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §13.4.F: renaming/moving a file that is open (even with unsaved
// changes) retargets the existing tab (VS Code semantics) instead of leaving a
// detached tab behind. Buffer + dirty state survive, saving writes the NEW path,
// renaming a folder retargets every open tab under it, and no path ever gets
// two tabs (create-then-rename, creating a name that already exists).
export const scenario: Scenario = {
  name: "Rename/move retargets open tabs: dirty buffer kept, saves to new path, no duplicate tabs",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    const tabs = page.locator('[role="tablist"][aria-label="Open files"] [role="tab"]');
    const tabAt = (p: string) => page.locator(`[role="tablist"][aria-label="Open files"] [role="tab"][title="${p}"]`);
    const dialogInput = page.getByRole("dialog").locator("input");

    async function rename(rowPath: string, newName: string): Promise<void> {
      await page.locator(`[data-path="${rowPath}"]`).click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Rename\s*F2/ }).click();
      await waitFor(async () => (await dialogInput.count()) === 1, "rename prompt opens");
      await dialogInput.fill(newName);
      await dialogInput.press("Enter");
    }

    // --- 1. dirty file rename ------------------------------------------------
    const readme = page.locator('[data-path="/home/testuser/readme.txt"]');
    await waitFor(async () => (await readme.count()) === 1, "readme.txt row rendered");
    await readme.click();
    await waitFor(async () => (await page.getByText("Hello from the fake remote filesystem.").count()) > 0, "content loaded", 15000);
    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" EDITED");
    await waitFor(async () => (await tabAt("/home/testuser/readme.txt").locator(".bg-foreground").count()) === 1, "tab dirty");

    await rename("/home/testuser/readme.txt", "guide.md");
    await waitFor(async () => (await tabAt("/home/testuser/guide.md").count()) === 1, "tab retargeted to guide.md");
    assert((await tabs.count()) === 1, `exactly one tab after rename, got ${await tabs.count()}`);
    assert((await tabAt("/home/testuser/readme.txt").count()) === 0, "no tab left on the old path");
    assert((await tabAt("/home/testuser/guide.md").locator(".bg-foreground").count()) === 1, "retargeted tab is still dirty");
    assert((await page.getByText("EDITED").count()) > 0, "unsaved buffer kept in the editor");
    assert((await page.locator('[data-path="/home/testuser/guide.md"]').count()) === 1, "tree shows the new name");
    assert((await page.locator('[data-path="/home/testuser/readme.txt"]').count()) === 0, "tree no longer shows the old name");

    // Save writes the new path only.
    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.press("Control+S");
    await waitFor(
      async () => (await page.evaluate(() => window.__harness.writes())).some((w) => w.path === "/home/testuser/guide.md" && w.content.includes("EDITED")),
      "save wrote the new path with the edit",
    );
    const writes = await page.evaluate(() => window.__harness.writes());
    assert(!writes.some((w) => w.path === "/home/testuser/readme.txt"), "nothing was written to the old path");
    assert(!(await page.evaluate(() => window.__harness.fileExists("/home/testuser/readme.txt"))), "old file not recreated");
    await waitFor(async () => (await tabAt("/home/testuser/guide.md").locator(".bg-foreground").count()) === 0, "tab clean after save");

    // --- 2. directory rename retargets tabs inside ----------------------------
    await page.locator('[data-path="/home/testuser/projects"]').click();
    const appJs = page.locator('[data-path="/home/testuser/projects/app.js"]');
    await waitFor(async () => (await appJs.count()) === 1, "projects expanded");
    await appJs.click();
    await waitFor(async () => (await tabAt("/home/testuser/projects/app.js").count()) === 1, "app.js tab open");
    assert((await tabs.count()) === 2, "two tabs open");

    await rename("/home/testuser/projects", "src");
    await waitFor(async () => (await tabAt("/home/testuser/src/app.js").count()) === 1, "app.js tab retargeted under src");
    assert((await tabs.count()) === 2, "still two tabs after folder rename");
    assert((await tabAt("/home/testuser/projects/app.js").count()) === 0, "no tab on the old folder path");
    await waitFor(async () => (await page.locator('[data-path="/home/testuser/src/app.js"]').count()) === 1, "expanded state followed the rename");

    // --- 3. create then rename (Ctrl+N flow): still one tab -------------------
    await page.locator('[data-path="/home/testuser/notes.md"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "New file" }).click();
    await dialogInput.fill("tmp.txt");
    await dialogInput.press("Enter");
    await waitFor(async () => (await tabAt("/home/testuser/tmp.txt").count()) === 1, "new file opened in a tab");
    await rename("/home/testuser/tmp.txt", "tmp2.txt");
    await waitFor(async () => (await tabAt("/home/testuser/tmp2.txt").count()) === 1, "new file's tab retargeted");
    assert((await tabAt("/home/testuser/tmp.txt").count()) === 0, "no tab for the pre-rename name");
    assert((await tabs.count()) === 3, `three tabs, got ${await tabs.count()}`);

    // --- 4. creating a file whose name already exists -------------------------
    await page.locator('[data-path="/home/testuser/notes.md"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "New file" }).click();
    await dialogInput.fill("tmp2.txt");
    await dialogInput.press("Enter");
    await waitFor(async () => (await page.getByText("already exists").count()) > 0, "error toast for existing name");
    assert((await tabs.count()) === 3, "no extra tab for a name that already exists");
    assert((await page.locator('[data-path="/home/testuser/tmp2.txt"]').count()) === 1, "one tree row for tmp2.txt");
  },
};
