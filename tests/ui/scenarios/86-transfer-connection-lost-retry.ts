import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §15.4.HF2: a transfer ended by a connection drop (`transfer://done` with
// "Connection to the server was lost", not cancelled) says so, keeps Retry disabled until
// the session is back, then retries on the NEW session id from auto-reconnect.
export const scenario: Scenario = {
  name: "Transfers: connection lost shows clearly, Retry waits for reconnect and uses the new session",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    const oldId = await page.evaluate(() => window.__harness.sessions()[0].id);
    const H = "/home/testuser";
    const row = page.locator(`[data-path="${H}/projects"]`);
    await waitFor(async () => (await row.count()) === 1, "tree rendered");

    await page.evaluate(() => {
      window.__harness.setDialogResult("C:\\Users\\me\\Downloads");
      window.__harness.setTransferStepMs(2000);
    });
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Download/ }).click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.transferSpecs().length)) === 1, "transfer started");
    await page.locator('[data-testid="transfers-indicator"]').click();
    const job = page.locator('[data-testid="transfer-job"]').first();
    await waitFor(async () => (await job.count()) === 1, "job listed");

    // The link drops: the backend ends the job with a connection error.
    await page.evaluate(async () => {
      const sid = window.__harness.sessions()[0].id;
      window.__harness.failNextConnect({ kind: "Connection", message: "network unreachable" });
      await window.__harness.dropSession(sid);
      await window.__harness.emit("transfer://done", {
        jobId: "job-1",
        cancelled: false,
        error: "Connection to the server was lost",
        failed: 0,
        skipped: 0,
        filesDone: 0,
        bytesDone: 0,
      });
    });
    await waitFor(async () => (await job.getAttribute("data-state")) === "error", "job failed");
    const status = job.locator('[data-testid="transfer-status"]');
    await waitFor(async () => ((await status.textContent()) ?? "").includes("Connection was lost"), "says the connection was lost");
    const retry = job.locator('[data-testid="transfer-retry"]');
    assert(await retry.isDisabled(), "Retry waits for the reconnect");

    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "reconnected", 15000);
    const newId = await page.evaluate(() => window.__harness.sessions()[0].id);
    assert(newId !== oldId, "new session id");
    await waitFor(async () => !(await retry.isDisabled()), "Retry enabled after reconnect");
    assert(((await status.textContent()) ?? "").includes("Retry to resume"), "status invites a retry");

    await page.evaluate(() => window.__harness.setTransferStepMs(60));
    await retry.dispatchEvent("click"); // the panel sits under toasts that are still animating
    await waitFor(async () => (await page.evaluate(() => window.__harness.transferSpecs().length)) === 2, "retry started a new job");
    const spec = await page.evaluate(() => window.__harness.transferSpecs()[1]);
    assert(spec.sessionId === newId, `retry uses the new session id (got ${String(spec.sessionId)})`);
    assert(spec.conflict === "skip", "retry skips files that already arrived");
  },
};
