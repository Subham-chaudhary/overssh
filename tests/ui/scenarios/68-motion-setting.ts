// docs/GUIDE.md §15.3.A: settings.appearance.motion drives <html data-motion>
// (full / reduced / off; the OS "reduce motion" turns full into reduced), and
// the animations never block input: dialogs and the palette are interactive
// the moment they open and gone once closed.
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

export const scenario: Scenario = {
  name: "motion setting sets data-motion; OS reduce-motion; dialogs stay interactive during animation",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const motion = () => page.evaluate(() => document.documentElement.dataset.motion);
    const fast = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--motion-fast").trim());
    await waitFor(async () => (await motion()) === "full", "default motion is full");

    // Settings > Appearance > Motion.
    await page.keyboard.press("Control+,");
    await waitFor(async () => (await page.getByTestId("motion-reduced").count()) === 1, "motion control shown");
    await page.getByTestId("motion-reduced").click();
    await waitFor(async () => (await motion()) === "reduced", "reduced");
    await page.getByTestId("motion-off").click();
    await waitFor(async () => (await motion()) === "off", "off");
    assert((await fast()) === "0ms", "--motion-fast is 0ms when off");
    await page.getByTestId("motion-full").click();
    await waitFor(async () => (await motion()) === "full", "full again");
    assert((await fast()) === "120ms", "--motion-fast is 120ms");

    // OS "reduce motion" turns full into reduced, and back.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await waitFor(async () => (await motion()) === "reduced", "OS reduce-motion -> reduced");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await waitFor(async () => (await motion()) === "full", "OS preference cleared -> full");

    // The dialog is interactive immediately and closes on Escape.
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.getByTestId("motion-full").count()) === 0, "settings closed");

    // The palette too: type right after opening, then pick a command by click.
    await page.keyboard.press("Control+Shift+P");
    const input = page.getByPlaceholder("Type a command…");
    await waitFor(async () => (await input.count()) === 1, "palette open");
    await page.keyboard.type("color theme");
    assert((await input.inputValue()) === "color theme", "typing works while the palette animates in");
    await page.getByText("Preferences: Color Theme").first().click();
    await waitFor(async () => (await page.getByTestId("theme-picker").count()) === 1, "picker open right after the click");
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.getByTestId("theme-picker").count()) === 0, "picker closed");
    await waitFor(async () => (await input.count()) === 0, "palette gone");

    // Rapid open / close cycles leave nothing behind.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Control+,");
      await page.keyboard.press("Escape");
    }
    await waitFor(async () => (await page.getByTestId("motion-full").count()) === 0, "no settings dialog left over");
    await waitFor(
      async () => (await page.locator('[data-slot="dialog-overlay"]').count()) === 0,
      "no overlay left over",
    );

    // With motion off the same flows still work (popups unmount immediately).
    await page.keyboard.press("Control+,");
    await page.getByTestId("motion-off").click();
    await waitFor(async () => (await motion()) === "off", "motion off");
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.getByTestId("motion-full").count()) === 0, "settings closed (off)");
    await page.keyboard.press("Control+Shift+P");
    await waitFor(async () => (await input.count()) === 1, "palette open (off)");
    await page.keyboard.press("Escape");
    await waitFor(async () => (await input.count()) === 0, "palette closed (off)");
  },
};
