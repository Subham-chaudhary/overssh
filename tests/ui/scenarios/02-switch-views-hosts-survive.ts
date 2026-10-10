import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

async function hostRowCount(page: import("playwright-core").Page): Promise<number> {
  return page.locator('[data-testid="host-row"]').count();
}

export const scenario: Scenario = {
  name: "switch Explorer -> Commands -> Hosts, hosts still render",
  async run({ page }) {
    await waitFor(async () => (await hostRowCount(page)) === 3, "3 host rows on initial load");

    await page.getByRole("button", { name: "Explorer", exact: true }).click();
    await page.getByRole("button", { name: "Commands" }).click();
    await page.getByRole("button", { name: "Hosts" }).click();

    await waitFor(
      async () => (await hostRowCount(page)) === 3,
      "3 host rows after switching Explorer -> Commands -> Hosts",
    );
    assert((await hostRowCount(page)) === 3, "host rows still 3 after switching views");
  },
};
