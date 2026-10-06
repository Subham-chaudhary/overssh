import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §13.4.P: paste an ssh command into the Ports view -> rules;
// start a rule -> tunnel-only background session (no workspace) + running dot;
// stopping the last rule closes the tunnel session again.
export const scenario: Scenario = {
  name: "Ports: paste ssh command adds rules, start runs them on a background tunnel session",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");

    await page.getByRole("button", { name: "Ports" }).click();
    await waitFor(async () => (await page.locator('[data-testid="ports-view"]').count()) === 1, "ports view");
    assert((await page.locator('[data-testid="ports-empty"]').count()) === 1, "empty state first");

    await page.locator('[data-testid="ports-paste"]').click();
    const input = page.locator('[data-testid="paste-input"]');
    await waitFor(async () => (await input.count()) === 1, "paste box visible");
    await input.fill("ssh -fN -L 6443:127.0.0.1:6443 -R 9000:localhost:3000 -D 1080 gamma");
    await waitFor(async () => (await page.locator('[data-testid="paste-preview"] li').count()) >= 3, "preview lists forwards");
    await page.locator('[data-testid="paste-add"]').click();

    await waitFor(async () => (await page.locator('[data-testid="rule-row"]').count()) === 3, "three rules added");
    assert((await page.locator('[data-testid="ports-group"]').count()) === 1, "grouped under one host");

    await waitFor(async () => {
      const stored = (await page.evaluate(() => window.__harness.getStore("forwards"))) as
        | Array<{ kind: string; tunnelOnly: boolean; host: string }>
        | null;
      return !!stored && stored.length === 3 && stored.every((r) => r.tunnelOnly && r.host === "config:gamma");
    }, "rules persisted as tunnel-only on gamma", 3000);

    // Start the -L rule.
    const lRow = page.locator('[data-testid="rule-row"]').filter({ hasText: "6443" }).first();
    await lRow.locator('[data-testid="rule-toggle"]').click();
    await waitFor(async () => (await lRow.getAttribute("data-status")) === "running", "-L rule running");
    assert((await page.evaluate(() => window.__harness.sessions().length)) === 1, "one tunnel session opened");
    assert((await page.locator('[data-testid="ports-view"]').count()) === 1, "no workspace switch (-N)");
    assert((await page.evaluate(() => window.__harness.forwards().length)) === 1, "one forward in backend");

    // Start the -R rule on the same session (no second connect).
    const rRow = page.locator('[data-testid="rule-row"]').filter({ hasText: "9000" }).first();
    await rRow.locator('[data-testid="rule-toggle"]').click();
    await waitFor(async () => (await rRow.getAttribute("data-status")) === "running", "-R rule running");
    assert((await page.evaluate(() => window.__harness.sessions().length)) === 1, "tunnel session shared");

    // Stop both: the tunnel session is released with the last one.
    await lRow.locator('[data-testid="rule-toggle"]').click();
    await waitFor(async () => (await lRow.getAttribute("data-status")) === "stopped", "-L stopped");
    assert((await page.evaluate(() => window.__harness.sessions().length)) === 1, "session kept while -R runs");
    await rRow.locator('[data-testid="rule-toggle"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 0, "tunnel session closed");

    // Port in use -> error status with the backend message.
    await page.locator('[data-testid="ports-add"]').click();
    await page.locator('[data-testid="rule-bind-port"]').fill("1");
    await page.locator('[data-testid="rule-target-port"]').fill("80");
    await page.locator('[data-testid="rule-save"]').click();
    const bad = page.locator('[data-testid="rule-row"]').filter({ hasText: "-> 127.0.0.1:80" }).first();
    await waitFor(async () => (await bad.count()) === 1, "form rule added");
    await bad.locator('[data-testid="rule-toggle"]').click();
    await waitFor(async () => (await bad.getAttribute("data-status")) === "error", "error status");
    assert(((await bad.locator('[data-testid="rule-error"]').textContent()) ?? "").includes("already in use"), "clear error text");
  },
};
