// UI test runner (docs/GUIDE.md §12, Phase 4 harness): starts Vite
// programmatically on a free port, drives the real app in headless Microsoft
// Edge (via playwright-core — no browser download) with a fake backend
// (mockBackend.ts, loaded through tests/ui/harness.html), runs every scenario
// in tests/ui/scenarios/*.ts, and prints a PASS/FAIL report.
//
//   npm run test:ui
//
// Add a scenario by dropping a new tests/ui/scenarios/<name>.ts file — see
// scenario.ts for the shape. No registration step needed.

import path from "node:path";
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser } from "playwright-core";
import type { Scenario } from "./scenario";

const ROOT = path.resolve(import.meta.dirname, "../..");
const FILTERS = process.argv.slice(2);
const SCENARIOS_DIR = path.resolve(import.meta.dirname, "scenarios");

interface Result {
  name: string;
  ok: boolean;
  error?: string;
  pageErrors: string[];
  consoleErrors: string[];
}

async function loadScenarios(): Promise<Scenario[]> {
  const files = readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith(".ts"))
    // `npm run test:ui -- 34 28-rename`: only files whose name contains one of the args.
    .filter((f) => FILTERS.length === 0 || FILTERS.some((x) => f.includes(x)))
    .sort();
  if (files.length === 0) {
    throw new Error(`No scenario files found in ${SCENARIOS_DIR}`);
  }
  const scenarios: Scenario[] = [];
  for (const file of files) {
    const mod: Record<string, unknown> = await import(pathToFileURL(path.join(SCENARIOS_DIR, file)).href);
    const s = (mod.scenario ?? mod.default) as Scenario | undefined;
    if (!s || typeof s.run !== "function") {
      throw new Error(`${file}: expected an exported \`scenario\` (or default export) with a run()`);
    }
    scenarios.push(s);
  }
  return scenarios;
}

async function startServer(): Promise<{ server: ViteDevServer; baseUrl: string }> {
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, "vite.config.ts"),
    server: { port: 0, strictPort: false, host: "127.0.0.1" },
    logLevel: "warn",
  });
  await server.listen();
  const info = server.httpServer?.address();
  const port = info && typeof info === "object" ? info.port : null;
  if (!port) throw new Error("Vite dev server did not report a port");
  return { server, baseUrl: `http://127.0.0.1:${port}/tests/ui/harness.html` };
}

async function launchEdge(): Promise<Browser> {
  return chromium.launch({ channel: "msedge", headless: true });
}

// A single scenario must not be able to hang the whole suite (e.g. a locator
// that never becomes actionable, waiting past its own internal timeouts for
// some other reason). Anything not done in this long is a bug in the
// scenario itself — fail it and move on rather than block every scenario
// after it.
const SCENARIO_TIMEOUT_MS = 75_000;

async function runScenario(browser: Browser, baseUrl: string, scenario: Scenario): Promise<Result> {
  // A fresh incognito context per scenario, not just a fresh page on a shared
  // one — besides isolating storage, this keeps a heavy scenario (Monaco's
  // one-time parse/worker cost) from leaving memory pressure that makes the
  // *next* scenario's cold start slower and flakier.
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.stack ?? String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  let ok = true;
  let error: string | undefined;
  try {
    if (scenario.beforeLoad) await scenario.beforeLoad({ page });
    // Generous: the dev server this points at is a *live* Vite instance
    // watching the whole repo, and Phase 4 runs with several other agents
    // editing files concurrently — a dependency-graph change (new package,
    // new import of a not-yet-pre-bundled module) can trigger Vite's
    // "re-optimizing dependencies" full reload, which stalls in-flight
    // requests for several seconds. That's an artifact of testing against a
    // live dev server during concurrent development, not app or harness
    // brokenness, so scenarios absorb it with headroom rather than flake.
    await page.goto(baseUrl, { waitUntil: "load", timeout: 60_000 });
    await page.waitForSelector("#app", { state: "attached", timeout: 15_000 });
    await Promise.race([
      scenario.run({ page, baseUrl }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`scenario exceeded the ${SCENARIO_TIMEOUT_MS}ms suite-wide watchdog`)),
          SCENARIO_TIMEOUT_MS,
        ),
      ),
    ]);
    if (pageErrors.length > 0) {
      ok = false;
      error = `scenario reported success but ${pageErrors.length} uncaught page error(s) occurred`;
    }
  } catch (err) {
    ok = false;
    error = err instanceof Error ? (err.stack ?? err.message) : String(err);
  } finally {
    await context.close().catch(() => {});
  }

  return { name: scenario.name, ok, error, pageErrors, consoleErrors };
}

function printReport(results: Result[]): number {
  console.log("\n--- OverSSH UI test results ---\n");
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} — ${r.name}`);
    if (!r.ok) {
      failed++;
      if (r.error) console.log(`    ${r.error.split("\n").join("\n    ")}`);
      for (const pe of r.pageErrors) {
        console.log(`    [page error] ${pe.split("\n").join("\n    ")}`);
      }
    }
    if (r.consoleErrors.length > 0) {
      for (const ce of r.consoleErrors) console.log(`    [console.error] ${ce}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} passed\n`);
  return failed;
}

async function main(): Promise<void> {
  const scenarios = await loadScenarios();
  const { server, baseUrl } = await startServer();
  const browser = await launchEdge();

  // Vite's dev server transforms/bundles modules lazily on first request —
  // the app's module graph (Svelte components, bits-ui, lucide icons, …) is
  // large enough that a cold first load can take several seconds, which
  // would make the *first* scenario spuriously slow/flaky relative to the
  // rest. Warm the transform cache with one throwaway load before timing
  // any real scenario.
  {
    const warmupPage = await browser.newPage();
    await warmupPage.goto(baseUrl, { waitUntil: "load", timeout: 60_000 }).catch(() => {});
    await warmupPage.waitForSelector('[data-testid="host-row"], [data-testid="hosts-empty"]', {
      timeout: 30_000,
    }).catch(() => {});
    await warmupPage.close();
  }

  const results: Result[] = [];
  try {
    for (const scenario of scenarios) {
      process.stdout.write(`  running: ${scenario.name} ... `);
      const result = await runScenario(browser, baseUrl, scenario);
      console.log(result.ok ? "PASS" : "FAIL");
      results.push(result);
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }

  const failed = printReport(results);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
