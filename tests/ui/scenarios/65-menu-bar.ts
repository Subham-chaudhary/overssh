import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Menu bar (§15.3.T): click opens, hover switches, arrows navigate, Esc closes,
// items run registry commands (hidden when the command does not exist).
export const scenario: Scenario = {
  name: "menu bar: open, hover-switch, arrow keys, run a command, Esc, hidden items, Alt, About",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    const names = await page
      .locator('[data-testid="menu-bar"] [data-slot="menubar-trigger"]')
      .evaluateAll((els) => els.map((e) => e.textContent?.trim()));
    assert(JSON.stringify(names) === JSON.stringify(["File", "Edit", "View", "Go", "Terminal", "Help"]), `menus: ${names}`);

    const open = (id: string) => page.locator(`[data-testid="menu-${id}-content"]`);
    const focusedId = () => page.evaluate(() => document.activeElement?.getAttribute("data-testid"));

    // Click opens; the dropdown is portaled to <body>, out of the clipped layout.
    await page.locator('[data-testid="menu-file"]').click();
    await waitFor(async () => (await open("file").count()) === 1, "File menu open");
    assert(
      await open("file").evaluate((el) => {
        let n: HTMLElement | null = el as HTMLElement;
        while (n && n.parentElement !== document.body) n = n.parentElement;
        return n !== null;
      }),
      "menu is portaled to body",
    );
    assert((await open("file").getByText("New Connection...").count()) === 1, "File has New Connection");
    assert((await open("file").getByText("Open Settings").count()) === 1, "File has Open Settings");
    assert((await open("view").count()) === 0, "other menus closed");

    // Hover switches while a menu is open.
    await page.locator('[data-testid="menu-view"]').hover();
    await waitFor(async () => (await open("view").count()) === 1 && (await open("file").count()) === 0, "hover switched File -> View");
    assert((await open("view").getByText("Color Theme...").count()) === 1, "View has Color Theme");
    assert(
      (await open("view").locator('[data-slot="menubar-shortcut"]', { hasText: "Ctrl+B" }).count()) === 1,
      "keybinding hint shown for Toggle Sidebar",
    );

    // Arrow keys move between menus (and items).
    await page.keyboard.press("ArrowRight");
    await waitFor(async () => (await open("go").count()) === 1, "ArrowRight opens Go");
    await page.keyboard.press("ArrowLeft");
    await waitFor(async () => (await open("view").count()) === 1, "ArrowLeft goes back to View");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    assert((await page.evaluate(() => document.activeElement?.getAttribute("role"))) === "menuitem", "focus is on a menu item");

    // Esc closes.
    await page.keyboard.press("Escape");
    await waitFor(async () => (await open("view").count()) === 0, "Esc closes the menu");

    // Running a command: View > Toggle Sidebar hides the host list.
    await page.locator('[data-testid="menu-view"]').click();
    await open("view").getByText("Toggle Sidebar").click();
    await waitFor(async () => (await page.locator('[data-testid="host-list"]').count()) === 0, "Toggle Sidebar ran");
    await waitFor(async () => (await open("view").count()) === 0, "menu closed after running");
    await page.locator('[data-testid="menu-view"]').click();
    await open("view").getByText("Toggle Sidebar").click();
    await waitFor(async () => (await page.locator('[data-testid="host-list"]').count()) === 1, "Toggle Sidebar again");

    // Command Palette item (not a registry command).
    await page.locator('[data-testid="menu-view"]').click();
    await open("view").getByText("Command Palette...").click();
    await waitFor(async () => (await page.locator('[data-slot="command-input"]').count()) === 1, "palette opened from the menu");
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.locator('[data-slot="command-input"]').count()) === 0, "palette closed");

    // Items for commands that do not exist are hidden; they appear once registered.
    // (string form: tsx's keepNames helper does not exist inside the page)
    await page.evaluate(`import("/src/lib/commands.svelte.ts").then((m) => m.unregisterCommand("docker.show"))`);
    await page.locator('[data-testid="menu-go"]').click();
    await waitFor(async () => (await open("go").count()) === 1, "Go open");
    assert((await open("go").getByText("Dashboard").count()) === 1, "Go has Dashboard");
    assert((await open("go").getByText("Docker", { exact: true }).count()) === 0, "no Docker item without a docker command");
    await page.keyboard.press("Escape");
    await waitFor(async () => (await open("go").count()) === 0, "Go closed");
    await page.evaluate(
      `import("/src/lib/commands.svelte.ts").then((m) => m.registerCommand({ id: "docker.show", title: "Docker: Show", keybinding: "Ctrl+Alt+D", run: () => { window.__dockerRan = true; } }))`,
    );
    await page.locator('[data-testid="menu-go"]').click();
    await waitFor(async () => (await open("go").getByText("Docker", { exact: true }).count()) === 1, "Docker item appears once registered");
    await open("go").getByText("Docker", { exact: true }).click();
    await waitFor(
      async () => (await page.evaluate(() => (window as unknown as { __dockerRan?: boolean }).__dockerRan)) === true,
      "Docker command ran",
    );

    // Alt (tap) focuses the menu bar; arrows move; Esc gives focus back.
    await page.locator('[data-testid="host-row"]').first().focus();
    await page.keyboard.press("Alt");
    await waitFor(async () => (await focusedId()) === "menu-file", "Alt focuses File");
    await page.keyboard.press("ArrowRight");
    assert((await focusedId()) === "menu-edit", "ArrowRight moves to Edit");
    await page.keyboard.press("ArrowDown");
    await waitFor(async () => (await open("edit").count()) === 1, "ArrowDown opens the menu");
    await page.keyboard.press("Escape");
    await waitFor(async () => (await open("edit").count()) === 0, "Esc closes Edit");
    await waitFor(async () => (await focusedId()) === "menu-edit", "focus back on the Edit title");
    await page.keyboard.press("Escape");
    await waitFor(async () => (await focusedId()) !== "menu-edit", "Esc leaves the bar");
    await page.keyboard.press("F10");
    await waitFor(async () => (await focusedId()) === "menu-file", "F10 focuses File");
    await page.keyboard.press("Escape");

    // Help > About shows the app version.
    await page.locator('[data-testid="menu-help"]').click();
    await open("help").getByText("About OverSSH").click();
    await waitFor(async () => (await page.locator('[data-testid="about-dialog"]').count()) === 1, "About dialog open");
    await waitFor(
      async () => ((await page.locator('[data-testid="about-version"]').textContent()) ?? "").includes("0.1.0"),
      "About shows the version",
    );
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.locator('[data-testid="about-dialog"]').count()) === 0, "About closed");

    // Menu titles are not drag regions; File > Exit closes the window.
    assert((await page.locator('[data-testid="menu-file"]').getAttribute("data-tauri-drag-region")) === null, "menu titles are not drag regions");
    await page.locator('[data-testid="menu-file"]').click();
    await open("file").getByText("Exit", { exact: true }).click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.windowCalls())).some((c) => c.cmd === "close"), "Exit closes the window");
  },
};
