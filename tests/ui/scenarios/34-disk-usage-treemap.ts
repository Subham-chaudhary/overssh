import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";
import { squarify } from "../../../src/lib/treemap";

// Dashboard > Disk usage (docs/GUIDE.md §13.4.C): scan renders a treemap + list,
// click drills down (lazy du on a dir whose children are unknown), breadcrumb goes
// back, permission-denied count shows, delete asks for confirmation, open-in-explorer
// leaves the dashboard. Also unit-checks the squarify layout.
export const scenario: Scenario = {
  name: "disk usage: treemap renders, drill down + breadcrumb, delete, open in explorer",
  async run({ page }) {
    // --- squarify: tiles exactly fill the box, area proportional to value
    const box = { x: 0, y: 0, w: 600, h: 400 };
    const items = [6, 6, 4, 3, 2, 2, 1].map((v, i) => ({ id: `i${i}`, value: v }));
    const rects = squarify(items, box);
    assert(rects.length === 7, "all items laid out");
    const area = rects.reduce((s, r) => s + r.w * r.h, 0);
    assert(Math.abs(area - 600 * 400) < 1e-6, `areas fill the box (${area})`);
    const total = 24;
    for (const r of rects) {
      assert(Math.abs((r.w * r.h) / (600 * 400) - r.value / total) < 1e-9, `area proportional for ${r.id}`);
      assert(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 600 + 1e-9 && r.y + r.h <= 400 + 1e-9, `${r.id} inside box`);
    }
    assert(squarify([{ id: "z", value: 0 }], box).length === 0, "zero-size items dropped");

    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "1 session");
    await page.getByRole("button", { name: "Dashboard" }).click();
    // The overview has no process table since the htop tab (§14.4.H): wait for the tabs instead.
    await waitFor(async () => (await page.locator('[data-testid="monitor-tab-disk"]').count()) === 1, "dashboard tabs");

    await page.locator('[data-testid="monitor-tab-disk"]').click();
    await waitFor(async () => (await page.locator('[data-testid="du-view"]').count()) === 1, "disk tab");
    await waitFor(async () => (await page.locator('[data-testid="du-mount"]').count()) === 1, "df mounts summary");

    // scan "/"
    await page.locator('[data-testid="du-root"]').fill("/");
    await page.locator('[data-testid="du-scan"]').click();
    await waitFor(async () => (await page.locator('[data-testid="du-tile"]').count()) >= 3, "treemap tiles");
    const reqs = await page.evaluate(() => window.__harness.duRequests());
    assert(reqs.length === 1 && reqs[0].path === "/" && reqs[0].depth === 2, `one du at / depth 2, got ${JSON.stringify(reqs)}`);
    await waitFor(
      async () => /3 permission denied/.test(await page.locator('[data-testid="du-denied"]').innerText().catch(() => "")),
      "permission denied count",
    );
    const paths = await page.locator('[data-testid="du-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-path")));
    assert(paths[0] === "/home" && paths.includes("/var") && paths.includes("/usr"), `list sorted by size: ${paths}`);

    // hover tooltip with size + percent
    await page.locator('[data-testid="du-tile"][data-path="/home"]').hover({ position: { x: 5, y: 5 } });
    await waitFor(async () => /%/.test(await page.locator('[data-testid="du-tooltip"]').innerText().catch(() => "")), "tooltip with percent");

    // drill: /home (children known) then /home/testuser (needs a lazy du)
    await page.locator('[data-testid="du-tile"][data-path="/home"]').click({ position: { x: 5, y: 5 } });
    await waitFor(async () => (await page.locator('[data-testid="du-crumb"]').count()) === 2, "breadcrumb / > home");
    await page.locator('[data-testid="du-row"][data-path="/home/testuser"] button').first().click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.duRequests().length)) === 2, "lazy du for /home/testuser");
    const r2 = await page.evaluate(() => window.__harness.duRequests()[1]);
    assert(r2.path === "/home/testuser", `second du path ${r2.path}`);
    await waitFor(async () => (await page.locator('[data-testid="du-row"][data-path="/home/testuser/projects"]').count()) === 1, "projects listed");
    await waitFor(async () => (await page.locator('[data-testid="du-crumb"]').count()) === 3, "breadcrumb has 3 parts");

    // breadcrumb back
    await page.locator('[data-testid="du-crumb"][data-path="/"]').click();
    await waitFor(async () => (await page.locator('[data-testid="du-row"][data-path="/var"]').count()) === 1, "back at /");

    // delete a directory (confirm first)
    await page.locator('[data-testid="du-tile"][data-path="/home"]').click({ position: { x: 5, y: 5 } });
    await page.locator('[data-testid="du-row"][data-path="/home/testuser"] button').first().click();
    await waitFor(async () => (await page.locator('[data-testid="du-row"][data-path="/home/testuser/projects"]').count()) === 1, "projects again");
    await page.locator('[data-testid="du-row"][data-path="/home/testuser/projects"] [data-testid="du-delete"]').click({ force: true });
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await waitFor(async () => !(await page.evaluate(() => window.__harness.fileExists("/home/testuser/projects"))), "remote dir removed");
    await waitFor(async () => (await page.locator('[data-testid="du-row"][data-path="/home/testuser/projects"]').count()) === 0, "row removed");

    // open in explorer leaves the dashboard
    await page.locator('[data-testid="du-row"][data-path="/home/testuser/.config"] [data-testid="du-open"]').dispatchEvent("click");
    await waitFor(async () => (await page.locator('[data-testid="monitor-view"]').count()) === 0, "dashboard replaced by explorer/editor");
  },
};
