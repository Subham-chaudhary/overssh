import type { Page } from "playwright-core";
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";
import { C1, C3, F2, FAKE_REPO, M1 } from "../fakeGitG2";

// docs/GUIDE.md §14.4.G2: commit graph (lanes, ref badges, uncommitted row, search,
// load more + virtualization) and the commit / badge context menu.

declare global {
  interface Window {
    __gitStore: { repos: Record<string, string | null>; revision: number; selection: unknown };
    __harness: Window["__harness"] & {
      gitCalls: () => string[][];
      gitFakeSet: (p: Record<string, unknown>) => void;
    };
  }
}

async function openGraph(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__gitStore; // must exist
    window.__harness.setReadFileDelay(0);
    window.__harness.gitFakeSet({ active: true, mode: "small" });
  });
  await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
  await page.locator('[aria-label="Connect alpha"]').click();
  await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
  await page.evaluate((repo) => {
    const id = window.__harness.sessions()[0].id;
    window.__gitStore.repos[id] = repo;
  }, FAKE_REPO);
  await page.getByRole("button", { name: "Source Control", exact: true }).click();
  await waitFor(async () => (await page.locator('[data-testid="git-row"]').count()) === 6, "6 commits rendered", 15000);
}

const calls = (page: Page) => page.evaluate(() => window.__harness.gitCalls());

