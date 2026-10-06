// docs/GUIDE.md §12.1: terminalStore.openNew(sessionId, { command }) must write
// `command + "\r"` to the PTY once the shell is "ready" (first term://data
// chunk, or the timeout fallback — the fake backend never pushes data on its
// own, so this exercises the fallback path). Driven through the real UI path
// that always opens a *new* terminal for a command: CommandHistory's "Run".
//
// Getting a HistoryEntry to run: `history` (lib/history.svelte.ts) is loaded
// once from the "history" store at app boot (CommandPalette.svelte mounts
// unconditionally and calls `loadHistory()` immediately) — seeding the store
// through the harness mock *after* that has already happened is a no-op, so
// instead this drives a real command through §11.4's capture path in an
// actual terminal: type a character to start tracking, have the fake backend
// "echo" the full line back (mimicking a real shell), then submit it.
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

interface InvokeCall {
  cmd: string;
  args: Record<string, unknown>;
}

export const scenario: Scenario = {
  name: "history Run opens a new terminal and writes the command + \\r",
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
    const termId = await page.locator('[data-testid="terminal-tab"]').first().getAttribute("data-term-id");
    assert(termId, "terminal tab has a data-term-id");
    await page.waitForSelector(".xterm-helper-textarea", { state: "attached" });

    await page.keyboard.press("e");
    await page.evaluate(
      (id) => (window as any).__harness.emit("term://data", { termId: id, data: "echo hi" }),
      termId,
    );
    await page.keyboard.press("Enter");

    await page.getByRole("button", { name: "Commands" }).click();
    await waitFor(
      async () => (await page.locator('[data-testid="history-row"][data-cmd="echo hi"]').count()) === 1,
      "captured command appears in the Commands panel",
    );

    // Spy on the IPC layer mockIPC installed, forwarding every call through
    // unchanged, so we can assert on what the frontend actually sent.
    await page.evaluate(() => {
      const w = window as unknown as { __invokeCalls: InvokeCall[] };
      w.__invokeCalls = [];
      const internals = (window as any).__TAURI_INTERNALS__;
      const raw = internals.invoke.bind(internals);
      internals.invoke = (cmd: string, args?: unknown, options?: unknown) => {
        w.__invokeCalls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
        return raw(cmd, args, options);
      };
    });

    await page
      .locator('[data-testid="history-row"][data-cmd="echo hi"]')
      .getByLabel("Run in terminal")
      .click({ force: true });

    await waitFor(
      async () => (await page.locator('[data-testid="terminal-tab"]').count()) === 2,
      "Run opened a brand-new terminal (didn't reuse the existing one)",
    );

    const newTitle = await page.locator('[data-testid="terminal-tab"]').nth(1).innerText();
    assert(
      newTitle.includes("echo hi"),
      `expected the new tab's title to be the command, got ${JSON.stringify(newTitle)}`,
    );

    await waitFor(
      async () =>
        page.evaluate(() => {
          const w = window as unknown as { __invokeCalls: InvokeCall[] };
          return w.__invokeCalls.some((c) => c.cmd === "term_write" && c.args.data === "echo hi\r");
        }),
      'term_write called with "echo hi\\r"',
      5000,
    );
  },
};
