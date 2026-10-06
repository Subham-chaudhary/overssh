import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Regression: the generated shadcn Switch styled `data-checked:` / `data-unchecked:`
// while bits-ui only sets `data-state`, so on/off looked identical, and the
// unchecked track used `--input`, which matched the dialog background.
export const scenario: Scenario = {
  name: "settings switches visibly change between on and off",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) > 0, "app loaded");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Editor", exact: true }).click();

    const sw = page.getByRole("switch").first();
    await waitFor(async () => (await sw.count()) === 1, "a switch is rendered in the Editor section");

    const trackColor = () => sw.evaluate((el) => getComputedStyle(el).backgroundColor);
    const state = () => sw.getAttribute("data-state");

    const before = { state: await state(), color: await trackColor() };
    await sw.click();
    await waitFor(async () => (await state()) !== before.state, "switch data-state flips on click");
    // The track has `transition-all`, so poll until the transition settles.
    await waitFor(
      async () => (await trackColor()) !== before.color,
      `track color must differ between states (stayed ${before.color})`,
      3000,
    );
    const after = { state: await state(), color: await trackColor() };

    // Neither state may blend into the dialog surface behind it.
    const surface = await sw.evaluate((el) => {
      let n: Element | null = el.parentElement;
      while (n) {
        const bg = getComputedStyle(n).backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
        n = n.parentElement;
      }
      return "";
    });
    for (const c of [before.color, after.color]) {
      assert(c !== surface, `switch track ${c} is identical to its background ${surface}`);
    }
  },
};