export const scenario: Scenario = {
  name: "Git graph: lanes, badges, uncommitted row, search, context menu, load more",
  async run({ page }) {
    await openGraph(page);

    // Rows and ref badges.
    const row = (sha: string) => page.locator(`[data-testid="git-row"][data-sha="${sha}"]`);
    assert((await row(M1).innerText()).includes("Merge branch 'feature'"), "merge subject");
    assert((await row(M1).locator('[data-ref-name="main"][data-current="true"]').count()) === 1, "current branch badge");
    assert((await row(M1).locator('[data-ref-kind="remote"][data-ref-name="origin/main"]').count()) === 1, "remote badge");
    assert((await row(F2).locator('[data-ref-kind="branch"][data-ref-name="feature"]').count()) === 1, "local branch badge");
    assert((await page.locator('[data-ref-kind="tag"][data-ref-name="v1.0"]').count()) === 1, "tag badge");
    assert((await page.locator('[data-ref-name="origin/HEAD"]').count()) === 0, "origin/HEAD is hidden");

    // Lanes: the merge sits in lane 0, the feature commit in lane 1.
    assert((await row(M1).locator('[data-testid="graph-cell"]').getAttribute("data-lane")) === "0", "merge in lane 0");
    assert((await row(F2).locator('[data-testid="graph-cell"]').getAttribute("data-lane")) === "1", "feature in lane 1");
    assert((await row(M1).locator("svg path").count()) >= 2, "merge draws two outgoing lines");

    // Uncommitted changes row on top (the fake repo is dirty).
    const unc = page.locator('[data-testid="git-row-uncommitted"]');
    await waitFor(async () => (await unc.count()) === 1, "uncommitted row");
    assert((await unc.innerText()).includes("Uncommitted Changes (2)"), `uncommitted label: ${await unc.innerText()}`);
    const order = await page.locator('[data-testid="commit-list"] [role="option"]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.sha));
    assert(order[0] === "*uncommitted*" && order[1] === M1, `row order: ${order.join(",")}`);

    // Search filters rows (message / author / sha).
    const search = page.locator('[data-testid="graph-search"]');
    await search.fill("parser");
    await waitFor(async () => (await page.locator('[data-testid="git-row"]').count()) === 1, "one match for 'parser'");
    await search.fill("bob");
    await waitFor(async () => (await page.locator('[data-testid="git-row"]').count()) === 2, "two commits by Bob");
    await search.fill("zzzz-nothing");
    await waitFor(async () => (await page.locator('[data-testid="graph-empty"]').count()) === 1, "empty search state");
    await search.fill("");
    await waitFor(async () => (await page.locator('[data-testid="git-row"]').count()) === 6, "all rows back");

    // Selecting a row opens the details pane.
    await row(C3).click();
    await waitFor(async () => (await page.locator('[data-testid="details-subject"]').innerText().catch(() => "")) === "Fix bug in parser", "details subject");
    assert((await page.locator('[data-testid="details-body"]').innerText()).includes("Closes #12"), "details body");

    // Commit context menu: Checkout (Detached HEAD).
    await row(C3).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Checkout (Detached HEAD)" }).click();
    await waitFor(async () => (await calls(page)).some((a) => a[0] === "checkout" && a[1] === "--detach" && a[2] === C3), "checkout --detach sha");

    // Cherry-pick and revert.
    await row(F2).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Cherry-pick" }).click();
    await waitFor(async () => (await calls(page)).some((a) => a.join(" ") === `cherry-pick ${F2}`), "cherry-pick sha");
    await row(C3).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Revert", exact: true }).click();
    await waitFor(async () => (await calls(page)).some((a) => a.join(" ") === `revert --no-edit ${C3}`), "revert sha");

    // A merge commit is cherry-picked / reverted against its first parent.
    await row(M1).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Revert", exact: true }).click();
    await waitFor(async () => (await calls(page)).some((a) => a.join(" ") === `revert --no-edit -m 1 ${M1}`), "revert merge -m 1");

    // Reset: soft is immediate, hard asks first.
    await row(C1).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Reset Current Branch to Here" }).click();
    await page.getByRole("menuitem", { name: /^Soft/ }).click();
    await waitFor(async () => (await calls(page)).some((a) => a.join(" ") === `reset --soft ${C1}`), "reset --soft");
    await row(C1).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Reset Current Branch to Here" }).click();
    await page.getByRole("menuitem", { name: /^Hard/ }).click();
    await waitFor(async () => (await page.getByRole("alertdialog").count()) === 1, "hard reset confirm dialog");
    assert(!(await calls(page)).some((a) => a.join(" ") === `reset --hard ${C1}`), "no hard reset before confirming");
    await page.getByRole("button", { name: "Hard reset", exact: true }).click();
    await waitFor(async () => (await calls(page)).some((a) => a.join(" ") === `reset --hard ${C1}`), "reset --hard after confirm");

    // Create branch / tag prompt for a name.
    await row(C3).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Create Branch Here..." }).click();
    await page.getByRole("dialog").locator("input").fill("topic");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await waitFor(async () => (await calls(page)).some((a) => a.join(" ") === `branch topic ${C3}`), "branch name sha");
    await row(C3).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Create Tag Here..." }).click();
    await page.getByRole("dialog").locator("input").fill("rel-1");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await waitFor(async () => (await calls(page)).some((a) => a.join(" ") === `tag rel-1 ${C3}`), "tag name sha");

    // Ref badge menu: merge a branch into the current one, current branch has no checkout.
    await row(F2).locator('[data-ref-name="feature"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Merge into Current Branch" }).click();
    await waitFor(async () => (await calls(page)).some((a) => a.join(" ") === "merge --no-edit feature"), "merge feature");
    await row(F2).locator('[data-ref-name="feature"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Checkout Branch" }).click();
    await waitFor(async () => (await calls(page)).some((a) => a.join(" ") === "checkout feature"), "checkout feature");
    await row(M1).locator('[data-ref-name="main"]').click({ button: "right" });
    await waitFor(async () => (await page.getByRole("menuitem").count()) > 0, "badge menu open");
    assert((await page.getByRole("menuitem", { name: "Checkout Branch" }).count()) === 0, "no checkout item for the current branch");
    assert((await page.getByRole("menuitem", { name: "Delete Branch" }).count()) === 0, "no delete item for the current branch");
    await page.keyboard.press("Escape");

    // A failed git command is reported, not swallowed.
    await page.evaluate(() => window.__harness.gitFakeSet({ failNext: "error: could not apply deadbeef" }));
    await row(C3).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Cherry-pick" }).click();
    await waitFor(async () => (await page.getByText("could not apply deadbeef").count()) > 0, "error toast shown");

    // Large history: load more + virtualized rows.
    await page.evaluate(() => {
      window.__harness.gitFakeSet({ mode: "big", dirty: [] });
      window.__gitStore.selection = null;
      window.__gitStore.revision++;
    });
    await waitFor(async () => (await page.locator('[data-testid="graph-load-more"]').count()) === 1, "load more offered (500 of 1200)", 15000);
    await page.locator('[data-testid="graph-load-more"]').click();
    await waitFor(async () => (await page.getByText("1000 commits loaded").count()) === 1, "second page loaded");
    await page.locator('[data-testid="graph-load-more"]').click();
    await waitFor(async () => (await page.locator('[data-testid="graph-load-more"]').count()) === 0, "all 1200 loaded");
    const rendered = await page.locator('[data-testid="git-row"]').count();
    assert(rendered > 5 && rendered < 80, `rows are virtualized (rendered ${rendered} of 1200)`);
    const height = await page.locator('[data-testid="commit-list"] > div').evaluate((e) => (e as HTMLElement).offsetHeight);
    assert(height === 1200 * 26, `spacer height ${height}`);
    // Scroll to the bottom: the oldest commit gets rendered.
    await page.locator('[data-testid="commit-list"]').evaluate((e) => (e.scrollTop = e.scrollHeight));
    await waitFor(async () => (await page.getByText("Bulk commit 1", { exact: true }).count()) === 1, "oldest commit rendered after scrolling");

    await page.evaluate(() => window.__harness.gitFakeSet({ active: false }));
  },
};
