import type { Page } from "playwright-core";
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §14.4.U: the middle section (editor / Dashboard / Logs / Git) keeps a
// sensible minimum size and never overflows, however far the sidebar and the
// terminal panel are dragged, and at the smallest window (720x480).

interface Metrics {
  midW: number;
  midH: number;
  midOverflow: number; // scrollWidth - clientWidth of the middle section
  docOverflow: number; // document scrollWidth - innerWidth
  logOverflow: number; // same for the log view (0 when absent)
}

const metrics = (page: Page): Promise<Metrics> =>
  page.evaluate(() => {
    const mid = document.querySelector('[data-testid="middle-section"]') as HTMLElement;
    const log = document.querySelector('[data-testid="log-view"]') as HTMLElement | null;
    const r = mid.getBoundingClientRect();
    return {
      midW: r.width,
      midH: r.height,
      midOverflow: mid.scrollWidth - mid.clientWidth,
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      logOverflow: log ? log.scrollWidth - log.clientWidth : 0,
    };
  });

const VSEP = '[role="separator"][aria-orientation="vertical"]:visible';
const HSEP = '[role="separator"][aria-orientation="horizontal"]:visible';

async function drag(page: Page, sel: string, nth: number, toX: number, toY: number): Promise<void> {
  const box = await page.locator(sel).nth(nth).boundingBox();
  assert(box, `separator ${sel} #${nth} has a box`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move((x + toX) / 2, (y + toY) / 2, { steps: 4 });
  await page.mouse.move(toX, toY, { steps: 4 });
  await page.mouse.up();
}

async function check(page: Page, what: string): Promise<void> {
  // Let layout settle after the drag.
  await page.waitForTimeout(150);
  const m = await metrics(page);
  assert(m.midW >= 279, `${what}: middle section width ${m.midW} >= 280`);
  assert(m.midH >= 119, `${what}: middle section height ${m.midH} >= 120`);
  assert(m.midOverflow <= 1, `${what}: middle section overflows horizontally by ${m.midOverflow}px`);
  assert(m.docOverflow <= 0, `${what}: page scrolls horizontally by ${m.docOverflow}px`);
  assert(m.logOverflow <= 1, `${what}: log view overflows horizontally by ${m.logOverflow}px`);
}

export const scenario: Scenario = {
  name: "responsive middle section keeps its minimum size and never overflows (720x480, extreme drags)",
  async run({ page }) {
    await page.setViewportSize({ width: 720, height: 480 });
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    // Logs page has the densest toolbars.
    await page.getByRole("button", { name: "Logs", exact: true }).click();
    await waitFor(async () => (await page.locator('[data-testid="log-sidebar"]').count()) === 1, "logs sidebar");
    await page.locator('[data-testid="log-quick-file"]').first().click();
    await waitFor(async () => (await page.locator('[data-testid="log-view"] [data-testid="log-status"]').count()) === 1, "log view");
    await check(page, "initial");

    // Sidebar dragged to the far right, then far left.
    await drag(page, VSEP, 0, 715, 200);
    await check(page, "sidebar dragged wide");
    await drag(page, VSEP, 0, 0, 200);
    await check(page, "sidebar dragged narrow");
    await drag(page, VSEP, 0, 715, 200);
    await check(page, "sidebar wide again");

    // Terminal docked right, dragged wide, plus a wide sidebar.
    await page.keyboard.press("Control+J");
    await waitFor(async () => (await page.locator(".xterm").count()) === 1, "terminal opened");
    await page.keyboard.press("Control+Shift+P");
    const input = page.locator('[data-slot="command-input"]');
    await waitFor(async () => (await input.count()) === 1, "palette open");
    await input.fill("Move Panel to Right");
    await page.locator('[data-slot="command-item"]', { hasText: "Terminal: Move Panel to Right" }).click();
    await waitFor(async () => (await page.locator(VSEP).count()) === 2, "right-dock separator");
    await check(page, "right dock, wide sidebar");

    await drag(page, VSEP, 1, 0, 200); // panel handle to the far left
    await check(page, "right panel dragged wide");
    await drag(page, VSEP, 0, 715, 200);
    await check(page, "sidebar dragged wide again with right panel");

    // Bottom dock, dragged to the very top.
    await page.keyboard.press("Control+Shift+P");
    await waitFor(async () => (await input.count()) === 1, "palette open again");
    await input.fill("Move Panel to Bottom");
    await page.locator('[data-slot="command-item"]', { hasText: "Terminal: Move Panel to Bottom" }).click();
    await waitFor(async () => (await page.locator(HSEP).count()) === 1, "bottom-dock separator");
    await drag(page, HSEP, 0, 300, 0);
    await check(page, "bottom panel dragged tall");

    // Resizing the window re-clamps and still fits.
    await page.setViewportSize({ width: 1100, height: 700 });
    await check(page, "after growing the window");
    await page.setViewportSize({ width: 720, height: 480 });
    await check(page, "after shrinking the window again");
  },
};
