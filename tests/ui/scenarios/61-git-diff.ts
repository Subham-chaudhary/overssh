import type { Page } from "playwright-core";
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";
import { C2, C3, FAKE_REPO, M1 } from "../fakeGitG2";

// docs/GUIDE.md §14.4.G2: commit details (files, stats, parents), the Monaco commit diff
// (modified / renamed / deleted / binary, inline toggle, merge parent choice) and working
// change diffs (staged, unstaged, untracked).

declare global {
  interface Window {
    __gitStore: {
      repos: Record<string, string | null>;
      revision: number;
      selection: unknown;
    };
    __harness: Window["__harness"] & {
      gitCalls: () => string[][];
      gitFakeSet: (p: Record<string, unknown>) => void;
    };
  }
}

const diff = (page: Page) => page.locator('[data-testid="git-file-diff"]');
const editor = (page: Page) => page.locator('[data-testid="git-diff-editor"]');

// Monaco renders spaces as non-breaking spaces; the editor can also be re-created while a file loads.
async function diffText(page: Page): Promise<string> {
  if ((await editor(page).count()) === 0) return "";
  return (await editor(page).innerText()).replace(/ /g, " ");
}

export const scenario: Scenario = {
  name: "Git diff: commit files, rename/delete/binary, inline toggle, merge parent, working changes",
  async run({ page }) {
    await page.evaluate(() => {
      window.__harness.setReadFileDelay(0);
      window.__harness.gitFakeSet({ active: true, mode: "small" });
    });
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    await page.evaluate((repo) => {
      window.__gitStore.repos[window.__harness.sessions()[0].id] = repo;
    }, FAKE_REPO);
    await page.getByRole("button", { name: "Source Control", exact: true }).click();
    await waitFor(async () => (await page.locator('[data-testid="git-row"]').count()) === 6, "graph loaded", 15000);

    // Select a commit through the store (like Source Control would): details + files.
    await page.evaluate((sha) => {
      window.__gitStore.selection = { kind: "commit", sha };
    }, C2);
    await waitFor(async () => (await page.locator('[data-testid="changed-file"]').count()) === 4, "4 changed files", 15000);
    const summary = await page.locator('[data-testid="details-summary"]').innerText();
    assert(/4 files changed/.test(summary) && summary.includes("+3") && summary.includes("-5"), `summary: ${summary}`);
    const status = await page.locator('[data-testid="changed-file"]').evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.status}:${(e as HTMLElement).dataset.path}`));
    assert(
      JSON.stringify(status) === JSON.stringify(["M:README.md", "R:docs/guide.md", "D:legacy.txt", "M:logo.png"]),
      `file statuses: ${status.join(", ")}`,
    );

    // Tree mode groups by folder.
    await page.locator('[data-testid="files-mode-tree"]').click();
    await waitFor(async () => (await page.locator('[data-testid="changed-dir"]').count()) === 1, "one folder in tree mode");
    await page.locator('[data-testid="files-mode-list"]').click();

    // Modified file: Monaco diff with both versions.
    await page.locator('[data-testid="changed-file"][data-path="README.md"]').click();
    await waitFor(async () => (await diff(page).count()) === 1, "diff page opened");
    await waitFor(async () => (await editor(page).locator(".monaco-diff-editor").count()) === 1, "monaco diff editor", 20000);
    await waitFor(async () => (await diffText(page)).includes("A readme with more words."), "modified side shown");
    assert((await diff(page).locator('[data-testid="diff-title"]').innerText()) === "README.md", "diff title");

    // Side by side <-> inline.
    assert((await editor(page).getAttribute("data-side-by-side")) === "true", "side by side by default");
    await diff(page).locator('[data-testid="diff-toggle-inline"]').click();
    await waitFor(async () => (await editor(page).getAttribute("data-side-by-side")) === "false", "inline mode");
    await diff(page).locator('[data-testid="diff-toggle-inline"]').click();
    await waitFor(async () => (await editor(page).getAttribute("data-side-by-side")) === "true", "side by side again");
    // Ignore whitespace toggles its pressed state.
    await diff(page).locator('[data-testid="diff-toggle-whitespace"]').click();
    assert((await diff(page).locator('[data-testid="diff-toggle-whitespace"]').getAttribute("aria-pressed")) === "true", "ignore whitespace on");
    await diff(page).locator('[data-testid="diff-toggle-whitespace"]').click();

    // Renamed file: old path shown, content from the old and the new path.
    await diff(page).locator('[data-testid="changed-file"][data-path="docs/guide.md"]').click();
    await waitFor(async () => (await diff(page).getByText("(from old-name.txt)").count()) === 1, "rename source shown");
    await waitFor(async () => (await diffText(page)).includes("new line"), "renamed file content");

    // Deleted file: only the original side has text.
    await diff(page).locator('[data-testid="changed-file"][data-path="legacy.txt"]').click();
    await waitFor(async () => (await diffText(page)).includes("legacy 2"), "deleted file content");

    // Binary file.
    await diff(page).locator('[data-testid="changed-file"][data-path="logo.png"]').click();
    await waitFor(async () => (await diff(page).locator('[data-testid="diff-binary"]').count()) === 1, "binary notice");

    // Next file button walks the list; Back returns to the graph with details open.
    await diff(page).locator('[data-testid="diff-prev-file"]').click();
    await waitFor(async () => (await diff(page).getAttribute("data-path")) === "legacy.txt", "previous file");
    await diff(page).locator('[data-testid="diff-back"]').click();
    await waitFor(async () => (await page.locator('[data-testid="commit-list"]').count()) === 1, "back to the graph");
    assert((await page.locator('[data-testid="details-subject"]').innerText()) === "Update readme", "details still open");

    // Merge commit: files against parent 1, then parent 2.
    await page.locator(`[data-testid="git-row"][data-sha="${M1}"]`).click();
    await waitFor(async () => (await page.locator('[data-testid="details-parent-select"]').count()) === 1, "parent select for a merge");
    await waitFor(async () => (await page.locator('[data-testid="changed-file"][data-path="feature.txt"]').count()) === 1, "files vs first parent");
    await page.locator('[data-testid="details-parent-select"]').selectOption("1");
    await waitFor(async () => (await page.locator('[data-testid="changed-file"][data-path="app.js"]').count()) === 1, "files vs second parent");
    await page.locator('[data-testid="changed-file"][data-path="app.js"]').click();
    await waitFor(async () => (await editor(page).locator(".monaco-diff-editor").count()) === 1, "merge diff editor", 20000);
    await waitFor(async () => (await diffText(page)).includes("fixed-parser"), "merge diff against parent 2");

    // Clicking a parent link selects that commit.
    await diff(page).locator('[data-testid="diff-back"]').click();
    await waitFor(async () => (await page.locator('[data-testid="details-parent"]').count()) === 2, "two parent links");
    await page.locator('[data-testid="details-parent"]').first().click();
    await waitFor(async () => (await page.locator('[data-testid="details-subject"]').innerText().catch(() => "")) === "Fix bug in parser", `parent ${C3.slice(0, 7)} selected`);

    // Uncommitted row lists working changes; clicking one opens the working diff.
    await page.locator('[data-testid="git-row-uncommitted"]').click();
    await waitFor(async () => (await page.locator('[data-testid="working-file"]').count()) === 2, "two working changes");
    await page.locator('[data-testid="working-file"][data-path="app.js"]').click();
    await waitFor(async () => (await editor(page).locator(".monaco-diff-editor").count()) === 1, "unstaged diff editor", 20000);
    // unstaged = index (left) vs working file (right)
    await waitFor(async () => (await diffText(page)).includes("hello-index") && (await diffText(page)).includes("console.log('hi')"), "index vs working file");
    assert((await diff(page).innerText()).includes("Index"), "index label");

    // Staged: HEAD vs index.
    await page.evaluate(() => {
      window.__gitStore.selection = { kind: "change", path: "app.js", staged: true };
    });
    await waitFor(async () => (await diff(page).innerText()).includes("HEAD"), "staged labels");
    await waitFor(async () => (await diffText(page)).includes("hello-index"), "staged shows the index side");

    // Untracked: empty vs the file.
    await page.evaluate(() => {
      window.__gitStore.selection = { kind: "change", path: "index.html", staged: false, untracked: true };
    });
    await waitFor(async () => (await diffText(page)).includes("fake"), "untracked file content");

    // Open file in the editor.
    await diff(page).locator('[data-testid="diff-open-file"]').click();
    await waitFor(
      async () => (await page.locator(`[role="tablist"][aria-label="Open files"] [role="tab"][title="${FAKE_REPO}/index.html"]`).count()) === 1,
      "file opened in an editor tab",
      15000,
    );

    await page.evaluate(() => window.__harness.gitFakeSet({ active: false }));
  },
};
