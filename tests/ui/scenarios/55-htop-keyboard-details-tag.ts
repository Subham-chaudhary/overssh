import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// htop tab (§14.4.H): keyboard navigation, `/` filter, Space-tag multi kill, nice keys,
// follow toggle, detail drawer (fail-soft on permission denied), pause.
export const scenario: Scenario = {
  name: "htop tab: keys, tag + multi kill, nice, follow, detail drawer, pause",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "1 session");
    await page.getByRole("button", { name: "Dashboard" }).click();
    await page.locator('[data-testid="monitor-tab-htop"]').click();
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 6, "6 rows");

    const rowPids = () =>
      page.locator('[data-testid="proc-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-pid")));
    const selectedPid = () =>
      page.locator('[data-testid="proc-row"][data-selected="1"]').first().getAttribute("data-pid");

    // arrows / Home / End (default sort CPU desc: 1234 first, 2345 second)
    await page.locator('[data-testid="proc-row"]').first().click();
    assert((await selectedPid()) === "1234", "click selects the first row");
    await page.keyboard.press("ArrowDown");
    assert((await selectedPid()) === "2345", "ArrowDown moves to the next row");
    await page.keyboard.press("End");
    const pids = await rowPids();
    assert((await selectedPid()) === pids[pids.length - 1], "End selects the last row");
    await page.keyboard.press("Home");
    assert((await selectedPid()) === pids[0], "Home selects the first row");

    // `/` focuses the filter; Esc clears it and returns to the table
    await page.keyboard.press("/");
    await waitFor(
      async () => (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "proc-filter",
      "/ focuses filter",
    );
    await page.keyboard.type("nginx");
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 1, "filter narrows");
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.locator('[data-testid="proc-row"]').count()) === 6, "Esc clears filter");

    // Space tags (and moves down); two tagged -> one multi kill
    await page.locator('[data-testid="proc-row"][data-pid="1234"]').click();
    await page.keyboard.press(" ");
    await page.keyboard.press(" ");
    await waitFor(async () => (await page.locator('[data-testid="proc-row"][data-tagged="1"]').count()) === 2, "2 tagged");
    assert((await page.locator('[data-testid="proc-tagged"]').innerText()).includes("2"), "tag count on kill button");
    await page.keyboard.press("F9");
    await page.locator('[data-testid="signal-dialog"]').waitFor();
    await page.locator('button[data-sig="HUP"]').click();
    await page.getByRole("button", { name: "Send SIGHUP" }).click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.kills().length)) === 2, "kill sent for both tagged");
    const kills = await page.evaluate(() => window.__harness.kills());
    assert(
      kills.every((k) => k.signal === "HUP"),
      "signal HUP",
    );
    assert(new Set(kills.map((k) => k.pid)).size === 2, "two distinct pids");
    await waitFor(async () => (await page.locator('[data-testid="proc-row"][data-tagged="1"]').count()) === 0, "tags cleared after kill");

    // F8 = nice +
    await page.locator('[data-testid="proc-row"][data-pid="1234"]').click();
    await page.keyboard.press("F8");
    await waitFor(async () => (await page.evaluate(() => window.__harness.reniceCalls().length)) === 1, "renice called");
    const rn = await page.evaluate(() => window.__harness.reniceCalls());
    assert(rn[0].pid === 1234 && rn[0].nice === 1, "nice 0 -> 1");

    // follow toggle
    await page.keyboard.press("F");
    assert((await page.locator('[data-testid="proc-follow"]').getAttribute("aria-pressed")) === "true", "follow on");
    await page.keyboard.press("F");

    // detail drawer: Enter opens, shows /proc data, children are clickable
    await page.locator('[data-testid="proc-row"][data-pid="1"]').click();
    await page.keyboard.press("Enter");
    await page.locator('[data-testid="proc-details"]').waitFor();
    await waitFor(async () => (await page.locator('[data-testid="pd-exe"]').innerText()) === "/usr/sbin/nginx", "exe read from /proc");
    assert((await page.locator('[data-testid="pd-cmdline"]').innerText()).includes("nginx.conf"), "full cmdline");
    assert((await page.locator('[data-testid="pd-cwd"]').innerText()) === "/srv/www", "cwd");
    assert((await page.locator('[data-testid="pd-env"]').innerText()).includes("14"), "env var count");
    assert((await page.locator('[data-testid="pd-fds"]').innerText()) === "23", "open files count");
    assert((await page.locator('[data-testid="pd-children"] button').count()) >= 3, "children listed");
    await page.locator('[data-testid="pd-children"] button', { hasText: "2345" }).click();
    await waitFor(async () => (await selectedPid()) === "2345", "child click selects it");
    // permission denied degrades gracefully
    await waitFor(
      async () => (await page.locator('[data-testid="pd-env"]').innerText()).includes("permission denied"),
      "denied env shows a message",
    );
    assert((await page.locator('[data-testid="pd-fds"]').innerText()).includes("permission denied"), "denied fds");
    assert((await page.evaluate(() => window.__harness.detailCalls().includes(2345))) === true, "details requested for 2345");
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.locator('[data-testid="proc-details"]').count()) === 0, "Esc closes the drawer");

    // pause with `p`
    await page.keyboard.press("p");
    await waitFor(async () => (await page.getByText("Paused", { exact: true }).count()) > 0, "paused badge");
  },
};
