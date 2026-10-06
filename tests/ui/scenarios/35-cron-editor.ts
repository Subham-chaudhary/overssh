import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";
import { describeSchedule, diffLines, nextRuns, parseCrontab, serializeCrontab, validateSchedule } from "../../../src/lib/cron";

// Pure cron logic assertions + the Cron tab: add a job, toggle another, save sends
// the expected crontab text, then re-reads.
export const scenario: Scenario = {
  name: "cron: parser/describe/next-runs, add job, toggle, save writes expected text",
  async run({ page }) {
    // --- parse/serialize round trip keeps everything verbatim
    const sample =
      "# m h dom mon dow\nMAILTO=a@b.c\nPATH=/usr/bin:/bin\n\n0 5 * * * /bin/x  --flag\n# plain note\n#15 3 * * 1-5 /bin/off\n@reboot /bin/boot\nthis is not cron\n";
    const lines = parseCrontab(sample);
    assert(serializeCrontab(lines) === sample, "round trip is verbatim");
    const kinds = lines.map((l) => l.kind).join(",");
    assert(kinds === "comment,env,env,blank,job,comment,job,job,unknown", `line kinds: ${kinds}`);
    const off = lines[6];
    assert(off.kind === "job" && !off.enabled && off.schedule === "15 3 * * 1-5" && off.command === "/bin/off", "disabled job parsed");
    assert(serializeCrontab(parseCrontab("")) === "", "empty crontab");

    // --- validation
    for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "a b c d e", "5-1 * * * *", "@nope"]) {
      assert(!validateSchedule(bad).ok, `invalid: "${bad}"`);
    }
    for (const good of ["* * * * *", "*/5 * * * *", "0 0 1,15 * *", "30 2 * * Mon", "0 9 * jan-mar mon-fri", "0 0 * * 7", "@daily", "@reboot", "1-10/3 * * * *"]) {
      assert(validateSchedule(good).ok, `valid: "${good}"`);
    }

    // --- descriptions
    const cases: [string, string][] = [
      ["* * * * *", "every minute"],
      ["*/5 * * * *", "every 5 minutes"],
      ["30 2 * * 1", "at 02:30 on Mon"],
      ["30 2 * * *", "every day at 02:30"],
      ["0 * * * *", "every hour"],
      ["15 * * * *", "every hour at minute 15"],
      ["0 9 * * 1-5", "at 09:00 on weekdays (Mon-Fri)"],
      ["0 0 1 * *", "at 00:00 on day 1 of the month"],
      ["0 0 * * 0,6", "at 00:00 on weekends"],
      ["@reboot", "at system startup"],
      ["@daily", "every day at 00:00"],
    ];
    for (const [s, want] of cases) {
      const got = describeSchedule(s);
      assert(got === want, `describe("${s}") = "${got}", want "${want}"`);
    }

    // --- next runs (fixed "now": Wed 2025-01-15 10:07 local)
    const now = new Date(2025, 0, 15, 10, 7, 0);
    const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    const nx = (s: string) => nextRuns(s, now).map(fmt).join("|");
    assert(nx("*/5 * * * *") === "1/15 10:10|1/15 10:15|1/15 10:20", `next */5: ${nx("*/5 * * * *")}`);
    assert(nx("30 2 * * 1") === "1/20 2:30|1/27 2:30|2/3 2:30", `next Monday 02:30: ${nx("30 2 * * 1")}`);
    assert(nx("0 0 1 * *") === "2/1 0:00|3/1 0:00|4/1 0:00", `next monthly: ${nx("0 0 1 * *")}`);
    assert(nx("0 9 * * Mon-Fri") === "1/16 9:00|1/17 9:00|1/20 9:00", `next weekdays: ${nx("0 9 * * Mon-Fri")}`);
    assert(nx("0 0 13 * 5") === "1/17 0:00|1/24 0:00|1/31 0:00", `dom OR dow when both restricted: ${nx("0 0 13 * 5")}`);
    assert(nextRuns("@reboot", now).length === 0, "@reboot has no next runs");
    assert(nextRuns("0 0 31 2 *", now).length === 0, "impossible date yields nothing");
    const dd = diffLines("a\nb\n", "a\nc\n");
    assert(dd.map((d) => d.op + d.text).join("|") === " a|-b|+c", "diff");

    // --- UI
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "1 session");
    await page.getByRole("button", { name: "Dashboard" }).click();
    await page.locator('[data-testid="monitor-tab-cron"]').click();
    await waitFor(async () => (await page.locator('[data-testid="cron-row"]').count()) === 2, "2 jobs listed");
    assert(/MAILTO=ops@example.com/.test(await page.locator('[data-testid="cron-env"]').innerText()), "env line shown");
    const first = page.locator('[data-testid="cron-row"]').first();
    assert((await first.locator('[data-testid="cron-desc"]').innerText()).trim() === "at 02:30 on Mon", "row description");
    assert((await page.locator('[data-testid="cron-row"]').nth(1).getAttribute("data-enabled")) === "false", "commented job is disabled");

    // add a job: invalid first, then valid
    await page.locator('[data-testid="cron-add"]').click();
    await page.locator('[data-testid="cron-schedule-input"]').fill("61 * * * *");
    await waitFor(async () => (await page.locator('[data-testid="cron-live-error"]').count()) === 1, "live validation error");
    await page.locator('[data-testid="cron-command-input"]').fill("echo hi");
    assert(await page.locator('[data-testid="cron-dialog-ok"]').isDisabled(), "OK disabled while invalid");
    await page.locator('[data-testid="cron-preset"]', { hasText: "Every 5 min" }).click();
    await waitFor(async () => (await page.locator('[data-testid="cron-live-desc"]').innerText()) === "every 5 minutes", "live description");
    assert((await page.locator('[data-testid="cron-live-next"]').count()) === 1, "live next runs");
    await page.locator('[data-testid="cron-dialog-ok"]').click();
    await waitFor(async () => (await page.locator('[data-testid="cron-row"]').count()) === 3, "3 rows");
    await waitFor(async () => (await page.locator('[data-testid="cron-dirty"]').count()) === 1, "dirty badge");

    // enable the commented-out job
    await page.locator('[data-testid="cron-row"]').nth(1).locator('[data-testid="cron-toggle"]').click();
    assert((await page.locator('[data-testid="cron-row"]').nth(1).getAttribute("data-enabled")) === "true", "toggled on");

    // save: diff confirm, then exact text
    await page.locator('[data-testid="cron-save"]').click();
    await page.locator('[data-testid="cron-confirm"]').waitFor();
    const diff = await page.locator('[data-testid="cron-diff"]').innerText();
    assert(diff.includes("+ */5 * * * * echo hi") && diff.includes("- #*/10 * * * * /opt/old-job.sh"), `diff text: ${diff}`);
    await page.locator('[data-testid="cron-confirm-ok"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.cronWrites().length)) === 1, "cron_write called");
    const written = (await page.evaluate(() => window.__harness.cronWrites()))[0];
    const expected =
      "MAILTO=ops@example.com\n# nightly backup\n30 2 * * 1 /usr/local/bin/backup.sh >> /var/log/backup.log 2>&1\n*/10 * * * * /opt/old-job.sh\n*/5 * * * * echo hi\n";
    assert(written === expected, `written crontab:\n${written}`);
    await waitFor(async () => (await page.locator('[data-testid="cron-dirty"]').count()) === 0, "clean after re-read");
    assert((await page.locator('[data-testid="cron-row"]').count()) === 3, "3 rows after re-read");

    // duplicate + delete + raw mode
    await page.locator('[data-testid="cron-row"]').last().locator('[data-testid="cron-dup"]').click();
    await waitFor(async () => (await page.locator('[data-testid="cron-row"]').count()) === 4, "duplicated");
    await page.locator('[data-testid="cron-row"]').last().locator('[data-testid="cron-delete"]').click();
    await waitFor(async () => (await page.locator('[data-testid="cron-row"]').count()) === 3, "deleted");
    await page.locator('[data-testid="cron-raw-toggle"]').click();
    const raw = await page.locator('[data-testid="cron-raw"]').inputValue();
    assert(raw === expected, "raw view shows the crontab text");
    await page.locator('[data-testid="cron-raw"]').fill(expected + "0 4 * * * /bin/raw-added\n");
    await page.locator('[data-testid="cron-raw-toggle"]').click();
    await waitFor(async () => (await page.locator('[data-testid="cron-row"]').count()) === 4, "raw edit parsed back into rows");

    // Run now opens a terminal and writes the command
    await page.locator('[data-testid="cron-row"]').first().locator('[data-testid="cron-run"]').click();
    await waitFor(
      async () => await page.evaluate(() => window.__harness.termWrites().some((w) => w.data.startsWith("/usr/local/bin/backup.sh"))),
      "run now wrote the command to a terminal",
      12000,
    );
  },
};
