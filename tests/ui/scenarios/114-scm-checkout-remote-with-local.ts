import type { Page } from "playwright-core";
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Double-clicking a remote branch whose local branch already exists (origin/dev, local dev) must
// switch to the local branch. `git checkout --track origin/dev` would fail with "already exists".
const REPO = "/home/testuser/projects";
const calls = (page: Page): Promise<{ repo: string; args: string[] }[]> => page.evaluate(() => window.__harness.g1GitCalls());

export const scenario: Scenario = {
  name: "scm: checking out a remote branch with an existing local branch switches to the local one",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    await page.getByRole("button", { name: "Source Control", exact: true }).click();
    await waitFor(async () => (await page.locator('[data-testid="scm-state-norepo"]').count()) === 1, "no repo at home");
    await page.evaluate(([root]) => window.__harness.g1GitPatch(root, { remoteBranches: ["origin/main", "origin/dev"] }), [REPO] as const);
    await page.locator('[data-testid="scm-open-path"]').fill(REPO);
    await page.locator('[data-testid="scm-open-repo"]').click();
    await waitFor(async () => (await page.locator('[data-testid="scm-view"]').getAttribute("data-state")) === "ready", "repo ready");
    await waitFor(async () => (await page.locator('[data-testid="scm-remote-branch"][data-name="origin/dev"]').count()) === 1, "remote branch listed");

    await page.locator('[data-testid="scm-remote-branch"][data-name="origin/dev"]').dblclick();
    await waitFor(async () => (await page.locator('[data-testid="scm-branch-name"]').innerText()) === "dev", "switched to dev");
    const all = await calls(page);
    assert(all.some((c) => c.args[0] === "checkout" && c.args.includes("dev") && !c.args.includes("--track")), "checkout dev");
    assert(!all.some((c) => c.args.includes("--track")), "no --track checkout of an existing branch");
  },
};
