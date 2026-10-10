import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";
import { dockerCalls, harness, openDocker, waitReady } from "../dockerHelpers";

// docs/GUIDE.md §15.3.D: compose project (services, down / up with output, validate + apply),
// the run-image dialog and the prune dialog.
export const scenario: Scenario = {
  name: "docker: compose project, run image dialog, prune dialog",
  async run({ page }) {
    await openDocker(page);
    await waitReady(page);

    // Compose project.
    await page.locator('[data-testid="docker-project-row"]').click();
    await page.locator('[data-testid="docker-project-detail"][data-name="shop"]').waitFor();
    await waitFor(async () => (await page.locator('[data-testid="docker-service"]').count()) === 2, "two services");
    assert((await page.locator('[data-testid="docker-service"][data-service="db"]').innerText()).includes("1/1 running"), "db running");
    await page.locator('[data-testid="docker-compose-down"]').click();
    await page.locator('[data-slot="alert-dialog-action"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-compose-output-text"]').innerText().catch(() => "")).includes("Removed"), "output panel shows the down output");
    await waitFor(async () => (await page.locator('[data-testid="docker-service"][data-service="db"]').innerText()).includes("0/1 running"), "services stopped after down");
    assert((await page.locator('[data-testid="docker-compose-output-text"]').innerText()).includes("Removed"), "down output shown");
    const down = (await dockerCalls(page)).find((c) => c.args[0] === "compose" && c.args.includes("down"))!;
    assert(down.args.join(" ").startsWith("compose -p shop -f /home/testuser/projects/docker-compose.yml"), `compose args (got ${down.args.join(" ")})`);
    await page.locator('[data-testid="docker-compose-up"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-service"][data-service="db"]').innerText()).includes("1/1 running"), "up restarts services");
    assert((await dockerCalls(page)).some((c) => c.args.includes("up") && c.args.includes("-d")), "compose up -d");

    // Aggregated logs use `compose -p`.
    await page.locator('[data-testid="docker-tab-logs"]').click();
    await waitFor(async () => (await harness(page, (h) => h.dockerLogStreams())).some((s) => s.compose && s.target === "shop"), "compose log stream");
    await page.locator('[data-testid="docker-logs"]').waitFor();

    // Compose file: validate (ok, then invalid) and apply.
    await page.locator('[data-testid="docker-tab-files"]').click();
    assert((await page.locator('[data-testid="docker-compose-file"]').innerText()).includes("/home/testuser/projects/docker-compose.yml"), "config file listed");
    await page.locator('[data-testid="docker-compose-validate"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-compose-valid"]').count()) === 1, "valid file");
    await harness(page, (h) => h.dockerFakeSet({ composeInvalid: "yaml: line 7: mapping values are not allowed in this context" }));
    await page.locator('[data-testid="docker-compose-validate"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-compose-invalid"]').count()) === 1, "invalid file");
    assert((await page.locator('[data-testid="docker-compose-invalid"]').innerText()).includes("line 7"), "inline error text");
    const upsBefore = (await dockerCalls(page)).filter((c) => c.args.includes("up")).length;
    await page.locator('[data-testid="docker-compose-apply"]').click();
    await new Promise((r) => setTimeout(r, 300));
    assert((await dockerCalls(page)).filter((c) => c.args.includes("up")).length === upsBefore, "apply refuses an invalid file");
    await harness(page, (h) => h.dockerFakeSet({ composeInvalid: "" }));
    await page.locator('[data-testid="docker-compose-apply"]').click();
    await waitFor(async () => (await dockerCalls(page)).filter((c) => c.args.includes("up")).length === upsBefore + 1, "apply runs up -d after validation");

    // Run an image.
    await page.locator('[data-testid="docker-image-row"][data-ref="nginx:latest"]').click();
    await page.locator('[data-testid="docker-image-detail"]').waitFor();
    await page.locator('[data-testid="docker-tab-history"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-layer"]').count()) === 2, "history layers");
    await page.locator('[data-testid="docker-image-run"]').click();
    await page.locator('[data-testid="docker-run-dialog"]').waitFor();
    assert((await page.locator('[data-testid="docker-run-image"]').inputValue()) === "nginx:latest", "image prefilled");
    await page.locator('[data-testid="docker-run-name"]').fill("web2");
    await page.locator('[data-testid="docker-run-ports"]').fill("9090:80");
    await page.locator('[data-testid="docker-run-env"]').fill("MODE=test");
    const preview = await page.locator('[data-testid="docker-run-preview"]').innerText();
    assert(preview === "docker run -d --name web2 -p 9090:80 -e MODE=test nginx:latest", `preview (got ${preview})`);
    await page.locator('[data-testid="docker-run-go"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-container-row"][data-name="web2"]').count()) === 1, "new container listed");
    const run = (await dockerCalls(page)).find((c) => c.args[0] === "run")!;
    assert(JSON.stringify(run.args) === JSON.stringify(["run", "-d", "--name", "web2", "-p", "9090:80", "-e", "MODE=test", "nginx:latest"]), "run args");
    await waitFor(async () => (await page.locator('[data-testid="docker-detail-title"]').innerText()) === "web2", "new container selected");
    // A failing run keeps the dialog open with the error.
    await page.locator('[data-testid="docker-scope-images"]').click();
    await page.locator('[data-testid="docker-list-row"]', { hasText: "nginx:latest" }).click();
    await page.locator('[data-testid="docker-image-run"]').click();
    await page.locator('[data-testid="docker-run-name"]').fill("web2");
    await page.locator('[data-testid="docker-run-go"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-run-error"]').count()) === 1, "name conflict shown in the dialog");
    assert((await page.locator('[data-testid="docker-run-error"]').innerText()).includes("already in use"), "conflict text");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    // Prune dialog: reclaimable sizes, checkbox driven commands, result.
    await page.locator('[data-testid="docker-prune-open"]').click();
    await page.locator('[data-testid="docker-prune-dialog"]').waitFor();
    const dlg = await page.locator('[data-testid="docker-prune-dialog"]').innerText();
    assert(dlg.includes("55.1MB") && dlg.includes("100MB"), `reclaimable sizes shown (got ${dlg})`);
    assert((await page.locator('[data-testid="docker-prune-preview"]').innerText()).includes("container prune -f"), "default selection");
    await page.locator('[data-testid="docker-prune-containers"]').click();
    await page.locator('[data-testid="docker-prune-networks"]').click();
    const pv = await page.locator('[data-testid="docker-prune-preview"]').innerText();
    assert(pv === "docker image prune -f", `only dangling images (got ${pv})`);
    await page.locator('[data-testid="docker-prune-go"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-prune-result"]').count()) === 1, "prune result");
    assert((await page.locator('[data-testid="docker-prune-result"]').innerText()).includes("Reclaimed"), "reclaimed text");
    assert((await dockerCalls(page)).some((c) => c.args.join(" ") === "image prune -f"), "image prune ran");
    assert(!(await dockerCalls(page)).some((c) => c.args[0] === "volume" && c.args[1] === "prune"), "volumes untouched");
    await page.locator('[data-testid="docker-prune-dialog"] [data-slot="dialog-footer"] button', { hasText: "Close" }).click();
    await waitFor(async () => (await page.locator('[data-testid="docker-count-images"]').innerText()) === "3", "dangling image gone from the list");
  },
};
