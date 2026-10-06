import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §11 "Loader": opening a file shows a spinner (after a short
// delay, to avoid flicker) while `read_file` is in flight, then the content.
// The fake backend's read_file has a built-in ~1.5s delay for exactly this.
//
// Monaco's first-ever load in a fresh headless browser does a large,
// synchronous-ish parse that can itself run long enough to starve the
// Loader's own 150ms setTimeout — so this only asserts the spinner appeared
// at some point before the content did (not that it was still there right
// after the click), which is what "shows the loader then content" actually
// requires either way.
export const scenario: Scenario = {
  name: "opening a file shows the loader then its content",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");

    // Widen the window read_file is "in flight" well past Monaco's own
    // (highly variable, environment-dependent) first-load parse time, so the
    // loader reliably gets a turn on the event loop to render before the
    // content replaces it.
    await page.evaluate(() => window.__harness.setReadFileDelay(6000));

    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    // A successful connect already switches the sidebar to Explorer — the
    // activity-bar icons toggle the sidebar closed when you click the one
    // that's already active, so don't click "Explorer" again here.
    const readme = page.locator('[data-path="/home/testuser/readme.txt"]');
    await waitFor(async () => (await readme.count()) === 1, "readme.txt row rendered in the explorer tree");
    await readme.click();

    let sawLoader = false;
    await waitFor(
      async () => {
        if ((await page.getByRole("status").count()) > 0) sawLoader = true;
        return (await page.getByText("Hello from the fake remote filesystem.").count()) > 0;
      },
      "file content rendered once read_file resolves",
      25000,
      100,
    );
    assert(sawLoader, "the loading spinner should have appeared at some point before the content did");
    assert((await page.getByRole("status").count()) === 0, "loader is gone once content has loaded");
  },
};
