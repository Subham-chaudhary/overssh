import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

export const scenario: Scenario = {
  name: "hosts render on load",
  async run({ page }) {
    await waitFor(
      async () => (await page.locator('[data-testid="host-row"]').count()) === 3,
      "3 host rows rendered",
    );
    const aliases = await page.locator('[data-testid="host-row"]').evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-alias")),
    );
    assert(aliases.includes("alpha"), `expected "alpha" among ${JSON.stringify(aliases)}`);
    assert(aliases.includes("beta"), `expected "beta" among ${JSON.stringify(aliases)}`);
    assert(aliases.includes("gamma"), `expected "gamma" among ${JSON.stringify(aliases)}`);
  },
};
