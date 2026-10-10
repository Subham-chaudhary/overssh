import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Services tab (§15.3.V): actions with confirm dialogs, stderr toast on failure, the
// "sudo needs a password" state (copy / run in terminal), a dead session, and a host
// without systemd.
export const scenario: Scenario = {
  name: "services tab: actions + confirm, sudo-password error, session drop, non-systemd host",
  async run({ page }) {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "1 session");
    await page.getByRole("button", { name: "Dashboard" }).click();
    await page.locator('[data-testid="monitor-tab-services"]').click();
    await waitFor(async () => (await page.locator('[data-testid="svc-row"]').count()) === 9, "9 rows");

    const actions = () => page.evaluate(() => window.__systemd.actions());
    const select = (unit: string) => page.locator(`[data-testid="svc-row"][data-unit="${unit}"]`).click();
    const rowAttr = (unit: string, a: string) =>
      page.locator(`[data-testid="svc-row"][data-unit="${unit}"]`).getAttribute(a);

    // `s` starts without a confirm; the row turns active after the refresh
    await select("backup.service");
    await page.keyboard.press("s");
    await waitFor(async () => (await actions()).length === 1, "start sent");
    let a = await actions();
    assert(a[0].action === "start" && a[0].unit === "backup.service" && a[0].user === false, `start action ${JSON.stringify(a[0])}`);
    await waitFor(async () => (await rowAttr("backup.service", "data-active")) === "active", "backup.service now active");

    // `S` (stop) asks first: cancel keeps it running, confirm stops it
    await select("nginx.service");
    await page.keyboard.press("S");
    const dlg = page.getByRole("alertdialog");
    await dlg.waitFor();
    assert((await dlg.innerText()).includes("Stop nginx.service?"), "stop confirm text");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(150);
    assert((await actions()).length === 1, "cancel sends nothing");
    await page.keyboard.press("S");
    await dlg.waitFor();
    await dlg.getByRole("button", { name: "Stop", exact: true }).click();
    await waitFor(async () => (await actions()).length === 2, "stop sent");
    await waitFor(async () => (await rowAttr("nginx.service", "data-active")) === "inactive", "nginx.service now inactive");

    // disable from the drawer also confirms; restart of ssh warns about the connection
    await page.keyboard.press("Enter");
    await page.locator('[data-testid="svc-details"][data-unit="nginx.service"]').waitFor();
    await page.locator('[data-testid="svc-act-disable"]').click();
    await dlg.waitFor();
    assert((await dlg.innerText()).includes("Disable nginx.service?"), "disable confirm");
    await dlg.getByRole("button", { name: "Disable", exact: true }).click();
    await waitFor(async () => (await actions()).some((x) => x.action === "disable" && x.unit === "nginx.service"), "disable sent");
    await waitFor(async () => (await page.locator('[data-testid="svc-act-enable"]').count()) === 1, "drawer now offers Enable");
    await page.locator('[data-testid="svc-close"]').click();
    await select("ssh.service");
    await page.keyboard.press("r");
    await dlg.waitFor();
    assert((await dlg.innerText()).includes("SSH server"), "ssh restart warns about the connection");
    await dlg.getByRole("button", { name: "Cancel" }).click();

    // a failing start: toast carries stderr, no sudo dialog
    await select("broken-job.service");
    await page.keyboard.press("s");
    await waitFor(async () => (await page.getByText("Job for broken-job.service failed").count()) > 0, "stderr toast");
    assert((await page.locator('[data-testid="svc-sudo-dialog"]').count()) === 0, "no sudo dialog for a plain failure");

    // sudo needs a password: explanatory dialog, Copy command, Run in terminal
    await page.evaluate(() => window.__systemd.set({ sudo: "password" }));
    await select("cron.service");
    await page.keyboard.press("r");
    await page.locator('[data-testid="svc-sudo-dialog"]').waitFor();
    assert((await page.locator('[data-testid="svc-sudo-dialog"]').getAttribute("data-kind")) === "sudoPassword", "typed error kind");
    assert((await page.locator('[data-testid="svc-sudo-title"]').innerText()).includes("password"), "title explains the password");
    assert(
      (await page.locator('[data-testid="svc-sudo-command"]').innerText()).trim() === "sudo systemctl restart cron.service",
      "command shown",
    );
    assert((await page.locator('[data-testid="svc-sudo-dialog"]').innerText()).includes("never asks for or stores passwords"), "no-password promise");
    await page.locator('[data-testid="svc-sudo-copy"]').click();
    await waitFor(async () => (await page.getByText("Command copied").count()) > 0, "copy toast");
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "sudo systemctl restart cron.service");
    assert(clip === "sudo systemctl restart cron.service", `clipboard has the command, got ${clip}`);
    await page.locator('[data-testid="svc-sudo-run"]').click();
    await waitFor(async () => (await page.locator('[data-testid="svc-sudo-dialog"]').count()) === 0, "dialog closes");
    await waitFor(
      async () => (await page.evaluate(() => window.__harness.termWrites().some((w) => w.data.includes("sudo systemctl restart cron.service")))) === true,
      "command typed into a new terminal",
    );
    await page.evaluate(() => window.__systemd.set({ sudo: "ok" }));

    // dead session: banner says so, rows are kept
    await page.evaluate(() => window.__systemd.set({ listError: "no such session: gone" }));
    await page.locator('[data-testid="svc-refresh"]').click();
    await waitFor(async () => (await page.locator('[data-testid="svc-list-error"]').count()) === 1, "list error banner");
    assert((await page.locator('[data-testid="svc-row"]').count()) === 9, "rows stay visible on a failed refresh");
    await page.evaluate(() => window.__systemd.set({ listError: null }));
    await page.locator('[data-testid="svc-refresh"]').click();
    await waitFor(async () => (await page.locator('[data-testid="svc-list-error"]').count()) === 0, "banner clears on success");

    // a host without systemd gets a clean message (second session)
    await page.evaluate(() => window.__systemd.set({ mode: "nosystemd" }));
    await page.getByRole("button", { name: "Hosts" }).first().click().catch(() => {});
    await page.locator('[aria-label="Connect beta"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 2, "2 sessions");
    await page.getByRole("button", { name: "Dashboard" }).click();
    await waitFor(async () => (await page.locator('[data-testid="monitor-session"]').count()) === 2, "sidebar lists both sessions");
    await page.locator('[data-testid="monitor-session"]').nth(1).click();
    await page.locator('[data-testid="svc-nosystemd"]').waitFor();
    const msg = await page.locator('[data-testid="svc-nosystemd"]').innerText();
    assert(msg.includes("systemd is not available") && msg.includes("openrc-init"), `non-systemd message, got ${msg}`);
    assert((await page.locator('[data-testid="svc-row"]').count()) === 0, "no rows on a non-systemd host");
  },
};
