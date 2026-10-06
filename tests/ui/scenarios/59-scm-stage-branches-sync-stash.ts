import type { Page } from "playwright-core";
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §14.4.G1: open a repository by path, stage / unstage / discard,
// commit options, branches (checkout, create, delete, publish, merge conflict),
// sync, stash, Git settings, palette commands.
const REPO = "/home/testuser/projects";

type Call = { repo: string; args: string[]; stdin?: string };
const calls = (page: Page): Promise<Call[]> => page.evaluate(() => window.__harness.g1GitCalls());
const has = async (page: Page, ...args: string[]): Promise<boolean> =>
  (await calls(page)).some((c) => JSON.stringify(c.args.slice(0, args.length)) === JSON.stringify(args));
const count = async (page: Page, sel: string): Promise<number> => page.locator(sel).count();
const row = (page: Page, section: string, path: string) =>
  page.locator(`[data-testid="scm-section-${section}"] [data-testid="scm-row"][data-path="${path}"]`);

async function countText(page: Page, section: string): Promise<string> {
  const loc = page.locator(`[data-testid="scm-count-${section}"]`);
  return (await loc.count()) === 0 ? "0" : await loc.innerText();
}

async function confirm(page: Page, label: string): Promise<void> {
  await page.locator(`[data-slot="alert-dialog-action"]`).filter({ hasText: label }).click();
}

