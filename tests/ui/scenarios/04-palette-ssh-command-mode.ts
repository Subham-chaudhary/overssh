import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

export const scenario: Scenario = {
  name: "command palette `!` prefix switches to run-on-host mode and back",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");

    // No active session yet: `!` mode should say so.
    await page.keyboard.press("Control+Shift+P");
    const input = page.locator('[data-slot="command-input"]');
    await waitFor(async () => (await input.count()) === 1, "palette open");
    await input.fill("!ls");
    await waitFor(
      async () => (await page.locator('[data-slot="command-empty"]').innerText()) === "Connect to a host first",
      "no active session -> 'Connect to a host first'",
    );

    // Deleting the `!` returns to normal mode.
    await input.fill("ls");
    await waitFor(
      async () => (await input.getAttribute("placeholder")) === "Type a command…",
      "back to the normal placeholder after deleting the !",
    );
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.locator('[data-slot="command-input"]').count()) === 0, "palette closed");

    // Connect, then `!` mode shows "Run on <host>…" and lists the literal
    // typed command as a runnable item.
    await page.getByRole("button", { name: "Connect alpha" }).click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    await page.keyboard.press("Control+Shift+P");
    await waitFor(async () => (await input.count()) === 1, "palette open again");
    await input.fill("!echo hi");
    await waitFor(
      async () => /^Run on .+…/.test((await input.getAttribute("placeholder")) ?? ""),
      "placeholder switches to 'Run on <host>…'",
    );
    assert(
      (await page.locator('[data-slot="command-item"]', { hasText: "echo hi" }).count()) > 0,
      "the literal typed command is listed as a runnable item",
    );

    // Running it opens a *new* terminal (never writes into an existing one).
    await page.locator('[data-slot="command-item"]', { hasText: "echo hi" }).click();
    await waitFor(async () => (await page.locator('[data-testid="terminal-tab"]').count()) === 1, "a new terminal opened");
  },
};
