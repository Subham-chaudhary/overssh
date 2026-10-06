// docs/GUIDE.md §12 item 2 exception: a terminal opened with a `command`
// that exits non-zero stays open ("[exited with code N] — press any key to
// close") instead of auto-closing; any key then closes it.
//
// See 03-terminal-command-writes-with-cr.ts for why the history entry is
// produced by driving a real terminal capture instead of pre-seeding the
// "history" store (CommandPalette.svelte's `loadHistory()` at boot already
// consumes that store before a scenario gets a chance to seed it).
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

export const scenario: Scenario = {
  name: "command terminal exiting non-zero stays open until a key is pressed",
  async run({ page }) {
    await waitFor(
      async () => (await page.locator('[data-testid="host-row"]').count()) === 3,
      "3 host rows rendered",
    );

    await page.locator('[data-testid="host-row"][data-alias="alpha"]').dblclick();
    await waitFor(
      async () => (await page.evaluate(() => (window as any).__harness.sessions().length)) === 1,
      "connected to alpha",
    );

    await page.keyboard.press("Control+`");
    await waitFor(
      async () => (await page.locator('[data-testid="terminal-tab"]').count()) === 1,
      "a terminal auto-opened",
    );
    const firstTermId = await page.locator('[data-testid="terminal-tab"]').first().getAttribute("data-term-id");
    await page.waitForSelector(".xterm-helper-textarea", { state: "attached" });

    await page.keyboard.press("f");
    await page.evaluate(
      (id) => (window as any).__harness.emit("term://data", { termId: id, data: "false" }),
      firstTermId,
    );
    await page.keyboard.press("Enter");

    await page.getByRole("button", { name: "Commands" }).click();
    await waitFor(
      async () => (await page.locator('[data-testid="history-row"][data-cmd="false"]').count()) === 1,
      "captured command appears in the Commands panel",
    );
    await page.locator('[data-testid="history-row"][data-cmd="false"]').getByLabel("Run in terminal").click({
      force: true,
    });

    await waitFor(async () => (await page.locator('[data-testid="terminal-tab"]').count()) === 2, "command terminal opened");
    const tabs = page.locator('[data-testid="terminal-tab"]');
    const ids = await tabs.evaluateAll((els) => els.map((e) => e.getAttribute("data-term-id")));
    const cmdTermId = ids.find((id) => id !== firstTermId);
    assert(cmdTermId, `couldn't find the new command terminal's id among ${JSON.stringify(ids)}`);

    await page.evaluate((id) => (window as any).__harness.emit("term://exit", { termId: id, code: 1 }), cmdTermId);

    // Give the auto-close path a moment to (incorrectly) fire, then confirm
    // it didn't: both tabs must still be there.
    await page.waitForTimeout(200);
    assert(
      (await page.locator('[data-testid="terminal-tab"]').count()) === 2,
      "the command tab must stay open after a non-zero exit",
    );

    // openNew() focuses the terminal it creates, so a keypress should reach
    // its xterm instance and close it, leaving only the first terminal.
    await page.keyboard.press("a");
    await waitFor(
      async () => (await page.locator('[data-testid="terminal-tab"]').count()) === 1,
      "command tab closes after a keypress",
    );
    assert(
      (await page.locator('[data-testid="terminal-tab"]').first().getAttribute("data-term-id")) === firstTermId,
      "the remaining tab is the original terminal, not the command one",
    );
  },
};