export const scenario: Scenario = {
  name: "scm: stage/unstage/discard, commit options, branches, sync, stash, settings, palette",
  async run({ page }) {
    await waitFor(async () => (await count(page, '[data-testid="host-row"]')) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    await page.getByRole("button", { name: "Source Control", exact: true }).click();
    await waitFor(async () => (await count(page, '[data-testid="scm-state-norepo"]')) === 1, "not a repo at the home folder");

    // Open another repository by path.
    await page.locator('[data-testid="scm-open-path"]').fill(REPO);
    await page.locator('[data-testid="scm-open-repo"]').click();
    await waitFor(async () => (await page.locator('[data-testid="scm-view"]').getAttribute("data-state")) === "ready", "repo ready");
    await waitFor(async () => (await countText(page, "staged")) === "2", "2 staged");
    assert((await countText(page, "changes")) === "3", "3 changes (2 tracked, 1 untracked)");
    assert((await row(page, "staged", "docs/guide.md").getAttribute("data-code")) === "R", "rename badge R");
    assert((await row(page, "changes", "src/gone.js").getAttribute("data-code")) === "D", "deleted badge D");
    assert((await row(page, "changes", "notes.txt").getAttribute("data-code")) === "?", "untracked badge ?");
    assert((await page.locator('[data-testid="scm-branch-name"]').innerText()) === "main", "branch main");
    assert((await page.locator('[data-testid="scm-ahead-behind"]').innerText()).includes("1"), "ahead 1");

    // Tree view toggle shows folders, list view again.
    await page.locator('[data-testid="scm-view-toggle"]').click();
    await waitFor(async () => (await count(page, '[data-testid="scm-folder"][data-path="src"]')) === 1, "tree shows the src folder");
    await page.locator('[data-testid="scm-view-toggle"]').click();
    await waitFor(async () => (await count(page, '[data-testid="scm-folder"]')) === 0, "list view again");

    // Stage one file, unstage another.
    await row(page, "changes", "src/app.js").hover();
    await row(page, "changes", "src/app.js").locator('[data-testid="scm-stage"]').click();
    await waitFor(async () => (await countText(page, "staged")) === "3", "app.js staged");
    assert(await has(page, "add", "--", "src/app.js"), "add -- src/app.js");
    await row(page, "staged", "README.md").hover();
    await row(page, "staged", "README.md").locator('[data-testid="scm-unstage"]').click();
    await waitFor(async () => (await countText(page, "staged")) === "2", "README unstaged");
    assert(await has(page, "restore", "--staged", "--", "README.md"), "restore --staged -- README.md");
    assert((await countText(page, "changes")) === "3", "README back under Changes");

    // Selecting a change.
    await row(page, "staged", "src/app.js").click();
    await waitFor(async () => (await row(page, "staged", "src/app.js").getAttribute("aria-pressed")) === "true", "change selected");

    // Discard an untracked file asks first, then cleans.
    await row(page, "changes", "notes.txt").hover();
    await row(page, "changes", "notes.txt").locator('[data-testid="scm-discard"]').click();
    await confirm(page, "Delete");
    await waitFor(async () => (await count(page, '[data-testid="scm-row"][data-path="notes.txt"]')) === 0, "notes.txt deleted");
    assert(await has(page, "clean", "-f", "--", "notes.txt"), "clean -f -- notes.txt");

    // Commit staged (no smart-commit question), message on stdin.
    const box = page.locator('[data-testid="scm-commit-input"]');
    await box.fill("feat: staged work\n\nbody line");
    await box.press("Control+Enter");
    await waitFor(async () => (await has(page, "commit", "-F", "-")) === true, "commit ran");
    const first = (await calls(page)).find((c) => c.args[0] === "commit")!;
    assert(first.stdin === "feat: staged work\n\nbody line\n", "message via stdin");
    await waitFor(async () => (await countText(page, "staged")) === "0", "staged emptied by the commit");
    await waitFor(async () => (await page.locator('[data-testid="scm-ahead-behind"]').innerText()).includes("2"), "ahead 2");

    // Sign-off option + Commit Staged from the split button.
    await page.locator('[data-testid="scm-section-changes"] > div').first().hover();
    await page.locator('[data-testid="scm-stage-all"]').click();
    await waitFor(async () => (await countText(page, "staged")) === "2", "stage all");
    await page.locator('[data-testid="scm-commit-menu"]').click();
    await page.locator('[data-testid="scm-signoff"]').click();
    await page.keyboard.press("Escape");
    await box.fill("second");
    await page.locator('[data-testid="scm-commit-menu"]').click();
    await page.locator('[data-testid="scm-commit-staged"]').click();
    await waitFor(async () => (await calls(page)).filter((c) => c.args[0] === "commit").length === 2, "second commit");
    const second = (await calls(page)).filter((c) => c.args[0] === "commit")[1];
    assert(second.args.includes("--signoff"), `--signoff passed (got ${JSON.stringify(second.args)})`);

    // --- Branches -------------------------------------------------------------------
    assert((await count(page, '[data-testid="scm-local-branch"]')) === 2, "two local branches");
    assert((await count(page, '[data-testid="scm-remote-branch"]')) === 2, "two remote branches");
    await page.locator('[data-testid="scm-tags-toggle"]').click();
    await waitFor(async () => (await count(page, '[data-testid="scm-tag"]')) === 1, "tag listed");

    // Double click checks out.
    await page.locator('[data-testid="scm-local-branch"][data-name="dev"]').dblclick();
    await waitFor(async () => (await page.locator('[data-testid="scm-branch-name"]').innerText()) === "dev", "checked out dev");
    assert(await has(page, "checkout", "dev"), "checkout dev");

    // Quick pick back to main.
    await page.locator('[data-testid="scm-branch"]').click();
    await page.locator('[data-testid="scm-picker-input"]').fill("main");
    await page.locator('[data-slot="command-item"]', { hasText: "main" }).first().click();
    await waitFor(async () => (await page.locator('[data-testid="scm-branch-name"]').innerText()) === "main", "picker checked out main");

    // Create a branch from the + button.
    await page.locator('[data-testid="scm-create-branch"]').click();
    await page.getByRole("dialog").locator("input").fill("topic");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await page.locator('[data-testid="scm-branch-name"]').innerText()) === "topic", "created and switched to topic");
    assert(await has(page, "checkout", "-b", "topic"), "checkout -b topic");

    // Publish (no upstream) asks, then pushes with -u.
    await waitFor(async () => (await count(page, '[data-testid="scm-publish"]')) === 1, "publish button for a branch without upstream");
    await page.locator('[data-testid="scm-publish"]').click();
    await confirm(page, "Publish");
    await waitFor(async () => (await has(page, "push", "-u", "origin", "topic")) === true, "push -u origin topic");
    await waitFor(async () => (await count(page, '[data-testid="scm-sync"]')) === 1, "Sync button once it has an upstream");

    // Sync: pull (merge by default) then push when ahead.
    await page.locator('[data-testid="scm-sync"]').click();
    await confirm(page, "Sync");
    await waitFor(async () => (await has(page, "pull", "--no-rebase", "--no-edit")) === true, "pull --no-rebase");

    // Delete a branch (confirm).
    await page.locator('[data-testid="scm-local-branch"][data-name="dev"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await confirm(page, "Delete");
    await waitFor(async () => (await count(page, '[data-testid="scm-local-branch"][data-name="dev"]')) === 0, "dev deleted");
    assert(await has(page, "branch", "-d", "dev"), "branch -d dev");

    // Merge that conflicts shows Merge Changes and the abort action.
    await page.evaluate(() => window.__harness.g1GitPatch("/home/testuser/projects", { branches: ["main", "topic", "conflict-branch"] }));
    await page.locator('[data-testid="scm-refresh"]').click();
    await waitFor(async () => (await count(page, '[data-testid="scm-local-branch"][data-name="conflict-branch"]')) === 1, "conflict branch listed");
    await page.locator('[data-testid="scm-local-branch"][data-name="conflict-branch"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Merge into Current Branch" }).click();
    await waitFor(async () => (await count(page, '[data-testid="scm-section-merge"]')) === 1, "Merge Changes section");
    assert((await row(page, "merge", "clash.txt").getAttribute("data-code")) === "U", "conflict badge");
    assert((await count(page, '[data-testid="scm-merging"]')) === 1, "merge banner");
    await page.locator('[data-testid="scm-more"]').click();
    await waitFor(async () => (await count(page, '[data-testid="scm-abort-merge"]')) === 1, "Abort Merge offered");
    await page.keyboard.press("Escape");
    // Resolve (stage) it and abort the merge state through the fake to keep the rest simple.
    await page.evaluate(() => window.__harness.g1GitPatch("/home/testuser/projects", { merging: false, files: [] }));
    await page.locator('[data-testid="scm-refresh"]').click();
    await waitFor(async () => (await count(page, '[data-testid="scm-section-merge"]')) === 0, "merge state cleared");

    // --- Stash ------------------------------------------------------------------------
    await page.evaluate(() =>
      window.__harness.g1GitPatch("/home/testuser/projects", { files: [{ path: "src/app.js", x: ".", y: "M" }] }),
    );
    await page.locator('[data-testid="scm-refresh"]').click();
    await waitFor(async () => (await countText(page, "changes")) === "1", "one change to stash");
    await page.locator('[data-testid="scm-stash-new"]').click();
    await page.getByRole("dialog").locator("input").fill("wip");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await count(page, '[data-testid="scm-stash-row"]')) === 1, "stash listed");
    assert((await calls(page)).some((c) => c.args[0] === "stash" && c.args[1] === "push" && c.args.includes("wip")), "stash push -m wip");
    await waitFor(async () => (await count(page, '[data-testid="scm-clean"]')) === 1, "tree clean after stash");
    const stashRow = page.locator('[data-testid="scm-stash-row"]').first();
    await stashRow.hover();
    await stashRow.locator('[data-testid="scm-stash-pop"]').click();
    await waitFor(async () => (await count(page, '[data-testid="scm-stash-row"]')) === 0, "stash popped");
    assert(await has(page, "stash", "pop", "stash@{0}"), "stash pop stash@{0}");
    await waitFor(async () => (await countText(page, "changes")) === "1", "change restored");

    // --- Settings: Git section, pull with rebase ----------------------------------------
    await page.keyboard.press("Control+,");
    await page.getByRole("button", { name: "Git", exact: true }).click();
    await waitFor(async () => (await count(page, '[data-testid="settings-git"]')) === 1, "Git settings section");
    const git = page.locator('[data-testid="settings-git"]');
    for (const label of ["Enable Source Control", "Auto Fetch", "Prune on Fetch", "Confirm Sync", "Smart Commit", "Confirm Discard", "Pull with Rebase", "Graph Max Commits", "Graph All Branches", "Show Remote Branches", "Side-by-Side Diff", "Ignore Whitespace", "Default Branch Name"]) {
      assert((await git.innerText()).includes(label), `settings row: ${label}`);
    }
    await git.getByRole("switch").nth(5).click(); // Pull with Rebase
    await page.keyboard.press("Escape");
    await waitFor(async () => (await count(page, '[data-testid="settings-git"]')) === 0, "settings closed");

    // --- Palette --------------------------------------------------------------------------
    await page.keyboard.press("Control+Shift+P");
    await page.locator('[data-slot="command-input"]').fill("Git: Pull");
    await page.keyboard.press("Enter");
    await confirm(page, "Pull");
    await waitFor(async () => (await has(page, "pull", "--rebase")) === true, "palette Git: Pull uses --rebase");

    await page.keyboard.press("Control+Shift+P");
    await page.locator('[data-slot="command-input"]').fill("Git: Fetch");
    await page.keyboard.press("Enter");
    await waitFor(async () => (await has(page, "fetch")) === true, "palette Git: Fetch");
  },
};
