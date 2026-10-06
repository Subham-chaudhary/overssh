// docs/GUIDE.md §14.4.W: the Ctrl+Tab switcher is a focused modal: blurred + dimmed
// full-window backdrop, popup centered both ways, title header ("Files" / "Terminals"),
// icons on the rows. Behaviour (hold Ctrl, release commits, data-testids) is unchanged.
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

export const scenario: Scenario = {
  name: "Ctrl+Tab switcher: blurred backdrop, centered popup, Files/Terminals title",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await page.getByRole("button", { name: "Connect alpha" }).click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    const H = "/home/testuser";
    await waitFor(async () => (await page.locator(`[data-path="${H}/readme.txt"]`).count()) === 1, "tree rendered");

    await page.locator(`[role="treeitem"][data-path="${H}/readme.txt"]`).click();
    await page.locator(`[role="treeitem"][data-path="${H}/notes.md"]`).click();
    await waitFor(async () => (await page.locator('[aria-label="Open files"] [role="tab"]').count()) === 2, "2 file tabs");

    const geometry = () =>
      page.evaluate(() => {
        const bd = document.querySelector('[data-testid="tab-switcher-backdrop"]') as HTMLElement | null;
        const pop = document.querySelector('[data-testid="tab-switcher"]') as HTMLElement | null;
        if (!bd || !pop) return null;
        const b = bd.getBoundingClientRect();
        const p = pop.getBoundingClientRect();
        const cs = getComputedStyle(bd);
        return {
          vw: window.innerWidth,
          vh: window.innerHeight,
          bd: { x: b.x, y: b.y, w: b.width, h: b.height },
          cx: p.x + p.width / 2,
          cy: p.y + p.height / 2,
          filter: cs.backdropFilter || (cs as unknown as Record<string, string>)["webkitBackdropFilter"] || "",
          dim: cs.backgroundColor,
          icons: pop.querySelectorAll('[data-testid="tab-switcher-item"] svg').length,
          items: pop.querySelectorAll('[data-testid="tab-switcher-item"]').length,
        };
      });

    // Files.
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");
    await waitFor(async () => (await page.getByTestId("tab-switcher").count()) === 1, "popup appears");
    const g = await geometry();
    assert(g, "geometry measured");
    assert(g.bd.x === 0 && g.bd.y === 0 && g.bd.w === g.vw && g.bd.h === g.vh, `backdrop covers the window: ${JSON.stringify(g.bd)}`);
    assert(g.filter.includes("blur"), `backdrop blurs: "${g.filter}"`);
    assert(g.dim !== "rgba(0, 0, 0, 0)", `backdrop dims slightly: ${g.dim}`);
    assert(Math.abs(g.cx - g.vw / 2) <= 2, `centered horizontally: ${g.cx} vs ${g.vw / 2}`);
    assert(Math.abs(g.cy - g.vh / 2) <= 2, `centered vertically: ${g.cy} vs ${g.vh / 2}`);
    assert(g.icons === g.items && g.items === 2, `an icon per row: ${g.icons}/${g.items}`);
    const title = await page.getByTestId("tab-switcher-title").textContent();
    assert(title?.trim() === "Files", `title is Files, got ${title}`);
    await page.keyboard.up("Control");
    await waitFor(async () => (await page.getByTestId("tab-switcher-backdrop").count()) === 0, "backdrop closes on release");

    // Clicking the dimmed backdrop cancels without switching.
    const before = await page.locator('[aria-label="Open files"] [role="tab"][aria-selected="true"]').textContent();
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");
    await waitFor(async () => (await page.getByTestId("tab-switcher").count()) === 1, "popup appears again");
    await page.mouse.click(8, 8);
    await waitFor(async () => (await page.getByTestId("tab-switcher").count()) === 0, "backdrop click cancels");
    await page.keyboard.up("Control");
    const after = await page.locator('[aria-label="Open files"] [role="tab"][aria-selected="true"]').textContent();
    assert(before === after, "cancelled switch keeps the active file");

    // Terminals.
    await page.keyboard.press("Control+`");
    await waitFor(async () => (await page.locator('[data-testid="terminal-tab"]').count()) === 1, "first terminal");
    await waitFor(async () => page.evaluate(() => document.activeElement?.closest(".xterm") != null), "xterm focused");
    await page.keyboard.press("Control+t");
    await waitFor(async () => (await page.locator('[data-testid="terminal-tab"]').count()) === 2, "second terminal");
    await waitFor(async () => page.evaluate(() => document.activeElement?.closest(".xterm") != null), "xterm focused again");
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");
    await waitFor(async () => (await page.getByTestId("tab-switcher").count()) === 1, "terminal popup appears");
    const t = await geometry();
    assert(t, "terminal geometry measured");
    assert(Math.abs(t.cx - t.vw / 2) <= 2 && Math.abs(t.cy - t.vh / 2) <= 2, "terminal popup centered");
    const ttitle = await page.getByTestId("tab-switcher-title").textContent();
    assert(ttitle?.trim() === "Terminals", `title is Terminals, got ${ttitle}`);
    assert((await page.getByTestId("tab-switcher-item").count()) === 2, "2 terminals listed");
    await page.keyboard.up("Control");
    await waitFor(async () => (await page.getByTestId("tab-switcher").count()) === 0, "popup closes");
  },
};
