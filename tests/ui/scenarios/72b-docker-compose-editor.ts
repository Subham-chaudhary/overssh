import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";
import { dockerCalls, harness, openDocker, waitReady } from "../dockerHelpers";

// docs/GUIDE.md §15.3.D follow-up: open a compose file in the Monaco editor from its project,
// save it, get the "Apply (docker compose up -d)" offer, and see validation errors inline.
const FILE = "/home/testuser/projects/docker-compose.yml";

export const scenario: Scenario = {
  name: "docker: compose file opens in the editor, save offers Apply, validate shows errors",
  async run({ page }) {
    await page.evaluate(([p]) => {
      const h = (window as unknown as { __harness: { setReadFileDelay: (n: number) => void; touchRemote: (p: string, c: string) => void } }).__harness;
      h.setReadFileDelay(0);
      h.touchRemote(p, "services:\n  web:\n    image: nginx\n");
    }, [FILE]);
    await openDocker(page);
    await waitReady(page);
    await page.locator('[data-testid="docker-project-row"]').click();
    await page.locator('[data-testid="docker-tab-files"]').click();

    // Open in the editor: the explorer view comes up with the file in a tab (YAML).
    await page.locator('[data-testid="docker-compose-open"]').click();
    await waitFor(async () => (await page.locator(`[role="tablist"][aria-label="Open files"] [role="tab"][title="${FILE}"]`).count()) === 1, "compose file tab", 15000);
    await waitFor(async () => (await page.getByText("image: nginx").count()) > 0, "file content in Monaco", 15000);

    // Edit and save: a toast offers Apply.
    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("  # edited");
    await page.keyboard.press("Control+S");
    const apply = page.getByRole("button", { name: /Apply \(docker compose up -d\)/ });
    await waitFor(async () => (await apply.count()) > 0, "apply offer after save", 10000);
    const upsBefore = (await dockerCalls(page)).filter((c) => c.args.includes("up")).length;

    // Apply = validate (config -q) then up -d, and the Docker page shows the output.
    await apply.first().click();
    await waitFor(async () => (await dockerCalls(page)).filter((c) => c.args.includes("up")).length === upsBefore + 1, "up -d ran");
    const calls = await dockerCalls(page);
    assert(calls.some((c) => c.args.includes("config") && c.args.includes("-q")), "validated before applying");
    await page.locator('[data-testid="docker-project-detail"][data-name="shop"]').waitFor();
    await waitFor(async () => (await page.locator('[data-testid="docker-compose-output-text"]').innerText()).includes("Started"), "output panel shows the up output");

    // Invalid file: Validate shows the error inline with the line number, Apply refuses.
    await harness(page, (h) => h.dockerFakeSet({ composeInvalid: "yaml: line 3: did not find expected key" }));
    await page.locator('[data-testid="docker-tab-files"]').click();
    await page.locator('[data-testid="docker-compose-validate"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-compose-invalid"]').count()) === 1, "inline error");
    assert((await page.locator('[data-testid="docker-compose-invalid"]').innerText()).includes("line 3"), "line number in the message");
  },
};
