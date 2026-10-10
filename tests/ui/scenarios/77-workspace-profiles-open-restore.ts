import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §15.3.P: opening a workspace profile connects two hosts and restores each
// host's explorer roots (incl. a split), editor files, terminals and tunnels. One missing file,
// one busy tunnel port and one deleted host are reported without aborting the rest, and opening
// the profile again reuses the sessions (no duplicates).
const H = "/home/testuser";
const ref = (alias: string, hostname: string, user: string, port: number) => ({
  key: `config:${alias}`, name: alias, alias, hostname, user, port, identityFile: null, proxyJump: null,
});
const PROFILE = {
  id: "prof-1",
  name: "Two hosts",
  icon: "rocket",
  color: "#61afef",
  activeHost: "e-alpha",
  view: { sidebar: "explorer", dashboardTab: null, showTerminal: true },
  terminals: { detached: false, layout: null, focus: null },
  createdAt: 1, updatedAt: 1, lastOpenedAt: null,
  hosts: [
    {
      id: "e-alpha", ref: ref("alpha", "alpha.example.com", "root", 22), tunnelOnly: false,
      explorer: { panes: [{ cwd: `${H}/projects`, expanded: [] }, { cwd: `${H}/.config`, expanded: [] }], activePane: 0, splitRatio: 0.5 },
      files: [{ path: `${H}/projects/app.js`, line: 1, col: 1 }, { path: `${H}/missing.txt`, line: 1, col: 1 }, { path: `${H}/readme.txt`, line: 1, col: 1 }],
      activeFile: `${H}/readme.txt`,
      terminals: [{ title: "build", cwd: `${H}/projects`, command: "echo hi" }, { title: null, cwd: null, command: null }],
      activeTerminal: 0,
      forwards: [{ ruleId: "r-busy", label: "busy", kind: "L", bindPort: 1, targetHost: "localhost", targetPort: 80 }],
    },
    {
      id: "e-beta", ref: ref("beta", "beta.example.com", "deploy", 2222), tunnelOnly: false,
      explorer: { panes: [{ cwd: `${H}/.config`, expanded: [] }], activePane: 0, splitRatio: 0.5 },
      files: [{ path: `${H}/.config/settings.ini`, line: 1, col: 1 }], activeFile: `${H}/.config/settings.ini`,
      terminals: [{ title: "beta shell", cwd: null, command: null }], activeTerminal: 0, forwards: [],
    },
    {
      id: "e-gone", ref: { key: "saved:deleted", name: "old box", alias: null, hostname: "old.example.com", user: "root", port: 22, identityFile: null, proxyJump: null },
      tunnelOnly: false, explorer: null, files: [], activeFile: null, terminals: [], activeTerminal: null, forwards: [],
    },
  ],
};
const RULE = { id: "r-busy", host: "config:alpha", kind: "L", bindAddress: "", bindPort: 1, targetHost: "localhost", targetPort: 80, label: "busy", autoStart: false, tunnelOnly: false };

