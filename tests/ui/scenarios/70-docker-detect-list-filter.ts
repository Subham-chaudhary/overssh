import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";
import { dockerCalls, harness, openDocker, waitReady } from "../dockerHelpers";

// docs/GUIDE.md §15.3.D: Docker detection, sidebar lists + counts + filter, main page lists,
// live stats/events streams, and the not-installed / daemon-down / permission-denied states.
export const scenario: Scenario = {
  name: "docker: detect, lists, filter, streams, missing / denied states",
  async run({ page }) {
    await openDocker(page);
    await waitReady(page);

    // Sidebar sections and counts.
    const count = async (key: string) => Number(await page.locator(`[data-testid="docker-count-${key}"]`).innerText());
    assert((await count("running")) === 3, "3 running containers");
    assert((await count("stopped")) === 1, "1 stopped container");
    assert((await count("images")) === 4, "4 images");
    assert((await count("projects")) === 1, "1 compose project");
    const info = await page.locator('[data-testid="docker-info"]').innerText();
    assert(info.includes("docker 26.1.0") && info.includes("3/4 running"), `engine line (got ${info})`);
    assert((await page.locator('[data-testid="docker-container-row"][data-name="cache"][data-state="exited"]').count()) === 1, "stopped row");

    // The detect call used the configured CLI and Go-template JSON formats.
    const calls = await dockerCalls(page);
    assert(calls[0].args[0] === "info" && calls[0].command === "docker", "info first, with the docker command");
    // `ps` names its fields: a template with `.Size` (as `{{json .}}` has) makes docker walk every
    // container's writable layer on each call.
    const ps = calls.find((c) => c.args[0] === "ps");
    assert(!!ps && ps.args.includes("-a") && !ps.args.some((a) => a.includes(".Size") || a === "{{json .}}"), "ps -a without sizes");
    // `system df` walks every layer and volume: once for the System page that opens by default,
    // never on a timer or on events.
    const dfCount = async () => (await dockerCalls(page)).filter((c) => c.args[0] === "system" && c.args[1] === "df").length;
    assert(calls.filter((c) => c.args[0] === "system" && c.args[1] === "df").length <= 1, "system df at most once on open");
    assert(calls.some((c) => c.args.join(" ") === "compose ls -a --format json"), "compose ls");

    // Filter narrows every section.
    await page.locator('[data-testid="docker-filter"]').fill("solo");
    await waitFor(async () => (await count("running")) === 1, "filter keeps one running container");
    assert((await count("stopped")) === 0, "no stopped match");
    assert((await count("images")) === 0, "no image matches solo");
    await page.locator('[data-testid="docker-filter"]').fill("");
    await waitFor(async () => (await count("running")) === 3, "filter cleared");

    // Main page: container list with the live stats columns and both streams running.
    await page.locator('[data-testid="docker-view"]').waitFor();
    assert((await page.locator('[data-testid="docker-list-row"]').count()) === 4, "4 rows in the main list");
    await waitFor(async () => (await harness(page, (h) => h.dockerStreams().stats)) >= 1, "stats stream started");
    await waitFor(async () => (await harness(page, (h) => h.dockerStreams().events)) >= 1, "events stream started");
    await waitFor(
      async () => (await page.locator('[data-testid="docker-list-row"][data-name="shop-web-1"]').innerText()).includes("%"),
      "cpu shown in the list from the stats stream",
    );
    // Healthcheck exec events (every few seconds per container) do not refresh the lists; a real
    // change does, once for a burst.
    const psCount = async () => (await dockerCalls(page)).filter((c) => c.args[0] === "ps").length;
    const before = await psCount();
    for (let i = 0; i < 8; i++) await harness(page, (h) => h.dockerEmitEvent("container", "exec_die", "shop-web-1", "c1"));
    await page.waitForTimeout(1200);
    assert((await psCount()) === before, "exec_die events cause no docker ps");
    for (let i = 0; i < 5; i++) await harness(page, (h) => h.dockerEmitEvent("container", "start", "shop-web-1", "c1"));
    await waitFor(async () => (await psCount()) === before + 1, "one refresh for a burst of start events");
    await page.waitForTimeout(800);
    assert((await psCount()) === before + 1, "the burst was not refreshed twice");
    assert((await dfCount()) <= 1, "events never rerun system df");

    await page.locator('[data-testid="docker-scope-images"]').click();
    assert((await page.locator('[data-testid="docker-list-row"]').count()) === 4, "4 image rows");
    assert((await page.locator('[data-testid="docker-list-row"]', { hasText: "<none>" }).count()) === 1, "dangling image listed");
    await page.locator('[data-testid="docker-scope-containers"]').click();

    // Not installed.
    await harness(page, (h) => h.dockerFakeSet({ installed: false }));
    await page.locator('[data-testid="docker-refresh"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-sidebar"]').getAttribute("data-state")) === "missing", "missing state");
    assert((await page.locator('[data-testid="docker-sidebar"] [data-testid="docker-state-missing"]').innerText()).includes("not installed"), "explains docker is missing");
    // The main page shows the same state.
    assert((await page.locator('[data-testid="docker-view"] [data-testid="docker-state-missing"]').count()) === 1, "main page state");

    // Daemon down.
    await harness(page, (h) => h.dockerFakeSet({ installed: true, daemon: false }));
    await page.locator('[data-testid="docker-sidebar"] button', { hasText: "Check again" }).click();
    await waitFor(async () => (await page.locator('[data-testid="docker-sidebar"]').getAttribute("data-state")) === "daemon-down", "daemon-down state");
    assert((await page.locator('[data-testid="docker-sidebar"]').innerText()).includes("daemon is not running"), "explains the daemon");

    // Permission denied on the socket: offer sudo -n docker.
    await harness(page, (h) => h.dockerFakeSet({ daemon: true, denied: true }));
    await page.locator('[data-testid="docker-sidebar"] button', { hasText: "Check again" }).click();
    await waitFor(async () => (await page.locator('[data-testid="docker-sidebar"]').getAttribute("data-state")) === "denied", "denied state");
    const txt = await page.locator('[data-testid="docker-sidebar"]').innerText();
    assert(txt.includes("usermod -aG docker"), "explains the docker group");
    await page.locator('[data-testid="docker-sidebar"] [data-testid="docker-use-sudo"]').click();
    await waitReady(page);
    const after = await dockerCalls(page);
    assert(after.some((c) => c.command === "sudo docker"), "retried with sudo docker");
    assert((await count("running")) === 3, "lists load through sudo");
  },
};
