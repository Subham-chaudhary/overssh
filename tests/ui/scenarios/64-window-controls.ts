import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Custom window chrome (§15.3.T): circle buttons call the window API, fill with
// the theme's blue / yellow / red on hover and grow a little.
export const scenario: Scenario = {
  name: "title bar: circle buttons minimize / maximize / close, hover fills and scales",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="title-bar"]').count()) === 1, "title bar mounted");

    const bar = page.locator('[data-testid="title-bar"]');
    const box = (await bar.boundingBox())!;
    assert(box.y === 0 && box.height >= 30 && box.height <= 36, `bar sits on top, 30-36px high (got y=${box.y} h=${box.height})`);
    const barBg = await bar.evaluate((el) => getComputedStyle(el).backgroundColor);
    const sidebarBg = await page.locator("nav[aria-label='Views']").evaluate((el) => getComputedStyle(el).backgroundColor);
    assert(barBg === sidebarBg, `bar uses the sidebar colour (${barBg} vs ${sidebarBg})`);

    // Order left to right: minimize, maximize, close -- circles only, no logo.
    const labels = await page.locator('[data-testid="window-controls"] button').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    assert(JSON.stringify(labels) === JSON.stringify(["Minimize", "Maximize", "Close"]), `button order: ${labels}`);
    assert((await bar.locator("svg[aria-label='OverSSH']").count()) === 0, "no logo in the title bar");
    const xs = await page.locator('[data-testid="window-controls"] button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().x));
    assert(xs[0] < xs[1] && xs[1] < xs[2] && xs[2] < 120, `circles at the top left: ${xs}`);

    const dot = (id: string) => page.locator(`[data-testid="${id}"] .dot`);
    const bg = (id: string) => dot(id).evaluate((el) => getComputedStyle(el).backgroundColor);
    const scale = (id: string) => dot(id).evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
    const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const alpha = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number)[3] ?? 1;

    // Idle: hollow (barely tinted), not scaled.
    await page.mouse.move(600, 200);
    await waitFor(async () => (await scale("win-minimize")) === 1, "idle scale 1");
    assert(alpha(await bg("win-minimize")) < 0.4, `idle ring is hollow: ${await bg("win-minimize")}`);

    // Hover the group: every circle fills with its colour; the hovered one grows.
    const mb = (await page.locator('[data-testid="win-minimize"]').boundingBox())!;
    await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2);
    await waitFor(async () => (await scale("win-minimize")) > 1.1, "hovered circle scales up");
    await waitFor(async () => alpha(await bg("win-minimize")) === 1, "hovered circle filled");
    const [mr, mg, mbl] = rgb(await bg("win-minimize"));
    assert(mbl > mr && mbl > 120, `minimize is blue: ${mr},${mg},${mbl}`);
    assert((await scale("win-close")) === 1, "other circles do not scale");
    const [yr, yg, yb] = rgb(await bg("win-maximize"));
    assert(yr > 150 && yg > 120 && yb < yr - 40, `maximize is yellow: ${yr},${yg},${yb}`);
    const [rr, rg, rb] = rgb(await bg("win-close"));
    assert(rr > 150 && rg < rr - 60 && rb < rr - 40, `close is red: ${rr},${rg},${rb}`);

    // The colours follow the theme (github-light has its own set).
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "github-light"));
    await waitFor(async () => rgb(await bg("win-minimize")).join() === "9,105,218", "theme-shaded blue on github-light");
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "one-dark"));

    // Clicks call the window API.
    await page.getByRole("button", { name: "Minimize" }).click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.windowCalls())).some((c) => c.cmd === "minimize"), "minimize called");

    await page.getByRole("button", { name: "Maximize" }).click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.windowCalls())).some((c) => c.cmd === "toggle_maximize"), "toggle_maximize called");
    await waitFor(async () => (await page.getByRole("button", { name: "Restore" }).count()) === 1, "glyph/label swaps to Restore when maximized");
    await waitFor(async () => (await bar.getAttribute("data-maximized")) !== null, "bar marked maximized (square corners)");
    assert((await bar.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)) === "0px", "no rounded corners when maximized");

    await page.getByRole("button", { name: "Restore" }).click();
    await waitFor(async () => (await page.getByRole("button", { name: "Maximize" }).count()) === 1, "back to Maximize");
    assert((await bar.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)) !== "0px", "rounded corners when restored");

    await page.getByRole("button", { name: "Close" }).click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.windowCalls())).some((c) => c.cmd === "close"), "close called");

    // Keyboard: the circles are tabbable buttons.
    await page.getByRole("button", { name: "Minimize" }).focus();
    await page.keyboard.press("Tab");
    assert((await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Maximize", "Tab moves to Maximize");

    // Drag region on the bar and its title; the buttons are not drag regions.
    assert((await bar.getAttribute("data-tauri-drag-region")) !== null, "bar is a drag region");
    assert((await page.locator('[data-testid="title-center"]').getAttribute("data-tauri-drag-region")) !== null, "title is a drag region");
    assert((await page.locator('[data-testid="win-close"]').getAttribute("data-tauri-drag-region")) === null, "buttons are not drag regions");

    // Window title follows the workspace for the taskbar.
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => document.title)).includes("alpha"), "document.title includes the host");
    const t = await page.evaluate(() => window.__harness.windowTitle());
    assert(t.endsWith("OverSSH") && t.includes("alpha"), `native window title updated: ${t}`);
  },
};
