// §13.4.N: create a snippet with `{{pod:web-0}}`, run it -> variable form with
// the default prefilled and a live preview; Run writes the substituted command
// + "\r" to the active terminal. Also covers: last-used value remembered,
// choice -> select, same variable twice asked once, and the palette picker.
import type { Page } from "playwright-core";
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

interface InvokeCall {
  cmd: string;
  args: Record<string, unknown>;
}

async function termWrites(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __invokeCalls: InvokeCall[] }).__invokeCalls
      .filter((c) => c.cmd === "term_write")
      .map((c) => String(c.args.data)),
  );
}

async function createSnippet(page: Page, cmd: string): Promise<void> {
  await page.locator('[data-testid="snippet-new"]').click();
  await page.locator('[data-testid="snippet-cmd"]').fill(cmd);
  await page.locator('[data-testid="snippet-save"]').click();
  await waitFor(
    async () => (await page.locator('[data-testid="snippet-edit-dialog"]').count()) === 0,
    "edit dialog closed",
  );
}

export const scenario: Scenario = {
  name: "snippet with {{variables}}: form, preview, run writes substituted command + \r",
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

    await page.getByRole("button", { name: "Commands" }).click();
    await createSnippet(page, "kubectl logs {{pod:web-0}} -n {{ns|default|prod}} # {{pod}}");
    await waitFor(
      async () => (await page.locator('[data-testid="snippet-row"]').count()) === 1,
      "snippet row listed",
    );

    // Run -> form; same variable (pod) used twice is asked once.
    await page.locator('[data-testid="snippet-row"]').locator("button").first().click();
    await page.locator('[data-testid="snippet-run-dialog"]').waitFor();
    assert((await page.locator('[data-testid="snippet-field"]').count()) === 2, "two fields (pod, ns)");
    const pod = page.locator('[data-testid="snippet-field"][data-var="pod"]');
    assert((await pod.inputValue()) === "web-0", "default prefilled");
    const preview = page.locator('[data-testid="snippet-preview"]');
    assert((await preview.innerText()) === "kubectl logs web-0 -n default # web-0", "initial preview");

    await pod.fill("api-1");
    await page.locator('[data-testid="snippet-field"][data-var="ns"]').selectOption("prod");
    await waitFor(
      async () => (await preview.innerText()) === "kubectl logs api-1 -n prod # api-1",
      "preview updates live",
    );

    await page.locator('[data-testid="snippet-run"]').click();
    await waitFor(
      async () => (await termWrites(page)).includes("kubectl logs api-1 -n prod # api-1\r"),
      "term_write with substituted command + \r",
      5000,
    );
    await waitFor(
      async () => (await page.locator('[data-testid="snippet-run-dialog"]').count()) === 0,
      "form closed after run",
    );

    // Last-used values are remembered.
    await page.locator('[data-testid="snippet-row"]').locator("button").first().click();
    await page.locator('[data-testid="snippet-run-dialog"]').waitFor();
    assert(
      (await page.locator('[data-testid="snippet-field"][data-var="pod"]').inputValue()) === "api-1",
      "last-used value remembered",
    );
    // Insert = no Enter.
    await page.locator('[data-testid="snippet-insert"]').click();
    await waitFor(
      async () => (await termWrites(page)).includes("kubectl logs api-1 -n prod # api-1"),
      "insert writes without \r",
    );
    await waitFor(
      async () => (await page.locator('[data-testid="snippet-run-dialog"]').count()) === 0,
      "form closed after insert",
    );

    // No variables -> runs immediately, no form.
    await createSnippet(page, "uptime");
    await page.locator('[data-testid="snippet-row"][data-cmd="uptime"] button').first().click();
    await waitFor(async () => (await termWrites(page)).includes("uptime\r"), "uptime ran immediately");
    assert((await page.locator('[data-testid="snippet-run-dialog"]').count()) === 0, "no form for plain snippet");

    // Palette quick picker.
    await page.keyboard.press("Control+Shift+P");
    await page.locator('[data-slot="command-item"]', { hasText: "Snippets: Run Snippet" }).click();
    await waitFor(
      async () => (await page.locator('[data-testid="snippet-picker-item"]').count()) === 2,
      "picker lists both snippets",
    );
    await page.locator('[data-testid="snippet-picker-item"]', { hasText: "kubectl" }).click();
    await page.locator('[data-testid="snippet-run-dialog"]').waitFor();
  },
};
