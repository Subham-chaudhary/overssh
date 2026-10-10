import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";
import { dockerCalls, harness, openDocker, waitReady } from "../dockerHelpers";

// docs/GUIDE.md §15.3.D: container logs (follow, search, timestamps, scroll pause, ANSI, end of
// stream) and actions (stop / start / restart / remove with the options dialog, confirm for kill).
export const scenario: Scenario = {
  name: "docker: container logs follow, stop / restart / remove with confirm",
  async run({ page }) {
    await openDocker(page);
    await waitReady(page);
    await page.locator('[data-testid="docker-container-row"][data-name="shop-web-1"]').click();
    await page.locator('[data-testid="docker-container-detail"][data-name="shop-web-1"]').waitFor();
    assert((await page.locator('[data-testid="docker-detail-title"]').innerText()) === "shop-web-1", "title");

    // Logs tab is the default and follows.
    await page.locator('[data-testid="docker-logs"]').waitFor();
    await waitFor(async () => (await page.locator('[data-testid="docker-log-line"]', { hasText: /starting [0-9a-f]{64}/ }).count()) === 1, "first log line");
    const stream = (await harness(page, (h) => h.dockerLogStreams()))[0];
    assert(stream.target.length === 64 && stream.follow === true, "following the full container id");
    assert((stream.opts as { tail?: number }).tail === 500, "tail from settings.docker.logTail");
    // ANSI colours are rendered, not shown as escape text.
    const line = page.locator('[data-testid="docker-log-line"]', { hasText: "listening" });
    assert(!(await line.innerText()).includes("[32m"), "no raw escape codes");
    assert((await line.locator("span.text-green-500").count()) === 1, "INFO is green");
    await waitFor(async () => (await page.locator('[data-testid="docker-log-line"]', { hasText: "tick 2" }).count()) === 1, "live follow output");

    // Search filters the lines and reports the count.
    await page.locator('[data-testid="docker-logs-search"]').fill("error");
    await waitFor(async () => (await page.locator('[data-testid="docker-log-line"]').count()) === 1, "one line matches");
    assert((await page.locator('[data-testid="docker-logs-count"]').innerText()).includes("1 of"), "count shows filtered of total");
    await page.locator('[data-testid="docker-logs-search"]').fill("");

    // A big burst, then scroll up: auto-scroll pauses and a jump pill appears.
    await harness(page, (h, t) => h.dockerPushLog(t as string, Array.from({ length: 200 }, (_, i) => `burst ${i}\n`).join("")), stream.target);
    await waitFor(async () => (await page.locator('[data-testid="docker-log-line"]', { hasText: "burst 199" }).count()) >= 1, "burst rendered at the bottom");
    await page.locator('[data-testid="docker-logs-body"]').evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await waitFor(async () => (await page.locator('[data-testid="docker-logs-jump"]').count()) === 1, "jump to bottom pill");
    await harness(page, (h, t) => h.dockerPushLog(t as string, "while-paused\n"), stream.target);
    await new Promise((r) => setTimeout(r, 250));
    const top = await page.locator('[data-testid="docker-logs-body"]').evaluate((el) => el.scrollTop);
    assert(top < 100, `scroll stays where the user left it (scrollTop ${top})`);
    await page.locator('[data-testid="docker-logs-jump"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-logs-jump"]').count()) === 0, "pill gone after jumping");

    // Timestamps toggle restarts the stream with --timestamps.
    await page.locator('[data-testid="docker-logs-timestamps"]').click();
    await waitFor(async () => (await harness(page, (h) => h.dockerLogStreams())).length === 2, "second stream");
    assert(((await harness(page, (h) => h.dockerLogStreams()))[1].opts as { timestamps?: boolean }).timestamps === true, "timestamps requested");
    await waitFor(async () => (await page.locator('[data-testid="docker-log-line"]', { hasText: "2024-05-01T10:00:00" }).count()) >= 1, "timestamps in the lines");
    // Clear empties the buffer.
    await page.locator('[data-testid="docker-logs-clear"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-log-line"]', { hasText: "starting" }).count()) === 0, "cleared");

    // Stop: stream ends, state flips, Resume offered.
    await page.locator('[data-testid="docker-act-stop"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-container-detail"]').getAttribute("data-state")) === "exited", "container exited");
    await waitFor(async () => (await page.locator('[data-testid="docker-logs-resume"]').count()) === 1, "stream ended with Resume");
    assert((await page.locator('[data-testid="docker-logs-status"]').innerText()).includes("Stream ended"), "end message");
    assert((await dockerCalls(page)).some((c) => c.args[0] === "stop" && c.args[1].length === 64), "docker stop <id>");

    // Start again: the logs resume on their own.
    await page.locator('[data-testid="docker-act-start"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-container-detail"]').getAttribute("data-state")) === "running", "running again");
    await waitFor(async () => (await harness(page, (h) => h.dockerLogStreams())).length === 3, "logs restarted after start");

    // Restart.
    await page.locator('[data-testid="docker-act-restart"]').click();
    await waitFor(async () => (await dockerCalls(page)).some((c) => c.args[0] === "restart"), "restart call");

    // Kill asks first; cancelling does nothing.
    await page.locator('[data-testid="docker-act-kill"]').click();
    await page.locator('[data-slot="alert-dialog-cancel"]').click();
    assert(!(await dockerCalls(page)).some((c) => c.args[0] === "kill"), "kill cancelled");

    // Remove opens the options dialog; running containers default to force.
    await page.locator('[data-testid="docker-act-remove"]').click();
    await page.locator('[data-testid="docker-remove-dialog"]').waitFor();
    await page.locator('[data-testid="docker-remove-volumes"]').click();
    await page.locator('[data-testid="docker-remove-confirm"]').click();
    await waitFor(async () => (await dockerCalls(page)).some((c) => c.args[0] === "rm"), "rm call");
    const rm = (await dockerCalls(page)).find((c) => c.args[0] === "rm")!;
    assert(rm.args.includes("-f") && rm.args.includes("-v"), `rm -f -v (got ${rm.args.join(" ")})`);
    await waitFor(async () => (await page.locator('[data-testid="docker-container-row"][data-name="shop-web-1"]').count()) === 0, "container gone from the sidebar");

    // Keyboard: d on a stopped container asks for confirmation, then removes it.
    await page.locator('[data-testid="docker-list-row"][data-name="cache"]').click();
    await page.locator('[data-testid="docker-list"]').focus();
    await page.keyboard.press("d");
    await page.locator('[data-slot="alert-dialog-action"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-list-row"][data-name="cache"]').count()) === 0, "cache removed via key");
    // ? shows the key help.
    await page.locator('[data-testid="docker-list"]').focus();
    await page.keyboard.press("?");
    await page.locator('[data-testid="docker-help"]').waitFor();
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.locator('[data-testid="docker-help"]').count()) === 0, "help closed");
  },
};
