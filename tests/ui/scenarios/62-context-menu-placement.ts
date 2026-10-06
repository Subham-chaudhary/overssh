import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// The explorer context menu is portaled to <body> and placed at the cursor,
// flipping up when it would cross the bottom edge, and always stays inside the
// viewport (the sidebar's `@container/side` used to offset and clip it).
export const scenario: Scenario = {
  name: "Explorer context menu: flips above the cursor near the bottom edge, stays in the viewport",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.locator('[data-path="/home/testuser/projects"]').count()) === 1, "tree rendered");

    const menu = page.locator('[role="menu"]');
    const viewport = page.viewportSize()!;
    const tree = (await page.locator('[role="tree"]').boundingBox())!;

    // Near the top: opens down-right from the cursor.
    const row = (await page.locator('[data-path="/home/testuser/projects"]').boundingBox())!;
    const topX = row.x + 20;
    const topY = row.y + row.height / 2;
    await page.mouse.click(topX, topY, { button: "right" });
    await waitFor(async () => (await menu.count()) === 1, "menu open (top)");
    await waitFor(async () => (await menu.evaluate((el) => getComputedStyle(el).visibility)) === "visible", "menu placed");
    let box = (await menu.boundingBox())!;
    assert(Math.abs(box.x - topX) <= 1 && Math.abs(box.y - topY) <= 1, `menu at cursor, got ${box.x},${box.y}`);
    assert(await menu.evaluate((el) => el.parentElement === document.body), "menu is portaled to body");
    await page.keyboard.press("Escape");
    await waitFor(async () => (await menu.count()) === 0, "menu closed");

    // Near the bottom: flips up so its bottom edge sits at the cursor.
    const lowY = Math.min(tree.y + tree.height - 4, viewport.height - 8);
    await page.mouse.click(topX, lowY, { button: "right" });
    await waitFor(async () => (await menu.count()) === 1, "menu open (bottom)");
    await waitFor(async () => (await menu.evaluate((el) => getComputedStyle(el).visibility)) === "visible", "menu placed");
    box = (await menu.boundingBox())!;
    assert(box.y >= 0 && box.y + box.height <= viewport.height, `menu inside viewport: y=${box.y} h=${box.height}`);
    assert(box.x >= 0 && box.x + box.width <= viewport.width, "menu inside viewport horizontally");
    assert(box.y + box.height <= lowY + 1, `menu flipped above the cursor: bottom=${box.y + box.height} cursor=${lowY}`);
    await page.getByRole("menuitem", { name: /^Refresh/ }).click();
    await waitFor(async () => (await menu.count()) === 0, "menu item works and closes");
  },
};
