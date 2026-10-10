// docs/GUIDE.md §15.3.Y: settings sync. Export writes the expected sections and
// no secrets; import shows a preview with conflicts, applies the chosen
// resolutions, and "Undo import" restores the backup.
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

const PROFILES = [
  // The extra secret-ish fields must never reach the export.
  { id: "h1", name: "prod", alias: null, hostname: "prod.example.com", user: "root", port: 22, identityFile: null, pinned: false, lastUsed: 10, password: "hunter2", passphrase: "pp-secret" },
  { id: "h2", name: "stage", alias: null, hostname: "stage.example.com", user: "deploy", port: 2222, identityFile: "~/.ssh/id_stage", pinned: true, lastUsed: 20 },
];
const HISTORY = {
  version: 2,
  entries: [{ cmd: "export API_TOKEN=abc-token-xyz", host: "root@prod.example.com", count: 2, lastUsed: 5, pinned: false }],
  snippets: [
    { id: "s1", name: "deploy", cmd: "make deploy", tags: [], scope: "all", created: 1, lastUsed: 0, useCount: 0, lastValues: { TOKEN: "snippet-secret-value" } },
  ],
};
const FORWARDS = [
  { id: "r1", host: "saved:h1", kind: "L", bindAddress: "", bindPort: 8080, targetHost: "localhost", targetPort: 80, label: "web", autoStart: false, tunnelOnly: true },
];

