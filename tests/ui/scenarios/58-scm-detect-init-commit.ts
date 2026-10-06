import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §14.4.G1: Source Control repo states (git missing, not a repo,
// Initialize Repository) and the first commit through smart commit.
export const scenario: Scenario = {
  name: "scm: git missing / not a repo states, init repository, smart commit",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.evaluate(() => window.__harness.g1GitMissing(true));
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    // Not connected state is covered by the state attribute before any session; here: git not installed.
    await page.getByRole("button", { name: "Source Control", exact: true }).click();
    await waitFor(async () => (await page.locator('[data-testid="scm-state-nogit"]').count()) === 1, "git not installed state");
    assert((await page.locator('[data-testid="scm-view"]').innerText()).includes("git is not installed"), "explains git is missing");

    // git appears: "Check again" finds a folder that is not a repository.
    await page.evaluate(() => window.__harness.g1GitMissing(false));
    await page.getByRole("button", { name: "Check again" }).click();
    await waitFor(async () => (await page.locator('[data-testid="scm-state-norepo"]').count()) === 1, "not a repo state");
    assert((await page.locator('[data-testid="scm-view"]').innerText()).includes("/home/testuser"), "names the folder");

    // Initialize Repository uses settings.git.defaultBranchName.
    await page.locator('[data-testid="scm-init"]').click();
    await waitFor(async () => (await page.locator('[data-testid="scm-view"]').getAttribute("data-state")) === "ready", "repo ready after init");
    const initCall = await page.evaluate(() => window.__harness.g1GitCalls().find((c) => c.args[0] === "init"));
    assert(JSON.stringify(initCall?.args) === JSON.stringify(["init", "-b", "main"]), `init -b main (got ${JSON.stringify(initCall?.args)})`);
    assert(initCall?.repo === "/home/testuser", "init ran in the explorer root");

    // Fresh repo: unborn branch, two untracked files in Changes.
    await waitFor(async () => (await page.locator('[data-testid="scm-branch-name"]').innerText()) === "main", "branch name main");
    await waitFor(async () => (await page.locator('[data-testid="scm-count-changes"]').count()) === 1, "changes section");
    assert((await page.locator('[data-testid="scm-count-changes"]').innerText()) === "2", "two untracked files");
    const rows = page.locator('[data-testid="scm-section-changes"] [data-testid="scm-row"]');
    assert((await rows.count()) === 2, "two rows");
    for (const code of await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-code")))) assert(code === "?", "untracked badge");

    // Clicking a row selects it (the main-area diff is the GitView's job).
    await rows.first().click();
    await waitFor(async () => (await rows.first().getAttribute("aria-pressed")) === "true", "row selected");

    // Empty message: refuse.
    await page.locator('[data-testid="scm-commit"]').click();
    await new Promise((r) => setTimeout(r, 150));
    assert(!(await page.evaluate(() => window.__harness.g1GitCalls().some((c) => c.args[0] === "commit"))), "no commit without a message");

    // Smart commit: nothing staged -> asks, then stages all and commits with the message on stdin.
    const box = page.locator('[data-testid="scm-commit-input"]');
    await box.fill("initial import\n\nfirst commit");
    await box.press("Control+Enter");
    await page.getByRole("button", { name: "Commit All", exact: true }).click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.g1GitCalls().some((c) => c.args[0] === "commit"))) === true, "commit ran");
    const calls = await page.evaluate(() => window.__harness.g1GitCalls());
    const iAdd = calls.findIndex((c) => c.args[0] === "add" && c.args.includes("-A"));
    const iCommit = calls.findIndex((c) => c.args[0] === "commit");
    assert(iAdd !== -1 && iAdd < iCommit, "stage all before commit");
    assert(JSON.stringify(calls[iCommit].args) === JSON.stringify(["commit", "-F", "-"]), `commit -F - (got ${JSON.stringify(calls[iCommit].args)})`);
    assert(calls[iCommit].stdin === "initial import\n\nfirst commit\n", "message via stdin");
    await waitFor(async () => (await page.locator('[data-testid="scm-clean"]').count()) === 1, "tree clean after commit");
    assert((await box.inputValue()) === "", "message box cleared");
    assert((await page.locator('[data-testid="scm-local-branch"][data-current="true"]').count()) === 1, "branches pane lists the new branch as current");
  },
};
