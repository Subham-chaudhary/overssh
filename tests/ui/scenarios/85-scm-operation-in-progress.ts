import type { Page } from "playwright-core";
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §15.4.HF2: a rebase / cherry-pick left in progress (files in the git dir)
// shows a banner with Continue / Skip / Abort; Continue waits for resolved conflicts;
// Abort asks first. Rebase items in the ⋯ menu only show while a rebase runs.
const REPO = "/home/testuser/projects";

type Call = { repo: string; args: string[] };
const calls = (page: Page): Promise<Call[]> => page.evaluate(() => window.__harness.g1GitCalls());
const ran = async (page: Page, ...args: string[]): Promise<boolean> =>
  (await calls(page)).some((c) => args.every((a) => c.args.includes(a)));
const patch = (page: Page, p: Record<string, unknown>) =>
  page.evaluate(([root, v]) => window.__harness.g1GitPatch(root as string, v as Record<string, unknown>), [REPO, p] as const);
const refresh = (page: Page) =>
  page.evaluate(() => (window as unknown as { __gitStore: { refresh(full?: boolean): Promise<void> } }).__gitStore.refresh(true));
const banner = (page: Page) => page.locator('[data-testid="scm-operation"]');

const SEED_FILES = [
  { path: "README.md", x: "M", y: "." },
  { path: "src/app.js", x: ".", y: "M" },
];

export const scenario: Scenario = {
  name: "scm: rebase / cherry-pick in progress banner with continue / skip / abort",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    await page.getByRole("button", { name: "Source Control", exact: true }).click();
    await waitFor(async () => (await page.locator('[data-testid="scm-state-norepo"]').count()) === 1, "no repo at home");
    await patch(page, { gitDirEntries: ["HEAD", "config", "index"], files: SEED_FILES });
    await page.locator('[data-testid="scm-open-path"]').fill(REPO);
    await page.locator('[data-testid="scm-open-repo"]').click();
    await waitFor(async () => (await page.locator('[data-testid="scm-view"]').getAttribute("data-state")) === "ready", "repo ready");
    await waitFor(async () => ran(page, "--absolute-git-dir"), "git dir looked up");
    assert((await banner(page).count()) === 0, "no banner without an operation");

    // The ⋯ menu hides the rebase items when the git dir shows no rebase.
    await page.locator('[data-testid="scm-more"]').click();
    await waitFor(async () => (await page.getByRole("menuitem", { name: "Fetch" }).count()) === 1, "menu open");
    assert((await page.getByRole("menuitem", { name: "Continue Rebase" }).count()) === 0, "no Continue Rebase item");
    await page.keyboard.press("Escape");

    // Rebase stopped on a conflict: banner, Continue disabled until the conflict is resolved.
    await patch(page, {
      gitDirEntries: ["HEAD", "rebase-merge"],
      files: [...SEED_FILES, { path: "clash.txt", x: "U", y: "U", unmerged: true }],
    });
    await refresh(page);
    await waitFor(async () => (await banner(page).getAttribute("data-op")) === "rebase", "rebase banner");
    assert((await banner(page).innerText()).includes("rebase is in progress"), "explains the rebase");
    assert(await page.locator('[data-testid="scm-op-continue"]').isDisabled(), "Continue disabled while conflicts remain");

    await patch(page, { files: SEED_FILES });
    await refresh(page);
    await waitFor(async () => !(await page.locator('[data-testid="scm-op-continue"]').isDisabled()), "Continue enabled");
    await page.locator('[data-testid="scm-op-continue"]').click();
    await waitFor(async () => ran(page, "rebase", "--continue"), "rebase --continue ran");
    assert(await ran(page, "core.editor=true", "rebase", "--continue"), "no editor is opened");
    await waitFor(async () => (await banner(page).count()) === 0, "banner gone after continue");

    // Cherry-pick in progress: Abort asks first, then runs cherry-pick --abort.
    await patch(page, { gitDirEntries: ["HEAD", "CHERRY_PICK_HEAD"] });
    await refresh(page);
    await waitFor(async () => (await banner(page).getAttribute("data-op")) === "cherry-pick", "cherry-pick banner");
    await page.locator('[data-testid="scm-op-abort"]').click();
    await waitFor(async () => (await page.locator('[data-slot="alert-dialog-action"]').count()) === 1, "abort asks first");
    assert(!(await ran(page, "cherry-pick", "--abort")), "nothing ran before confirming");
    await page.locator('[data-slot="alert-dialog-action"]').filter({ hasText: "Abort" }).click();
    await waitFor(async () => ran(page, "cherry-pick", "--abort"), "cherry-pick --abort ran");
    await waitFor(async () => (await banner(page).count()) === 0, "banner gone after abort");
  },
};
