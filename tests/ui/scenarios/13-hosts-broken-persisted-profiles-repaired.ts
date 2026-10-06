import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Regression test for the real user bug (docs/GUIDE.md §12 hosts redesign):
// %APPDATA%\dev.overssh.app\profiles.json had 6 entries — two sharing the
// same `id` (left over from the old re-push-on-mount bug) plus three
// connection-identical entries (repeated connect-upserts / "Save as new
// host" clicks). HostList's keyed `{#each ... (p.id)}` threw Svelte's
// `each_key_duplicate` on mount, blanking the whole panel. Seeds the mock
// "profiles" store with exactly that broken shape *before* the app boots
// (via `beforeLoad` — see mockBackend.ts's `__HARNESS_SEED_STORES__`) and
// asserts the panel still renders, survives view switches, and that
// `initHosts()`'s repair pass rewrote the persisted store without duplicates.
const BROKEN_PROFILES = [
  // Two entries sharing the same id (the old duplicate-push bug).
  {
    id: "dup-id",
    name: "staging",
    alias: null,
    hostname: "staging.example.com",
    user: "root",
    port: 22,
    identityFile: null,
    pinned: false,
    lastUsed: 1000,
  },
  {
    id: "dup-id",
    name: "staging",
    alias: null,
    hostname: "staging.example.com",
    user: "root",
    port: 22,
    identityFile: null,
    pinned: false,
    lastUsed: 2000,
  },
  // Three connection-identical entries (repeated connect-upserts / "Save as
  // new host" clicks) — one of them pinned, which must win the de-dup.
  {
    id: "frappe-1",
    name: "frappe-test@chalkdoor-stage-test",
    alias: null,
    hostname: "chalkdoor-stage-test",
    user: "frappe-test",
    port: 22,
    identityFile: null,
    pinned: false,
    lastUsed: 3000,
  },
  {
    id: "frappe-2",
    name: "frappe-test@chalkdoor-stage-test",
    alias: null,
    hostname: "chalkdoor-stage-test",
    user: "frappe-test",
    port: 22,
    identityFile: null,
    pinned: true,
    lastUsed: 2500,
  },
  {
    id: "frappe-3",
    name: "frappe-test@chalkdoor-stage-test",
    alias: null,
    hostname: "chalkdoor-stage-test",
    user: "frappe-test",
    port: 22,
    identityFile: null,
    pinned: false,
    lastUsed: 4000,
  },
  // One clean, unrelated saved host.
  {
    id: "prod-1",
    name: "prod",
    alias: null,
    hostname: "prod.example.com",
    user: "ubuntu",
    port: 22,
    identityFile: null,
    pinned: false,
    lastUsed: 5000,
  },
];

export const scenario: Scenario = {
  name: "broken persisted profiles (dup ids + connection-identical) still render and get repaired",
  async beforeLoad({ page }) {
    await page.addInitScript((seed) => {
      (window as unknown as { __HARNESS_SEED_STORES__?: Record<string, unknown> }).__HARNESS_SEED_STORES__ = {
        profiles: seed,
      };
    }, BROKEN_PROFILES);
  },
  async run({ page }) {
    // The panel must render (not go blank on the duplicate-key crash) and
    // the ssh-config hosts must be there.
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "3 config hosts rendered");

    // Repaired down to 3 saved hosts: the id-dup pair collapses to 1, the
    // three connection-identical entries collapse to 1 (the pinned one), plus
    // the one clean "prod" entry.
    await waitFor(
      async () => (await page.locator('[data-testid="saved-host-row"]').count()) === 3,
      "3 saved hosts after de-dup (id-dup pair + connection-identical trio collapsed)",
    );

    // Switching Explorer -> Commands -> Hosts must not blank the panel again.
    await page.getByRole("button", { name: "Explorer" }).click();
    await page.getByRole("button", { name: "Commands" }).click();
    await page.getByRole("button", { name: "Hosts" }).click();
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "config hosts still 3");
    assert(
      (await page.locator('[data-testid="saved-host-row"]').count()) === 3,
      "saved hosts still 3 after switching views",
    );

    // The persisted store itself must have been rewritten without duplicates.
    await waitFor(async () => {
      const stored = (await page.evaluate(() => window.__harness.getStore("profiles"))) as
        | Array<{ id: string; name: string; hostname: string; user: string; port: number; identityFile: string | null }>
        | null;
      if (!stored || stored.length !== 3) return false;
      const ids = new Set(stored.map((p) => p.id));
      if (ids.size !== stored.length) return false;
      const sigs = new Set(
        stored.map((p) => JSON.stringify([p.name, p.hostname, p.user, p.port, p.identityFile])),
      );
      return sigs.size === stored.length;
    }, "persisted 'profiles' store rewritten with 3 unique, non-duplicate entries", 5000);

    const stored = (await page.evaluate(() => window.__harness.getStore("profiles"))) as Array<{
      id: string;
      pinned: boolean;
    }>;
    assert(
      stored.some((p) => p.id === "frappe-2" && p.pinned),
      "the pinned connection-identical entry (frappe-2) is the one that survived de-dup",
    );
  },
};