export const scenario: Scenario = {
  name: "settings sync: export has no secrets; import preview, conflict choices, apply and undo",
  async beforeLoad({ page }) {
    await page.addInitScript(
      ([profiles, history, forwards]) => {
        window.__HARNESS_SEED_STORES__ = {
          profiles,
          history,
          forwards,
          settings: { editor: { fontSize: 15 } },
        };
      },
      [PROFILES, HISTORY, FORWARDS] as const,
    );
  },
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="saved-host-row"]').count()) === 2, "2 saved hosts loaded");
    const store = (name: string) => page.evaluate((n) => window.__harness.getStore(n) as any, name);
    const writes = () => page.evaluate(() => window.__sync.writes());

    // ---- export -------------------------------------------------------------------------
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Sync", exact: true }).click();
    await page.getByTestId("sync-export-open").click();
    await waitFor(async () => (await page.getByTestId("sync-export-dialog").count()) === 1, "export dialog open");
    assert((await page.getByTestId("sync-export-history").getAttribute("aria-checked")) === "false", "history is off by default");
    assert((await page.getByTestId("sync-export-hosts").getAttribute("aria-checked")) === "true", "hosts on by default");
    await waitFor(async () => (await page.getByTestId("sync-export-count-hosts").textContent())?.trim() === "2", "host count shown");
    await page.getByTestId("sync-export-history").click();
    assert((await page.getByTestId("sync-history-warning").count()) === 1, "history shows a secrets warning");
    await page.getByTestId("sync-export-history").click();
    assert((await page.getByTestId("sync-history-warning").count()) === 0, "warning gone when unchecked");

    await page.getByTestId("sync-export-save").click();
    await waitFor(async () => (await writes()).length === 1, "export file written");
    const w = (await writes())[0];
    assert(/^overssh-settings-\d{4}-\d{2}-\d{2}\.json$/.test(w.suggestedName), `suggested name: ${w.suggestedName}`);
    const bundle = JSON.parse(w.text);
    assert(bundle.format === "overssh-settings" && bundle.version === 1, "format header");
    assert(typeof bundle.exportedAt === "string" && !Number.isNaN(Date.parse(bundle.exportedAt)), "exportedAt");
    const keys = Object.keys(bundle.sections).sort().join(",");
    assert(keys === "appearance,forwards,hosts,logs,prefs,settings,snippets", `sections: ${keys}`);
    for (const secret of ["hunter2", "pp-secret", "snippet-secret-value", "abc-token-xyz", "passphrase", "password"]) {
      assert(!w.text.includes(secret), `export leaks "${secret}"`);
    }
    assert(bundle.sections.hosts.length === 2, "two saved hosts exported");
    assert(bundle.sections.hosts.some((h: any) => h.identityFile === "~/.ssh/id_stage"), "identity file path kept (path only)");
    assert(bundle.sections.settings.editor.fontSize === 15, "settings exported");
    assert(bundle.sections.snippets[0].lastValues === undefined, "snippet values stripped");
    assert(bundle.sections.forwards[0].host === "saved:h1", "forward rule exported");
    await waitFor(async () => (await page.getByTestId("sync-export-dialog").count()) === 0, "export dialog closes");

    // The export is remembered in Settings > Sync.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Sync", exact: true }).click();
    await waitFor(async () => ((await page.getByTestId("sync-last-export").textContent()) ?? "").includes("Last export"), "last export info");
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.getByTestId("settings-sync").count()) === 0, "settings closed");

    // ---- import: bad files are rejected with a message ---------------------------------------
    const openImport = async () => {
      await page.keyboard.press("Control+Shift+P");
      await page.locator('[data-slot="command-item"]', { hasText: "Preferences: Import Settings" }).click();
      await waitFor(async () => (await page.getByTestId("sync-import-dialog").count()) === 1, "import dialog open");
    };
    await openImport();
    await page.evaluate(() => window.__sync.setNextRead({ path: "C:\\x\\bad.json", text: JSON.stringify({ format: "other", version: 1, sections: {} }) }));
    await page.getByTestId("sync-import-file").click();
    await waitFor(async () => ((await page.getByTestId("sync-import-error").textContent()) ?? "").includes("not an OverSSH settings file"), "wrong format rejected");
    await page.getByTestId("sync-import-text").fill(JSON.stringify({ format: "overssh-settings", version: 99, sections: { settings: { editor: { fontSize: 9 } } } }));
    await page.getByTestId("sync-import-preview").click();
    await waitFor(async () => ((await page.getByTestId("sync-import-error").textContent()) ?? "").includes("newer"), "future version rejected");

    // ---- import: preview with conflicts -----------------------------------------------------------
    const incoming = {
      format: "overssh-settings",
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      app: "9.9.9",
      futureField: { ignored: true },
      sections: {
        settings: { editor: { fontSize: 20, notASetting: 1 } },
        appearance: { theme: "nord", appearance: { density: "compact" } },
        hosts: [
          { id: "h1", name: "prod", alias: null, hostname: "prod.example.com", user: "root", port: 2200, identityFile: null, pinned: false, lastUsed: 99 },
          { id: "h3", name: "new-box", alias: null, hostname: "new.example.com", user: "me", port: 22, identityFile: null, pinned: false, lastUsed: 0 },
        ],
        snippets: [
          { id: "sX", name: "deploy", cmd: "make deploy-all", tags: [], scope: "all", created: 1, lastUsed: 0, useCount: 0 },
          { id: "sY", name: "logs", cmd: "journalctl -f", tags: [], scope: "all", created: 1, lastUsed: 0, useCount: 0 },
        ],
        forwards: [
          { id: "r2", host: "saved:h3", kind: "L", bindAddress: "", bindPort: 5432, targetHost: "db", targetPort: 5432, label: "db", autoStart: false, tunnelOnly: true },
        ],
        history: [{ cmd: "ls -la", host: "me@new.example.com", count: 1, lastUsed: 1, pinned: false }],
        unknownSection: [1, 2, 3],
      },
    };
    await page.evaluate((t) => window.__sync.setNextRead({ path: "C:\\x\\in.json", text: t }), JSON.stringify(incoming));
    await page.getByTestId("sync-import-file").click();
    await waitFor(async () => (await page.getByTestId("sync-import-sections").count()) === 1, "preview shown");
    assert((await page.getByTestId("sync-import-warnings").textContent())?.includes("unknownSection"), "unknown section reported, not applied");
    const summary = (id: string) => page.getByTestId(`sync-import-summary-${id}`).textContent().then((t) => (t ?? "").replace(/\s+/g, " ").trim());
    assert((await summary("settings")).startsWith("1 changed value"), `settings summary: ${await summary("settings")}`);
    assert((await summary("hosts")).includes("1 new") && (await summary("hosts")).includes("1 conflict"), `hosts summary: ${await summary("hosts")}`);
    assert((await summary("snippets")).includes("1 new") && (await summary("snippets")).includes("1 conflict"), `snippets summary: ${await summary("snippets")}`);
    assert((await page.getByTestId("sync-import-check-history").getAttribute("aria-checked")) === "false", "history unchecked by default");
    assert((await page.getByTestId("sync-conflict").count()) === 2, "two conflicts listed");

    // Overwrite the host, keep both snippets.
    await page.locator('[data-testid="sync-conflict"][data-key="hosts:h1"]').getByTestId("sync-conflict-overwrite").click();
    await page.locator('[data-testid="sync-conflict"][data-key="snippets:sX"]').getByTestId("sync-conflict-keepBoth").click();
    await page.getByTestId("sync-import-apply").click();
    await waitFor(async () => (await page.getByTestId("sync-import-result").count()) === 1, "import applied");

    await waitFor(async () => {
      const p = await store("profiles");
      return Array.isArray(p) && p.length === 3;
    }, "hosts persisted (2 + 1 new)");
    const profiles = await store("profiles");
    assert(profiles.find((p: any) => p.id === "h1").port === 2200, "conflicting host overwritten");
    assert(profiles.some((p: any) => p.id === "h3"), "new host added");
    await waitFor(async () => ((await store("history"))?.snippets?.length ?? 0) === 3, "snippets persisted (keep both + new)");
    const hist = await store("history");
    assert(hist.entries.length === 1, "history section was not selected: entries untouched");
    assert(hist.snippets.filter((s: any) => s.name?.startsWith("deploy")).length === 2, "both deploy snippets kept");
    assert(hist.snippets.some((s: any) => s.name === "deploy (imported)"), "copy is marked");
    await waitFor(async () => (await store("forwards"))?.length === 2, "forward rule persisted");
    await waitFor(async () => (await store("settings"))?.editor?.fontSize === 20 && (await store("settings"))?.theme === "nord", "settings persisted");
    assert((await page.evaluate(() => document.documentElement.dataset.theme)) === "nord", "theme applied live");
    assert(!("notASetting" in ((await store("settings")).editor ?? {})), "unknown setting key ignored");

    // ---- undo -------------------------------------------------------------------------------------
    await page.getByTestId("sync-import-undo").click();
    await waitFor(async () => (await page.getByTestId("sync-import-dialog").count()) === 0, "dialog closes after undo");
    await waitFor(async () => {
      const p = await store("profiles");
      return Array.isArray(p) && p.length === 2 && p.find((x: any) => x.id === "h1")?.port === 22;
    }, "hosts restored");
    await waitFor(async () => ((await store("history"))?.snippets?.length ?? 0) === 1, "snippets restored");
    await waitFor(async () => (await store("forwards"))?.length === 1, "forwards restored");
    await waitFor(async () => (await store("settings"))?.editor?.fontSize === 15 && (await store("settings"))?.theme === "one-dark", "settings restored");
    assert((await page.evaluate(() => document.documentElement.dataset.theme)) === "one-dark", "theme restored live");
    await waitFor(async () => (await page.locator('[data-testid="saved-host-row"]').count()) === 2, "host list shows the restored hosts");
  },
};
