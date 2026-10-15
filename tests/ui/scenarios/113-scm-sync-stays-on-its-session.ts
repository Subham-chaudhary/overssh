import type { Page } from "playwright-core";
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// A multi-step mutation (Sync = pull, then push) belongs to the repo it was started in. Switching
// to another session while the pull runs must not send the next steps to the other session.
const REPO = "/home/testuser/projects";
const activate = (page: Page, sid: string) =>
  page.evaluate(`import("/src/lib/stores.svelte.ts").then((m) => m.app.setActiveSession(${JSON.stringify(sid)}))`);
const calls = (page: Page) => page.evaluate(() => window.__harness.gitSessionCalls());

export const scenario: Scenario = {
  name: "scm: sync keeps running in the session it started in after a session switch",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "alpha connected");
    const a = (await page.evaluate(() => window.__harness.sessions()))[0].id;
    await page.getByRole("button", { name: "Source Control", exact: true }).click();
    await waitFor(async () => (await page.locator('[data-testid="scm-state-norepo"]').count()) === 1, "no repo at home");
    await page.locator('[data-testid="scm-open-path"]').fill(REPO);
    await page.locator('[data-testid="scm-open-repo"]').click();
    await waitFor(async () => (await page.locator('[data-testid="scm-view"]').getAttribute("data-state")) === "ready", "repo ready");

    await page.getByRole("button", { name: "Hosts" }).click();
    await page.locator('[aria-label="Connect beta"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 2, "beta connected");
    const b = (await page.evaluate(() => window.__harness.sessions())).map((s) => s.id).find((id) => id !== a) as string;
    await activate(page, a);
    await page.getByRole("button", { name: "Source Control", exact: true }).click();
    await waitFor(async () => (await page.locator('[data-testid="scm-view"]').getAttribute("data-state")) === "ready", "alpha repo ready again");

    await page.evaluate(() => window.__harness.gitHold("pull"));
    await page.locator('[data-testid="scm-sync"]').click();
    await page.locator('[data-slot="alert-dialog-action"]').filter({ hasText: "Sync" }).click();
    await waitFor(async () => (await calls(page)).some((c) => c.args[0] === "pull" && c.sessionId === a), "pull started in alpha");

    await activate(page, b); // switch away while the pull is still running
    await page.evaluate(() => window.__harness.gitRelease());
    await waitFor(async () => (await calls(page)).some((c) => c.args[0] === "rev-list" || c.args[0] === "push"), "sync went on after the pull");
    await page.waitForTimeout(600);
    const after = (await calls(page)).filter((c) => c.args[0] === "rev-list" || c.args[0] === "push");
    assert(after.length > 0 && after.every((c) => c.sessionId === a), `sync steps ran in alpha (got ${JSON.stringify(after)})`);
    assert(after.some((c) => c.args[0] === "push"), "the push ran");
  },
};
