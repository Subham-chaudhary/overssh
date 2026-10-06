// §13.4.N: a legacy "history" store (bare HistoryEntry[] with pinned entries)
// is migrated on load: pinned entries become host-scoped snippets, nothing is
// lost, and the next save writes the v2 envelope.
import type { Scenario } from "../scenario";
import { waitFor } from "../scenario";

const LEGACY = [
  { cmd: "docker ps -a", host: "root@alpha.example.com", count: 3, lastUsed: 1_700_000_000_000, pinned: true },
  { cmd: "ls -la", host: "root@alpha.example.com", count: 5, lastUsed: 1_700_000_100_000, pinned: false },
];

export const scenario: Scenario = {
  name: "legacy pinned history entries migrate to snippets (no data loss)",
  async beforeLoad({ page }) {
    await page.addInitScript((seed) => {
      (window as any).__HARNESS_SEED_STORES__ = { history: seed };
    }, LEGACY);
  },
  async run({ page }) {
    await waitFor(
      async () => (await page.locator('[data-testid="host-row"]').count()) === 3,
      "3 host rows rendered",
    );

    // "All hosts" scope so the entries show regardless of the active session.
    await page.getByRole("button", { name: "Commands" }).click();
    await page.getByText("All hosts", { exact: true }).click();
    await waitFor(
      async () => (await page.locator('[data-testid="snippet-row"][data-cmd="docker ps -a"]').count()) === 1,
      "pinned entry shows up as a snippet",
    );
    await waitFor(
      async () => (await page.locator('[data-testid="history-row"][data-cmd="ls -la"]').count()) === 1,
      "unpinned entry stays in Recent",
    );

    // Persisted as the v2 envelope with both the entries and the snippet.
    await waitFor(
      async () =>
        page.evaluate(() => {
          const v = (window as any).__harness.getStore("history");
          return !!v && !Array.isArray(v) && v.version === 2 && v.snippets.length === 1 && v.entries.length === 2;
        }),
      "v2 envelope saved with entries + migrated snippet",
      4000,
    );
  },
};
