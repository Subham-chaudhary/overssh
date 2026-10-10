import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// Services tab (§15.3.V): list, chips + search + enabled filter, failed badge, sorting,
// odd unit names, details drawer (properties, unit file, journal tail, dependencies, timers),
// huge list windowing, narrow width.
export const scenario: Scenario = {
  name: "services tab: list, filters, failed badge, sort, details + journal, huge list, responsive",
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "1 session");
    await page.getByRole("button", { name: "Dashboard" }).click();

    // The failed-count badge is on the tab before the tab is opened.
    await waitFor(async () => (await page.locator('[data-testid="svc-failed-badge"]').count()) === 1, "failed badge");
    assert((await page.locator('[data-testid="svc-failed-badge"]').innerText()) === "1", "badge counts 1 failed unit");
    const tabs = (await page.locator('[data-testid="monitor-tabs"] [role="tab"]').allInnerTexts()).map((s) => s.replace(/\d+$/, ""));
    assert(tabs.join("|") === "Overview|htop|Services|Disk usage|Cron", `tab order, got ${tabs.join("|")}`);

    await page.locator('[data-testid="monitor-tab-services"]').click();
    // 7 listed units + 2 unit-file-only services (templates are not rows)
    await waitFor(async () => (await page.locator('[data-testid="svc-row"]').count()) === 9, "9 rows");
    const rowUnits = () =>
      page.locator('[data-testid="svc-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-unit")));
    const first = (await rowUnits())[0];
    assert(first === "broken-job.service", `failed unit sorts first, got ${first}`);
    assert((await page.locator('[data-testid="svc-row"][data-failed="1"]').count()) === 1, "one failed row highlighted");

    // chips and counts
    const count = async (id: string) => Number(await page.locator(`[data-testid="svc-count-${id}"]`).innerText());
    assert((await count("all")) === 9 && (await count("running")) === 3 && (await count("failed")) === 1 && (await count("inactive")) === 4, "chip counts");
    await page.locator('[data-testid="svc-chip-failed"]').click();
    await waitFor(async () => (await page.locator('[data-testid="svc-row"]').count()) === 1, "failed filter");
    await page.locator('[data-testid="svc-chip-running"]').click();
    await waitFor(async () => (await page.locator('[data-testid="svc-row"]').count()) === 3, "running filter");
    await page.locator('[data-testid="svc-chip-all"]').click();

    // search with `|` = OR, then Escape clears
    await page.keyboard.press("/");
    await waitFor(
      async () => (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "svc-filter",
      "/ focuses the filter",
    );
    await page.keyboard.type("nginx|backup");
    await waitFor(async () => (await page.locator('[data-testid="svc-row"]').count()) === 2, "search narrows to 2");
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.locator('[data-testid="svc-row"]').count()) === 9, "Escape clears the search");

    // enabled filter
    await page.locator('[data-testid="svc-enabled-filter"]').click();
    await page.getByRole("option", { name: "Masked" }).click();
    await waitFor(async () => (await page.locator('[data-testid="svc-row"]').count()) === 1, "masked filter");
    assert((await rowUnits())[0] === "masked-one.service", "masked unit shown");
    await page.locator('[data-testid="svc-enabled-filter"]').click();
    await page.getByRole("option", { name: "Any enablement" }).click();
    await waitFor(async () => (await page.locator('[data-testid="svc-row"]').count()) === 9, "enabled filter reset");

    // memory column: sort by Mem descending -> nginx (52M) first
    await page.locator('th[data-col="memory"]').click();
    await waitFor(async () => (await rowUnits())[0] === "nginx.service", "sorted by memory desc");
    assert(((await page.locator('[data-testid="svc-row"][data-unit="nginx.service"]').innerText()) || "").includes("52"), "memory shown");
    await page.locator('th[data-col="unit"]').click();
    await waitFor(async () => (await rowUnits())[0] === "backup.service", "sorted by unit");

    // odd names: an escaped instance unit is listed and shows its unescaped name in the drawer
    await page.keyboard.press("/");
    await page.keyboard.type("fsck");
    await waitFor(async () => (await page.locator('[data-testid="svc-row"]').count()) === 1, "fsck row");
    await page.locator('[data-testid="svc-row"]').first().dblclick();
    await page.locator('[data-testid="svc-details"]').waitFor();
    assert(
      (await page.locator('[data-testid="svc-details"]').innerText()).includes("systemd-fsck@dev-disk-by-uuid-ABCD.service"),
      "unescaped name shown",
    );
    await page.locator('[data-testid="svc-close"]').click();
    await page.locator('[data-testid="svc-filter"]').fill("");

    // keyboard: arrows select, Enter opens details
    await page.locator('[data-testid="svc-table"]').click({ position: { x: 5, y: 5 } });
    await page.locator('[data-testid="services-view"]').focus();
    await page.keyboard.press("Home");
    const selected = () =>
      page.locator('[data-testid="svc-row"][data-selected="1"]').first().getAttribute("data-unit");
    assert((await selected()) === (await rowUnits())[0], "Home selects the first row");
    await page.locator('[data-testid="svc-row"][data-unit="ssh.service"]').click();
    await page.keyboard.press("Enter");
    await page.locator('[data-testid="svc-details"][data-unit="ssh.service"]').waitFor();
    await waitFor(async () => (await page.locator('[data-prop="MainPID"]').count()) === 1, "properties loaded");
    assert((await page.locator('[data-prop="MemoryCurrent"]').innerText()).includes("52"), "memory property formatted");
    assert((await page.locator('[data-prop="ExecStart"]').innerText()).startsWith("/usr/sbin/nginx"), "ExecStart shows argv");

    // unit file
    await page.locator('[data-testid="svc-dtab-file"]').click();
    await waitFor(async () => (await page.locator('[data-testid="svc-file-text"]').innerText()).includes("[Service]"), "unit file text");

    // journal: streams through logs_open (kind journal), follow is on, lines appear
    await page.locator('[data-testid="svc-dtab-journal"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.logStreams().length)) === 1, "journal stream opened");
    const stream = await page.evaluate(() => window.__harness.logStreams()[0]);
    const src = stream.source as { kind: string; unit: string };
    assert(src.kind === "journal" && src.unit === "ssh.service", `journal source ${JSON.stringify(src)}`);
    await page.evaluate(
      (id) =>
        window.__harness.emit("logs://data", {
          streamId: id,
          lines: ["2024-01-01T10:00:00+0000 host sshd[1]: Server listening", "2024-01-01T10:00:01+0000 host sshd[1]: error: bad key"],
        }),
      stream.id,
    );
    await waitFor(async () => (await page.locator('[data-testid="svc-journal-lines"] > div').count()) === 2, "2 journal lines");
    assert((await page.locator('[data-testid="svc-journal-follow"]').getAttribute("aria-pressed")) === "true", "follow on");
    await page.locator('[data-testid="svc-journal-filter"]').fill("listening");
    await waitFor(async () => (await page.locator('[data-testid="svc-journal-lines"] > div').count()) === 1, "journal filter");
    await page.locator('[data-testid="svc-journal-filter"]').fill("");
    await page.evaluate((id) => window.__harness.emit("logs://end", { streamId: id, code: null }), stream.id);
    await waitFor(async () => (await page.locator('[data-testid="svc-journal-status"]').innerText()).includes("closed"), "stream end shown");

    // dependencies: tree parsed, click navigates to a listed unit's name
    await page.locator('[data-testid="svc-dtab-deps"]').click();
    await waitFor(async () => (await page.locator('[data-testid="svc-deps"] li').count()) === 5, "5 dependency rows");
    await page.locator('[data-testid="svc-deps-rev"]').click();
    await waitFor(async () => (await page.locator('[data-testid="svc-deps"] li').count()) === 2, "reverse deps");

    // timers tab of a unit with a timer
    await page.locator('[data-testid="svc-close"]').click();
    await page.locator('[data-testid="svc-row"][data-unit="backup.service"]').click();
    await page.keyboard.press("Enter");
    await page.locator('[data-testid="svc-dtab-timers"]').click();
    await waitFor(async () => (await page.locator('[data-testid="svc-timers"] li').count()) === 1, "timer for backup.service");
    assert((await page.locator('[data-testid="svc-timers"]').innerText()).includes("backup.timer"), "timer name shown");
    await page.keyboard.press("Escape");

    // Timers list view
    await page.locator('[data-testid="svc-mode-timers"]').click();
    await waitFor(async () => (await page.locator('[data-testid="svc-timer-row"]').count()) === 2, "2 timers listed");
    await page.locator('[data-testid="svc-mode-services"]').click();

    // user scope uses its own list
    await page.locator('[data-testid="svc-scope-user"]').click();
    await waitFor(async () => (await page.locator('[data-testid="svc-row"]').count()) === 1, "user scope: 1 unit");
    assert((await rowUnits())[0] === "pipewire.service", "user unit listed");
    const lastList = await page.evaluate(() => window.__systemd.calls().filter((c) => c.cmd === "systemd_list").at(-1));
    assert(lastList?.args.user === true, "list requested with user=true");
    await page.locator('[data-testid="svc-scope-system"]').click();
    await waitFor(async () => (await page.locator('[data-testid="svc-row"]').count()) === 9, "back to system scope");

    // huge list: only a window of rows is rendered
    await page.evaluate(() => window.__systemd.set({ big: true }));
    await page.locator('[data-testid="svc-refresh"]').click();
    await waitFor(async () => (await page.locator('[data-testid="svc-count"]').innerText()).includes("1509"), "1509 units");
    const rendered = await page.locator('[data-testid="svc-row"]').count();
    assert(rendered > 0 && rendered < 120, `windowed rows, got ${rendered}`);
    await page.evaluate(() => window.__systemd.set({ big: false }));

    // narrow: no horizontal overflow of the table box, columns drop out
    await page.setViewportSize({ width: 720, height: 560 });
    await page.locator('[data-testid="svc-refresh"]').click();
    await waitFor(async () => (await page.locator('[data-testid="svc-count"]').innerText()).includes("9 of 9"), "back to 9 units");
    const over = await page.locator('[data-testid="svc-table"]').evaluate((el) => el.scrollWidth - el.clientWidth);
    assert(over <= 1, `table does not overflow at 720px (${over})`);
    assert((await page.locator('th[data-col="cpu"]').count()) === 0 || (await page.locator('[data-testid="svc-table"]').evaluate((el) => el.clientWidth)) >= 600, "cpu column hides when narrow");
  },
};
