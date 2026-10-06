// docs/GUIDE.md §14.4.W: detaching the terminal panel into its own window, seen from the
// main window (the second window itself cannot run in this harness; its messages are
// simulated with `__harness.emit`). Covers: header button + palette entry, hand-off
// payload, the "Terminals are in a separate window" strip, forwarding "new terminal"
// requests, Ctrl+Tab cycling files only, and docking back.
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

export const scenario: Scenario = {
  name: "Terminal panel detaches to a window and docks back (main-window state)",
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

    const terms = () => page.locator('[data-testid="terminal-tab"]').count();
    await page.keyboard.press("Control+`");
    await waitFor(async () => (await terms()) === 1, "first terminal");
    await page.getByRole("button", { name: "New terminal" }).click();
    await waitFor(async () => (await terms()) === 2, "second terminal");

    // The palette offers Detach (not Dock) while attached.
    const paletteHas = async (text: string) => {
      await page.keyboard.press("Control+Shift+P");
      await waitFor(async () => (await page.locator('[data-slot="command-input"]').count()) > 0, "palette open");
      await page.locator('[data-slot="command-input"]').fill(text);
      await page.waitForTimeout(150);
      const n = await page.locator('[data-slot="command-item"]', { hasText: text }).count();
      await page.keyboard.press("Escape");
      await waitFor(async () => (await page.locator('[data-slot="command-input"]').count()) === 0, "palette closed");
      return n > 0;
    };
    assert(await paletteHas("Terminal: Detach Panel to Window"), "palette has Detach");
    assert(!(await paletteHas("Terminal: Dock Panel")), "palette has no Dock while attached");

    // Detach via the header button.
    await page.getByTestId("terminal-detach").click();
    await waitFor(async () => (await page.getByTestId("terminal-detached-bar").count()) === 1, "detached strip shown");
    assert((await page.evaluate(() => window.__harness.termWindowCalls().some((c) => c.cmd === "term_window_open"))), "window opened");
    assert((await page.locator('[data-testid="terminal-panel-label"]').count()) === 0, "panel gone from the main window");
    assert((await terms()) === 0, "no terminal tabs rendered in the main window");

    // Hand-off payload: both tabs, the session, the settings.
    const init = await page.evaluate(() => window.__harness.termwinEvents().find((e) => e.name === "init")?.payload as {
      tabs: { id: string; sessionId: string }[];
      activeId: string | null;
      ctx: { sessions: { id: string; label: string }[]; activeSessionId: string | null };
      settings: { theme: string };
    });
    assert(init, "init message sent");
    assert(init.tabs.length === 2, `2 tabs handed over, got ${init.tabs.length}`);
    assert(init.activeId === init.tabs[1].id, "active tab handed over");
    assert(init.ctx.sessions.length === 1 && init.ctx.activeSessionId === init.ctx.sessions[0].id, "session context handed over");
    assert(typeof init.settings.theme === "string", "settings handed over");

    // Palette now offers Dock.
    assert(await paletteHas("Terminal: Dock Panel"), "palette has Dock while detached");

    // Ctrl+Tab in the main window cycles files only.
    await page.keyboard.down("Control");
    await page.keyboard.press("Tab");
    await waitFor(async () => (await page.getByTestId("tab-switcher").count()) === 1, "switcher appears");
    const title = await page.getByTestId("tab-switcher-title").textContent();
    assert(title?.trim() === "Files", `main switcher lists files, got ${title}`);
    await page.keyboard.up("Control");
    await waitFor(async () => (await page.getByTestId("tab-switcher").count()) === 0, "switcher closed");

    // "Show terminal" paths bring the window to the front instead of showing a panel.
    const focusCalls = () => page.evaluate(() => window.__harness.termWindowCalls().filter((c) => c.cmd === "term_window_focus").length);
    const f0 = await focusCalls();
    await page.keyboard.press("Control+`");
    await waitFor(async () => (await focusCalls()) > f0, "Ctrl+` focuses the terminal window");
    assert((await page.getByTestId("terminal-detached-bar").count()) === 1, "still detached");

    // "New terminal" is forwarded to the window, which answers with the new id.
    await page.keyboard.press("Control+Shift+P");
    await page.locator('[data-slot="command-input"]').fill("Terminal: New Terminal");
    await page.waitForTimeout(150);
    await page.locator('[data-slot="command-item"]', { hasText: "Terminal: New Terminal" }).first().click();
    const openReq = async () =>
      page.evaluate(() => window.__harness.termwinEvents().find((e) => e.name === "open")?.payload as
        | { reqId: string; sessionId: string }
        | undefined);
    await waitFor(async () => (await openReq()) !== undefined, "open request forwarded to the window");
    const req = (await openReq())!;
    assert(req.sessionId === init.ctx.sessions[0].id, "request targets the active session");
    await page.evaluate((r) => window.__harness.emit("termwin://opened", { reqId: r.reqId, id: "term-99" }), req);

    // Dock back: main asks the window, the window answers with its tabs.
    await page.getByTestId("terminal-dock-back").click();
    await waitFor(
      async () => (await page.evaluate(() => window.__harness.termwinEvents().some((e) => e.name === "close-requested"))) === true,
      "dock request sent to the window",
    );
    await page.evaluate(
      (st) => window.__harness.emit("termwin://dock", { tabs: st.tabs, activeId: st.tabs[0].id, mru: [], closedStack: [] }),
      init,
    );
    await waitFor(async () => (await page.getByTestId("terminal-detached-bar").count()) === 0, "strip gone after dock");
    await waitFor(async () => (await terms()) === 2, "both terminals are back in the main panel");
    assert((await page.locator('[data-testid="terminal-panel-label"]').count()) === 1, "panel visible again");
    assert(
      await page.evaluate(() => window.__harness.termWindowCalls().some((c) => c.cmd === "term_window_close")),
      "window closed",
    );
    const active = await page.locator('[data-testid="terminal-tab"][aria-selected="true"]').getAttribute("data-term-id");
    assert(active === init.tabs[0].id, "active terminal restored");
  },
};
