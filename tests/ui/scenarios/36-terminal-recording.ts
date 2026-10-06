// §13.4.T2: terminal recording. The toggle only exists when the setting is on;
// start/stop call rec_start/rec_stop; the recordings dialog lists the mock
// file and its player renders the cast.
import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

export const scenario: Scenario = {
  name: "terminal recording: setting gates the toggle, start/stop, browser + player",
  async run({ page }) {
    await waitFor(
      async () => (await page.locator('[data-testid="host-row"]').count()) === 3,
      "3 host rows rendered",
    );
    await page.locator('[data-testid="host-row"][data-alias="alpha"]').dblclick();
    await waitFor(
      async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1,
      "connected to alpha",
    );
    await page.keyboard.press("Control+`");
    await waitFor(
      async () => (await page.locator('[data-testid="terminal-tab"]').count()) === 1,
      "terminal opened",
    );

    // Setting off by default: no toggle.
    assert(
      (await page.locator('[data-testid="terminal-rec-toggle"]').count()) === 0,
      "no record toggle while recording is disabled",
    );

    // Enable it in Settings > Terminal.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await page.getByTestId("setting-recording-enabled").click();
    await waitFor(
      async () => (await page.locator('[data-testid="terminal-rec-toggle"]').count()) === 1,
      "toggle visible once enabled",
    );

    // Open the (empty-player) browser from settings and look at the list.
    await page.getByTestId("open-recordings").click();
    await waitFor(
      async () => (await page.locator('[data-testid="rec-row"]').count()) === 1,
      "recordings dialog lists the mock file",
    );
    assert(
      (await page.getByTestId("rec-row").textContent())?.includes("alpha"),
      "row shows the host",
    );
    await page.getByTestId("rec-play").click();
    await waitFor(
      async () => (await page.getByTestId("player-total").count()) === 1,
      "player shown",
    );
    // Idle gaps are capped at 2 s: 0.1 + 2.0 = 2.1 s -> "0:02".
    assert((await page.getByTestId("player-total").textContent())?.trim() === "0:02", "idle cap applied to total");
    // Seek to the end so the whole cast is rendered, then read the xterm rows.
    await page.getByTestId("player-seek").evaluate((el: HTMLInputElement) => {
      el.value = el.max;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await waitFor(
      async () => ((await page.getByTestId("player-term").textContent()) ?? "").includes("second-line"),
      "player rendered the cast output",
    );
    await page.getByTestId("rec-back").click();
    await page.keyboard.press("Escape");
    await waitFor(
      async () => (await page.getByTestId("recordings-dialog").count()) === 0,
      "recordings dialog closed",
    );

    // Start / stop recording on the terminal.
    const toggle = page.getByTestId("terminal-rec-toggle");
    await toggle.click();
    await waitFor(
      async () => (await page.evaluate(() => window.__harness.recCalls().some((c) => c.cmd === "rec_start"))),
      "rec_start called",
    );
    await waitFor(
      async () => (await toggle.getAttribute("data-recording")) === "true",
      "toggle shows recording",
    );
    await toggle.click();
    await waitFor(
      async () => (await page.evaluate(() => window.__harness.recCalls().some((c) => c.cmd === "rec_stop"))),
      "rec_stop called",
    );

    // Turning the setting off while recording stops it and hides the toggle.
    await toggle.click();
    await waitFor(async () => (await toggle.getAttribute("data-recording")) === "true", "recording again");
    const stopsBefore = await page.evaluate(() => window.__harness.recCalls().filter((c) => c.cmd === "rec_stop").length);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await page.getByTestId("setting-recording-enabled").click();
    await waitFor(
      async () =>
        (await page.evaluate(() => window.__harness.recCalls().filter((c) => c.cmd === "rec_stop").length)) === stopsBefore + 1,
      "disabling the setting stops the running recording",
    );
    await waitFor(
      async () => (await page.locator('[data-testid="terminal-rec-toggle"]').count()) === 0,
      "toggle hidden again",
    );
  },
};
