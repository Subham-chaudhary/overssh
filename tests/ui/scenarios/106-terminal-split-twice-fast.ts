import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §15.3.S: two split requests before the first new terminal is open
// (key repeat, a double click) must not leave a pane stuck at "Starting terminal..."
// or move a terminal out of its pane.
export const scenario: Scenario = {
  name: "Detached terminal window: two quick splits leave no empty pane",
  async run({ page, baseUrl }) {
    await page.goto(`${baseUrl}?window=terminals`, { waitUntil: "load" });
    await page.waitForSelector('[data-testid="terminal-window"]', { timeout: 20_000 });
    await waitFor(
      async () => (await page.evaluate(() => window.__harness.termwinEvents().some((e) => e.name === "ready"))) === true,
      "window announced itself",
    );
    await page.evaluate(() =>
      window.__harness.emit("termwin://init", {
        tabs: [
          { id: "t-1", sessionId: "s1", title: "One", exited: false, exitCode: null, openedWithCommand: false, key: "t-1", recording: false },
        ],
        activeId: "t-1",
        mru: [],
        closedStack: [],
        ctx: {
          sessions: [{ id: "s1", label: "alpha", user: "testuser", hostname: "alpha.example.com" }],
          activeSessionId: "s1",
          cwds: { s1: "/home/testuser" },
          reconnecting: [],
        },
        settings: {},
      }),
    );
    const tabs = page.locator('[data-testid="terminal-tab"]');
    const panes = page.locator('[data-testid="terminal-pane"]');
    await waitFor(async () => (await tabs.count()) === 1, "tab adopted");

    // Two Ctrl+\ in the same task: the second arrives while the first terminal is opening.
    await page.evaluate(() => {
      for (let i = 0; i < 2; i++) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", code: "Backslash", ctrlKey: true, bubbles: true }));
      }
    });
    await page.waitForTimeout(800);
    const n = await tabs.count();
    const paneTerms = await panes.evaluateAll((els) => els.map((e) => e.getAttribute("data-term-id")));
    assert(paneTerms.every((id) => !!id), `every pane shows a terminal, got ${JSON.stringify(paneTerms)}`);
    assert(paneTerms.length === n, `one pane per terminal: ${n} terminals, panes ${JSON.stringify(paneTerms)}`);
    assert(paneTerms.includes("t-1"), "the first terminal kept its pane");
  },
};
