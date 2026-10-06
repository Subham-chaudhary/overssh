// docs/GUIDE.md §12 item 2: a terminal closes itself (tab removed, xterm
// disposed) when its process exits, and hides the terminal panel once none
// are left. Drives two plain (no-`command`) terminals via the panel's own
// "New terminal" button, then fires term://exit through the harness mock.
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

export const scenario: Scenario = {
  name: "terminal exit auto-closes its tab; the last one hides the panel",
  async run({ page }) {
    await waitFor(
      async () => (await page.locator('[data-testid="host-row"]').count()) === 3,
      "3 host rows rendered",
    );

    await page.locator('[data-testid="host-row"][data-alias="alpha"]').dblclick();
    await waitFor(
      async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1,
      "connected to alpha",
    );

    // Ctrl+` (App.svelte's global toggle) shows the panel; TerminalPanel
    // auto-opens a first terminal the moment it's shown with none open.
    await page.keyboard.press("Control+`");
    await waitFor(
      async () => (await page.locator('[data-testid="terminal-tab"]').count()) === 1,
      "first terminal auto-opened",
    );

    await page.getByRole("button", { name: "New terminal" }).click();
    await waitFor(
      async () => (await page.locator('[data-testid="terminal-tab"]').count()) === 2,
      "second terminal opened",
    );
    assert(
      await page.getByTestId("terminal-panel-label").isVisible(),
      "panel visible with two terminals open",
    );

    const ids = await page.locator('[data-testid="terminal-tab"]').evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-term-id")),
    );
    assert(ids.length === 2 && ids[0] && ids[1], `expected 2 term ids, got ${JSON.stringify(ids)}`);
    const [firstId, secondId] = ids as [string, string];

    // Exiting the non-last terminal removes just that tab and leaves the
    // panel showing.
    await page.evaluate((id) => window.__harness.emit("term://exit", { termId: id, code: 0 }), firstId);
    await waitFor(
      async () => (await page.locator('[data-testid="terminal-tab"]').count()) === 1,
      "one tab left after the first exit",
    );
    assert(
      await page.getByTestId("terminal-panel-label").isVisible(),
      "panel still visible with one terminal left",
    );
    assert(
      (await page.locator('[data-testid="terminal-tab"]').first().getAttribute("data-term-id")) === secondId,
      "the remaining tab is the one that didn't exit",
    );

    // Exiting the last terminal removes it and hides the whole panel.
    await page.evaluate((id) => window.__harness.emit("term://exit", { termId: id, code: 0 }), secondId);
    await waitFor(
      async () => (await page.locator('[data-testid="terminal-tab"]').count()) === 0,
      "no tabs left after the last exit",
    );
    await waitFor(
      async () => !(await page.getByTestId("terminal-panel-label").isVisible()),
      "panel hidden once the last terminal exits",
    );
  },
};
