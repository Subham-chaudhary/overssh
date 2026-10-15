import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Two tabs in Compare mode whose server copies have the same mtime and length used
// to share one DiffView instance (the {#key} ignored the tab), so switching tabs
// kept the first file's diff on screen and "Save merged" wrote it into the second file.
export const scenario: Scenario = {
  name: "Compare views of two tabs with equal mtime/length never mix their contents",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    const a = "/home/testuser/readme.txt";
    const b = "/home/testuser/notes.md";
    await page.evaluate(([pa, pb]) => {
      window.__harness.touchRemote(pa, "AAAA\n");
      window.__harness.touchRemote(pb, "BBBB\n");
    }, [a, b]);

    const tab = (p: string) => page.locator(`[role="tablist"][aria-label="Open files"] [role="tab"][title="${p}"]`);
    const view = page.locator('[data-testid="diff-view"]');
    for (const p of [a, b]) {
      await page.locator(`[data-path="${p}"]`).click();
      await waitFor(async () => (await tab(p).count()) === 1, `tab ${p}`);
      await waitFor(async () => (await page.locator(".monaco-editor .view-lines").getByText(p === a ? "AAAA" : "BBBB").count()) > 0, `loaded ${p}`, 15000);
      await tab(p).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Compare with Saved on Server" }).click();
      await waitFor(async () => (await view.locator(".monaco-diff-editor").count()) === 1, `diff for ${p}`, 15000);
    }

    // Back to the first tab: its diff must show its own text.
    await tab(a).click();
    await waitFor(async () => (await view.locator(".monaco-diff-editor").count()) === 1, "diff for a again", 15000);
    await waitFor(async () => (await view.getByText("AAAA").count()) > 0, "first file's diff shows its own text");
    const n = (await page.evaluate(() => window.__harness.writes())).length;
    await view.locator('[data-testid="diff-save-merged"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.writes())).length > n, "save merged wrote");
    const w = (await page.evaluate(() => window.__harness.writes())).pop()!;
    assert(w.path === a && w.content === "AAAA\n", `wrote the first file's own text: ${JSON.stringify(w)}`);
  },
};