export const scenario: Scenario = {
  name: "Workspace profiles: open restores two hosts, reports failures, is idempotent",
  async beforeLoad({ page }) {
    await page.addInitScript(
      (seed) => {
        (window as unknown as { __HARNESS_SEED_STORES__?: Record<string, unknown> }).__HARNESS_SEED_STORES__ = seed;
      },
      { workspaces: { version: 1, profiles: [PROFILE], startupId: null, options: { mode: "sequential", closeOthers: false } }, forwards: [RULE] },
    );
  },
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await waitFor(async () => (await page.locator('[data-testid="profile-row"]').count()) === 1, "seeded profile listed");

    const sessionCount = () => page.evaluate(() => window.__harness.sessions().length);
    await page.locator('[data-testid="profile-row"] button').first().click();

    // Progress card while it runs, then the report.
    await waitFor(async () => (await page.getByTestId("profile-progress").count()) === 1, "progress card shown");
    await waitFor(async () => (await page.getByTestId("profile-progress").getAttribute("data-status")) === "done", "run finished", 30000);
    assert((await sessionCount()) === 2, "alpha and beta connected, the deleted host was not");
    const reqs = await page.evaluate(() => window.__harness.connectRequests());
    assert(reqs.length === 2 && reqs[0].alias === "alpha" && reqs[1].alias === "beta", "connected in profile order through the normal connect flow");
    assert(!reqs.some((r) => r.password || r.passphrase), "no secrets in the connect requests");

    const entry = (label: string) => page.locator(`[data-testid="profile-progress-entry"][data-label="${label}"]`);
    assert((await entry("alpha").getAttribute("data-state")) === "partial", "alpha restored with issues");
    assert((await entry("beta").getAttribute("data-state")) === "done", "beta restored cleanly");
    assert((await entry("alpha").getByTestId("profile-progress-issue").count()) === 2, "two issues reported for alpha");
    const issues = (await entry("alpha").getByTestId("profile-progress-issues").innerText()).toLowerCase();
    assert(issues.includes("missing.txt"), `missing file reported (${issues})`);
    assert(issues.includes("already in use"), `busy port reported (${issues})`);
    assert((await entry("old box").getAttribute("data-state")) === "skipped", "deleted host skipped");
    assert((await entry("old box").innerText()).includes("no longer exists"), "reason given for the deleted host");
    assert((await page.getByTestId("profile-progress-title").innerText()).includes("Two hosts"), "title names the profile");

    // Alpha is the active workspace: split explorer roots, files, terminals.
    const pane = (i: number) => page.locator(`[data-explorer-pane="${i}"]`);
    await waitFor(async () => (await page.locator('[data-testid="explorer-pane"]').count()) === 2, "explorer split restored");
    assert((await pane(0).locator('input[aria-label="Path"]').inputValue()) === `${H}/projects`, "pane 0 root");
    assert((await pane(1).locator('input[aria-label="Path"]').inputValue()) === `${H}/.config`, "pane 1 root");
    const tabs = page.locator('[role="tab"][title^="/home/testuser"]');
    await waitFor(async () => (await tabs.count()) === 2, "two files open (the missing one was dropped)");
    assert((await page.locator('[role="tab"][title="/home/testuser/readme.txt"]').getAttribute("aria-selected")) === "true", "active file restored");
    assert((await page.locator('[role="tab"][title="/home/testuser/missing.txt"]').count()) === 0, "no tab for the missing file");
    await waitFor(async () => (await page.getByTestId("terminal-tab").count()) === 3, "two terminals on alpha and one on beta");
    const termTitles = await page.getByTestId("terminal-tab").allInnerTexts();
    assert(termTitles.some((t) => t.includes("build")) && termTitles.some((t) => t.includes("beta shell")), `terminal titles (${termTitles.join("|")})`);
    const writes = await page.evaluate(() => window.__harness.termWrites());
    assert(writes.some((w) => w.data === "echo hi\r"), "startup command typed into its terminal");
    const rule = (await page.evaluate(() => window.__harness.getStore("forwards"))) as { id: string }[];
    assert(rule.length === 1, "tunnel rule untouched");
    assert((await page.evaluate(() => window.__harness.forwards().length)) === 0, "the busy tunnel did not start");

    // Beta's workspace.
    await page.locator('[aria-label="Connected sessions"] [role="tab"]', { hasText: "beta" }).click();
    await waitFor(async () => (await page.locator('[data-explorer-pane="0"] input[aria-label="Path"]').inputValue()) === `${H}/.config`, "beta explorer root");
    await waitFor(async () => (await page.locator('[role="tab"][title="/home/testuser/.config/settings.ini"]').count()) === 1, "beta file open");

    // Idempotent: opening again reuses both sessions and adds no files or terminals.
    await page.getByTestId("profile-progress-close").click();
    await page.getByRole("button", { name: "Hosts" }).click();
    await page.locator('[data-testid="profile-row"] button').first().click();
    await waitFor(async () => (await page.getByTestId("profile-progress").getAttribute("data-status")) === "done", "second run finished", 30000);
    assert((await sessionCount()) === 2, "no new sessions");
    assert((await page.getByTestId("terminal-tab").count()) === 3, "no duplicate terminals");
    assert((await entry("alpha").innerText()).includes("already connected"), "alpha reported as already connected");
    await page.getByTestId("profile-progress-close").click();
    await page.locator('[aria-label="Connected sessions"] [role="tab"]', { hasText: "alpha" }).click();
    await waitFor(async () => (await page.locator('[role="tab"][title^="/home/testuser"]').count()) === 2, "still two files in alpha");
  },
};
