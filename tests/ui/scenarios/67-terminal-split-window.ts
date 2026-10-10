import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §15.3.S: split panes in the detached terminal window. The harness loads the
// window's own page (`?window=terminals`) and plays the main window's part by emitting
// `termwin://init` itself. Covers: split right / down (buttons, keys, tab menu), a new
// terminal per pane, pane limit, divider drag + xterm refit, Alt+Arrow focus, closing a
// terminal collapses its pane, tiny window collapses to the focused pane, merge panes,
// Ctrl+Tab over all terminals, and layout persistence.
export const scenario: Scenario = {
  name: "Detached terminal window: split panes, dividers, focus, collapse",
  async run({ page, baseUrl }) {
    await page.goto(`${baseUrl}?window=terminals`, { waitUntil: "load" });
    await page.waitForSelector('[data-testid="terminal-window"]', { timeout: 20_000 });
    await waitFor(
      async () => (await page.evaluate(() => window.__harness.termwinEvents().some((e) => e.name === "ready"))) === true,
      "window announced itself",
    );

    const tab = (id: string, title: string) => ({
      id,
      sessionId: "s1",
      title,
      exited: false,
      exitCode: null,
      openedWithCommand: false,
      key: id,
      recording: false,
    });
    await page.evaluate(
      (tabs) =>
        window.__harness.emit("termwin://init", {
          tabs,
          activeId: "t-1",
          mru: [],
          closedStack: [],
          ctx: {
            sessions: [{ id: "s1", label: "alpha", user: "testuser", hostname: "alpha.example.com" }],
            activeSessionId: "s1",
            cwds: { s1: "/home/testuser" },
            reconnecting: [],
          },
          settings: {},
        }),
      [tab("t-1", "One"), tab("t-2", "Two")],
    );

    const tabs = page.locator('[data-testid="terminal-tab"]');
    const panes = page.locator('[data-testid="terminal-pane"]');
    const dividers = page.getByTestId("terminal-split-divider");
    const area = page.getByTestId("terminal-area");
    await waitFor(async () => (await tabs.count()) === 2, "two tabs adopted");
    assert((await area.getAttribute("data-split")) === "false", "not split to begin with");
    assert((await panes.count()) === 0, "no pane chrome while unsplit");
    const visibleBodies = () =>
      page.locator('[data-testid="terminal-body"]:not(.invisible)').evaluateAll((els) => els.map((e) => e.getAttribute("data-term-id")));
    assert((await visibleBodies()).join() === "t-1", "active terminal shown");

    // --- split right: a new terminal opens in a new pane ------------------------------------
    await page.getByTestId("terminal-split-right").click();
    await waitFor(async () => (await panes.count()) === 2, "two panes");
    await waitFor(async () => (await tabs.count()) === 3, "a third terminal was opened for the new pane");
    assert((await area.getAttribute("data-split")) === "true", "area reports split");
    assert((await dividers.count()) === 1 && (await dividers.first().getAttribute("data-dir")) === "row", "one vertical divider");
    await waitFor(async () => (await visibleBodies()).length === 2, "two terminals visible");
    const focusedPane = () => panes.evaluateAll((els) => els.findIndex((e) => e.getAttribute("data-focused") === "true"));
    assert((await focusedPane()) === 1, "the new pane is focused");
    const paneIds = await panes.evaluateAll((els) => els.map((e) => e.getAttribute("data-term-id")));
    assert(paneIds[0] === "t-1" && paneIds[1] !== "t-1", `panes show t-1 and the new terminal, got ${paneIds}`);

    // Both panes tile the area (side by side, one divider width apart).
    const box = async (loc: ReturnType<typeof page.locator>) => (await loc.boundingBox())!;
    const widths = async () => {
      const a = await box(panes.nth(0));
      const b = await box(panes.nth(1));
      const total = await box(area);
      return { a: a.width, b: b.width, total: total.width, bx: b.x - a.x - a.width };
    };
    const w0 = await widths();
    assert(Math.abs(w0.a + w0.b + w0.bx - w0.total) <= 1, `panes fill the area: ${JSON.stringify(w0)}`);
    assert(Math.abs(w0.a - w0.b) <= 2, "equal split to begin with");

    // --- divider drag resizes and xterm refits (debounced) ----------------------------------------
    const resizes0 = await page.evaluate(() => window.__harness.termResizes().length);
    const d = await box(dividers.first());
    await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
    await page.mouse.down();
    await page.mouse.move(d.x - 120, d.y + d.height / 2, { steps: 6 });
    await page.mouse.up();
    const w1 = await widths();
    assert(w1.a < w0.a - 80, `left pane shrank: ${w0.a} -> ${w1.a}`);
    assert(w1.b > w0.b + 80, "right pane grew");
    await waitFor(
      async () => (await page.evaluate(() => window.__harness.termResizes().length)) > resizes0,
      "terminals were refit after the drag",
    );

    // --- split down from the focused (right) pane; limit of four panes -----------------------------
    await page.keyboard.press("Control+Shift+Backslash");
    await waitFor(async () => (await panes.count()) === 3, "split down by keyboard");
    assert((await dividers.count()) === 2, "two dividers");
    const dirs = await dividers.evaluateAll((els) => els.map((e) => e.getAttribute("data-dir")).sort());
    assert(dirs.join() === "col,row", `row + col dividers, got ${dirs}`);
    await page.keyboard.press("Control+Backslash");
    await waitFor(async () => (await panes.count()) === 4, "fourth pane (Ctrl+\\)");
    await waitFor(async () => (await tabs.count()) === 5, "five terminals");
    await page.keyboard.press("Control+Shift+5");
    await page.waitForTimeout(300);
    assert((await panes.count()) === 4, "no fifth pane");
    assert((await tabs.count()) === 5, "no extra terminal for a refused split");

    // --- focus: click and Alt+Arrow ---------------------------------------------------------------------
    await panes.nth(0).click({ position: { x: 20, y: 8 } });
    await waitFor(async () => (await focusedPane()) === 0, "clicking a pane header focuses it");
    assert((await page.locator('[data-testid="terminal-tab"][aria-selected="true"]').getAttribute("data-term-id")) === "t-1", "its terminal is the active tab");
    await page.keyboard.press("Alt+ArrowRight");
    await waitFor(async () => (await focusedPane()) !== 0, "Alt+Right moves focus off the left pane");
    const afterRight = await focusedPane();
    await page.keyboard.press("Alt+ArrowLeft");
    await waitFor(async () => (await focusedPane()) === 0, "Alt+Left returns");
    assert(afterRight > 0, "moved to a pane on the right");

    // --- Ctrl+Tab switcher still lists every terminal -----------------------------------------------------
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");
    await waitFor(async () => (await page.getByTestId("tab-switcher").count()) === 1, "switcher appears");
    assert((await page.getByTestId("tab-switcher-title").textContent())?.trim() === "Terminals", "terminal switcher");
    assert((await page.locator('[data-testid="tab-switcher-item"]').count()) === 5, "all five terminals listed");
    await page.keyboard.press("Escape");
    await page.keyboard.up("Control");
    await waitFor(async () => (await page.getByTestId("tab-switcher").count()) === 0, "switcher closed");

    // --- a terminal that exits collapses its pane ---------------------------------------------------------
    const target = (await panes.evaluateAll((els) => els.map((e) => e.getAttribute("data-term-id"))))[3]!;
    await page.evaluate((id) => window.__harness.emit("term://exit", { termId: id, code: 0 }), target);
    await waitFor(async () => (await panes.count()) === 3, "pane collapsed when its terminal exited");
    await waitFor(async () => (await tabs.count()) === 4, "tab removed");
    assert((await dividers.count()) === 2, "dividers follow the panes");

    // --- closing via the pane's X ---------------------------------------------------------------------------
    await panes.nth(2).getByTestId("terminal-pane-close").click();
    await waitFor(async () => (await panes.count()) === 2, "pane X closes the terminal and its pane");
    assert((await tabs.count()) === 3, "three terminals left");

    // --- tiny window: not enough room -> only the focused pane ------------------------------------------------
    await page.setViewportSize({ width: 300, height: 260 });
    await waitFor(async () => (await panes.count()) === 0, "pane chrome hidden when the panes cannot fit");
    await waitFor(async () => (await visibleBodies()).length === 1, "exactly one terminal visible");
    await page.setViewportSize({ width: 1100, height: 700 });
    await waitFor(async () => (await panes.count()) === 2, "panes come back when the window grows");

    // --- merge panes: terminals stay as tabs ------------------------------------------------------------------
    await page.getByTestId("terminal-unsplit").click();
    await waitFor(async () => (await panes.count()) === 0, "merged into one");
    assert((await tabs.count()) === 3, "no terminal was lost");
    assert((await area.getAttribute("data-split")) === "false", "area unsplit");
    assert((await visibleBodies()).length === 1, "one terminal visible");

    // --- tab context menu: split down from a tab -----------------------------------------------------------------
    await tabs.nth(1).click({ button: "right" });
    await page.getByTestId("terminal-tab-menu-split-down").click();
    await waitFor(async () => (await panes.count()) === 2, "split from the tab menu");
    assert((await dividers.first().getAttribute("data-dir")) === "col", "stacked");
    await waitFor(async () => (await tabs.count()) === 4, "tab menu split opened a terminal");

    // --- the layout is remembered (localStorage) --------------------------------------------------------------------
    await page.waitForTimeout(500);
    const stored = await page.evaluate(() => localStorage.getItem("overssh.termwin.layout.v1"));
    assert(stored && JSON.parse(stored).root.type === "split", "split layout persisted");
  },
};
