// docs/GUIDE.md §15.3.A: switching the theme runs inside
// document.startViewTransition when motion is full/reduced and not at all when
// motion is off; rapid changes settle on the last one and the page never
// stays covered by a transition.
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

export const scenario: Scenario = {
  name: "theme switch uses startViewTransition (full), skips it (off), settles after rapid changes",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // Count startViewTransition calls (still forwarding to the real one).
    const supported = await page.evaluate(() => {
      const w = window as unknown as { __vt: number };
      w.__vt = 0;
      const d = document as unknown as { startViewTransition?: (cb: () => void) => unknown };
      const orig = d.startViewTransition?.bind(document);
      if (!orig) return false;
      d.startViewTransition = (cb) => {
        w.__vt++;
        return orig(cb);
      };
      return true;
    });
    const vt = () => page.evaluate(() => (window as unknown as { __vt: number }).__vt);
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    const switching = () => page.evaluate(() => document.documentElement.dataset.themeSwitching);

    const card = (id: string) => page.locator(`[data-testid="settings-theme-card"][data-theme-id="${id}"]`);
    const closeSettings = async () => {
      await page.keyboard.press("Escape");
      await waitFor(async () => (await page.getByTestId("settings-theme-card").count()) === 0, "settings closed");
    };

    const start = (await theme()) ?? "one-dark";
    const a = start === "nord" ? "gruvbox-dark" : "nord";
    const b = a === "nord" ? "gruvbox-dark" : "nord";

    // Full motion: the change goes through a view transition.
    await page.keyboard.press("Control+,");
    await waitFor(async () => (await page.getByTestId("settings-theme-card").count()) > 0, "settings theme cards");
    await card(a).click();
    await waitFor(async () => (await theme()) === a, `theme becomes ${a}`);
    assert(supported, "headless Edge supports view transitions");
    assert((await vt()) >= 1, "startViewTransition called when motion is full");
    await waitFor(async () => (await switching()) === undefined, "transition finished");

    // Off: instant, no transition, no new call.
    await page.getByTestId("motion-off").click();
    await waitFor(async () => (await page.evaluate(() => document.documentElement.dataset.motion)) === "off", "motion off");
    const callsBefore = await vt();
    await card(b).click();
    await waitFor(async () => (await theme()) === b, `theme becomes ${b} (off)`);
    assert((await vt()) === callsBefore, "startViewTransition not called when motion is off");
    await page.getByTestId("motion-full").click();
    await closeSettings();

    // Rapid previews in the picker settle on the last row and nothing is left running.
    await page.keyboard.press("Control+Alt+t");
    await waitFor(async () => (await page.getByTestId("theme-picker").count()) === 1, "picker open");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
    const target = await page.getByTestId("theme-picker").locator('[aria-selected="true"]').getAttribute("data-theme-id");
    await waitFor(async () => (await theme()) === target, `rapid previews settle on ${target}`);
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.getByTestId("theme-picker").count()) === 0, "picker closed");
    await waitFor(async () => (await theme()) === b, "Esc restores the previous theme");
    await waitFor(async () => (await switching()) === undefined, "no transition left running");
  },
};
