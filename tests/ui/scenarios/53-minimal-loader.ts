import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §14.4.U: the loader is a minimal SVG arc (role=status), not the old
// Pac-Man, and swaps its spin for a gentle pulse under prefers-reduced-motion.
export const scenario: Scenario = {
  name: "loader renders a minimal svg arc and respects prefers-reduced-motion",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.evaluate(() => window.__harness.setReadFileDelay(6000));
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    const readme = page.locator('[data-path="/home/testuser/readme.txt"]');
    await waitFor(async () => (await readme.count()) === 1, "readme row");
    await readme.click();

    const loader = page.locator('[role="status"] svg.loader-arc');
    await waitFor(async () => (await loader.count()) >= 1, "loader svg shown while read_file is in flight", 15000, 100);
    assert((await loader.first().locator("circle").count()) === 1 && (await loader.first().locator("path").count()) === 1, "loader is a track circle plus an arc path");
    assert((await page.locator(".pac-mouth, .loader-pellet, .loader-pellets").count()) === 0, "no Pac-Man leftovers");

    const animName = () => loader.first().evaluate((el) => getComputedStyle(el).animationName);
    assert((await animName()).includes("loader-spin"), "spins by default");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await waitFor(async () => (await animName()).includes("loader-pulse"), "reduced motion switches to a pulse");
    await page.emulateMedia({ reducedMotion: "no-preference" });

    await waitFor(async () => (await page.getByText("Hello from the fake remote filesystem.").count()) > 0, "content loaded", 30000, 100);
    assert((await page.locator('[role="status"] svg.loader-arc').count()) === 0, "loader gone after load");
  },
};
