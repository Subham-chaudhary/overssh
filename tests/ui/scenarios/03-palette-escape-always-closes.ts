import type { Page } from "playwright-core";
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

async function isOpen(page: Page): Promise<boolean> {
  return (await page.locator('[data-slot="command-input"]').count()) > 0;
}

export const scenario: Scenario = {
  name: "command palette opens with Ctrl+Shift+P, Esc always closes it (and the theme picker it opens)",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");

    // Plain open + close.
    await page.keyboard.press("Control+Shift+P");
    await waitFor(() => isOpen(page), "palette open after Ctrl+Shift+P");
    await page.keyboard.press("Escape");
    await waitFor(async () => !(await isOpen(page)), "palette closed after Escape");

    // "Preferences: Color Theme" hands over to the ThemePicker quick pick
    // (docs/GUIDE.md §14.4.Z); Escape closes that one too.
    await page.keyboard.press("Control+Shift+P");
    await waitFor(() => isOpen(page), "palette open again");
    await page.locator('[data-slot="command-item"]', { hasText: "Preferences: Color Theme" }).click();
    await waitFor(async () => (await page.getByTestId("theme-picker").count()) === 1, "theme picker shown");
    await waitFor(async () => !(await isOpen(page)), "palette itself closed");
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.getByTestId("theme-picker").count()) === 0, "theme picker closed by Escape");

    // Clicking outside closes it too.
    await page.keyboard.press("Control+Shift+P");
    await waitFor(() => isOpen(page), "palette open a third time");
    await page.mouse.click(5, 5);
    await waitFor(async () => !(await isOpen(page)), "palette closed on outside click");

    assert(!(await isOpen(page)), "palette ends closed");
  },
};
