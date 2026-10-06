import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §12, feature (19): the explorer's "up" toolbar button is
// replaced by a ".." row that's the first tree row whenever cwd isn't "/",
// and navigates to the parent directory on click/Enter.
export const scenario: Scenario = {
  name: 'Explorer ".." row navigates to the parent directory',
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");

    await waitFor(async () => (await page.locator('[data-path="/home/testuser/projects"]').count()) === 1, "tree rendered");

    const upRow = page.locator('[data-testid="explorer-up-row"]');
    // The (fake) home directory isn't the posix root, so a ".." row shows
    // there too (it's the explorer's initial cwd, not a cwd of "/").
    await waitFor(async () => (await upRow.count()) === 1, '".." row shown at the home directory (cwd != "/")');
    assert((await upRow.innerText()).trim() === "..", '".." row\'s text should be literally ".."');

    // Navigate into /home/testuser/projects via the path bar.
    const pathInput = page.locator('[aria-label="Path"]');
    await pathInput.fill("/home/testuser/projects");
    await pathInput.press("Enter");
    await waitFor(async () => (await page.locator('[data-path="/home/testuser/projects/app.js"]').count()) === 1, "navigated into projects");
    assert((await upRow.count()) === 1, '".." row still shown one level down');

    await upRow.click();
    await waitFor(
      async () => (await page.locator('[data-path="/home/testuser/projects"]').count()) === 1,
      "back at /home/testuser after clicking ..",
    );

    // Now go all the way up to "/" — no ".." row there.
    await pathInput.fill("/");
    await pathInput.press("Enter");
    await waitFor(async () => (await page.locator('[data-path="/home"]').count()) === 1, 'navigated to "/"');
    assert((await upRow.count()) === 0, 'no ".." row once cwd is the posix root "/"');
  },
};
