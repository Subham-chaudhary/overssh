import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §14.4.X: the Info (Properties) dialog for a file, a folder
// (on-demand "Calculate size") and a multi-selection, plus the VS Code-like
// file type icons in the tree and the editor tabs.
export const scenario: Scenario = {
  name: "Info dialog (file, folder size, multi-select) and Material file icons",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    const row = (p: string) => page.locator(`[data-path="${p}"]`);
    await waitFor(async () => (await row("/home/testuser/notes.md").count()) === 1, "tree rendered");

    // --- icons: manifest maps names/extensions/folders to Material icons ----------
    const iconOf = (p: string) => row(p).locator("img[data-icon]");
    await waitFor(async () => (await iconOf("/home/testuser/notes.md").count()) === 1, "icons loaded");
    assert((await iconOf("/home/testuser/notes.md").getAttribute("data-icon")) === "markdown", "notes.md uses the markdown icon");
    assert((await iconOf("/home/testuser/projects").getAttribute("data-icon")) === "folder-project", "projects folder icon");
    assert((await iconOf("/home/testuser/readme.txt").getAttribute("data-icon")) === "readme", "readme.txt matches by file name");
    // The SVG really loads from the app origin (no CDN).
    await waitFor(
      async () =>
        iconOf("/home/testuser/notes.md").evaluate(
          (img: HTMLImageElement) => img.complete && img.naturalWidth > 0 && new URL(img.src).origin === location.origin,
        ),
      "icon SVG loaded from the local origin",
    );
    await row("/home/testuser/projects").click();
    await waitFor(async () => (await row("/home/testuser/projects/app.js").count()) === 1, "projects expanded");
    await waitFor(
      async () => (await iconOf("/home/testuser/projects").getAttribute("data-icon")) === "folder-project-open",
      "open folder icon",
    );
    assert((await iconOf("/home/testuser/projects/app.js").getAttribute("data-icon")) === "javascript", "app.js uses the javascript icon");
    await row("/home/testuser/projects/app.js").click();
    const tab = page.locator('[role="tab"][title="/home/testuser/projects/app.js"]');
    await waitFor(async () => (await tab.locator('img[data-icon="javascript"]').count()) === 1, "tab shows the javascript icon");

    // --- single file Info ---------------------------------------------------------
    const dialog = page.locator('[data-testid="file-info-dialog"]');
    const text = (id: string) => dialog.locator(`[data-testid="${id}"]`).innerText();
    await row("/home/testuser/notes.md").click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Info/ }).click();
    await waitFor(async () => (await dialog.count()) === 1, "info dialog opens");
    await waitFor(async () => (await dialog.locator('[data-testid="info-path"]').count()) === 1, "file info loaded");
    assert((await text("info-title")) === "notes.md", "title is the file name");
    assert((await text("info-path")) === "/home/testuser/notes.md", "full path shown");
    assert((await text("info-type")) === "File", "type");
    assert((await text("info-size")).includes("128 B"), `size shown, got ${await text("info-size")}`);
    const perms = await text("info-permissions");
    assert(perms.includes("-rw-r--r--") && perms.includes("0644"), `rwx + octal, got ${perms}`);
    assert((await text("info-owner")).includes("testuser") && (await text("info-group")).includes("staff"), "owner and group names");
    assert((await text("info-mime")) === "text/plain", "mime");
    assert((await text("info-language")) === "Markdown", "language");
    assert((await text("info-lines")) === "3", `line count, got ${await text("info-lines")}`);
    assert(/^\d{4}-\d\d-\d\d /.test(await text("info-mtime")), "modified time formatted");
    await dialog.locator('[data-testid="info-copy-path"]').click();
    await dialog.locator('[data-testid="info-close"]').click();
    await waitFor(async () => (await dialog.count()) === 0, "dialog closes");

    // --- folder Info with on-demand size ------------------------------------------
    await row("/home/testuser/projects").click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Info/ }).click();
    await waitFor(async () => (await dialog.locator('[data-testid="info-calc-size"]').count()) === 1, "folder info with Calculate size");
    assert((await text("info-type")) === "Folder", "folder type");
    await dialog.locator('[data-testid="info-calc-size"]').click();
    await waitFor(async () => (await dialog.locator('[data-testid="info-counts"]').count()) === 1, "size calculated");
    assert((await text("info-counts")).includes("2 files"), `file count, got ${await text("info-counts")}`);
    await page.keyboard.press("Escape");
    await waitFor(async () => (await dialog.count()) === 0, "dialog closes with Escape");

    // --- multi-select summary (Ctrl+click) ----------------------------------------
    await row("/home/testuser/readme.txt").click();
    await row("/home/testuser/notes.md").click({ modifiers: ["Control"] });
    await row("/home/testuser/projects").click({ modifiers: ["Control"] });
    await row("/home/testuser/notes.md").click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Info/ }).click();
    await waitFor(async () => (await dialog.locator('[data-testid="info-multi-count"]').count()) === 1, "multi summary");
    const summary = await text("info-multi-count");
    assert(summary.includes("3 items") && summary.includes("2 files, 1 folders"), `summary, got ${summary}`);
    await dialog.locator('[data-testid="info-close"]').click();
  },
};
