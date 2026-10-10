import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";
import { dockerCalls, harness, openDocker, waitReady } from "../dockerHelpers";

// docs/GUIDE.md §15.3.D follow-up: container file browser (ls through docker exec, busybox
// fallback, read-only viewer, binary refusal), download and copy-into-container via VM temp dirs.
export const scenario: Scenario = {
  name: "docker: browse container files, view read-only, busybox fallback, download and upload",
  async run({ page }) {
    await openDocker(page);
    await waitReady(page);
    await page.locator('[data-testid="docker-container-row"][data-name="shop-web-1"]').click();
    await page.locator('[data-testid="docker-tab-files"]').click();
    await page.locator('[data-testid="docker-files"]').waitFor();
    await waitFor(async () => (await page.locator('[data-testid="docker-fs-row"]').count()) === 4, "root listing");
    const names = await page.locator('[data-testid="docker-fs-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-name")));
    assert(JSON.stringify(names) === JSON.stringify(["app", "etc", "bin", "hello.txt"]), `dirs first, then files (got ${names})`);
    const first = (await dockerCalls(page)).find((c) => c.args[0] === "exec" && c.args.includes("ls"))!;
    assert(first.args.includes("--time-style=+%s") && first.args[first.args.length - 1] === "/", "ls with epoch dates");
    assert((await page.locator('[data-testid="docker-fs-row"][data-name="bin"]').innerText()).includes("usr/bin"), "symlink target shown");

    // Navigate into etc, view a text file read-only, refuse a binary one.
    await page.locator('[data-testid="docker-fs-row"][data-name="etc"] button').first().click();
    await waitFor(async () => (await page.locator('[data-testid="docker-files-path"]').inputValue()) === "/etc", "navigated to /etc");
    await page.locator('[data-testid="docker-fs-row"][data-name="hosts"]').hover();
    await page.locator('[data-testid="docker-fs-row"][data-name="hosts"] [data-testid="docker-fs-view"]').click();
    await page.locator('[data-testid="docker-file-viewer"]').waitFor();
    assert((await page.locator('[data-testid="docker-file-path"]').innerText()) === "/etc/hosts", "viewer path");
    await waitFor(async () => (await page.getByText("127.0.0.1 localhost").count()) > 0, "file content rendered", 15000);
    const head = (await dockerCalls(page)).find((c) => c.args.includes("head"))!;
    assert(head.args.slice(0, 2).join(" ") === `exec ${head.args[1]}` && head.args.includes("-c") && head.args[head.args.length - 1] === "/etc/hosts", "head -c <cap> path");
    await page.locator('[data-testid="docker-file-back"]').click();
    await page.locator('[data-testid="docker-fs-row"][data-name="blob.bin"]').hover();
    await page.locator('[data-testid="docker-fs-row"][data-name="blob.bin"] [data-testid="docker-fs-view"]').click();
    await waitFor(async () => (await page.getByText(/looks binary/).count()) > 0, "binary file refused with a toast");
    assert((await page.locator('[data-testid="docker-file-viewer"]').count()) === 0, "no viewer for binary");

    // Bind-mounted host folders are offered as quick links.
    await page.locator('[data-testid="docker-files-up"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-files-hostmount"]').count()) === 1, "host mount chip");

    // busybox ls has no --time-style: the panel retries with plain ls -la.
    await harness(page, (h) => h.dockerFakeSet({ busybox: true }));
    await page.locator('[data-testid="docker-files-path"]').fill("/app");
    await page.locator('[data-testid="docker-files-path"]').press("Enter");
    await waitFor(async () => (await page.locator('[data-testid="docker-fs-row"][data-name="main.py"]').count()) === 1, "listing via fallback");
    const lsCalls = (await dockerCalls(page)).filter((c) => c.args.includes("ls") && c.args[c.args.length - 1] === "/app/");
    assert(lsCalls.length === 2 && lsCalls[1].args.every((a) => !a.startsWith("--time-style")), "retried without --time-style");
    await page.locator('[data-testid="docker-files-path"]').fill("/nope");
    await page.locator('[data-testid="docker-files-path"]').press("Enter");
    await waitFor(async () => (await page.locator('[data-testid="docker-files-error"]').count()) === 1, "listing error shown");

    // Download goes through a VM temp dir: docker cp <id>:<path> /tmp/overssh-docker-*/
    await page.locator('[data-testid="docker-files-path"]').fill("/etc");
    await page.locator('[data-testid="docker-files-path"]').press("Enter");
    await waitFor(async () => (await page.locator('[data-testid="docker-fs-row"][data-name="hosts"]').count()) === 1, "back in /etc");
    await page.evaluate(() => (window as unknown as { __harness: { setDialogResult: (v: unknown) => void } }).__harness.setDialogResult("C:/Users/x/hosts"));
    await page.locator('[data-testid="docker-fs-row"][data-name="hosts"]').hover();
    await page.locator('[data-testid="docker-fs-row"][data-name="hosts"] [data-testid="docker-fs-download"]').click();
    await waitFor(async () => (await dockerCalls(page)).some((c) => c.args[0] === "cp"), "docker cp ran");
    const cp = (await dockerCalls(page)).find((c) => c.args[0] === "cp")!;
    assert(/^[0-9a-f]{64}:\/etc\/hosts$/.test(cp.args[1]) && /^\/tmp\/overssh-docker-[0-9a-f]{8}\/$/.test(cp.args[2]), `cp args (got ${cp.args.join(" ")})`);

    // Upload: local file -> VM temp dir -> docker cp <tmp>/uploaded <id>:/etc/
    await page.locator('[data-testid="docker-files-upload"]').click();
    await waitFor(async () => (await dockerCalls(page)).filter((c) => c.args[0] === "cp").length === 2, "second docker cp (upload)");
    const up = (await dockerCalls(page)).filter((c) => c.args[0] === "cp")[1];
    assert(/^\/tmp\/overssh-docker-[0-9a-f]{8}\/uploaded$/.test(up.args[1]) && /^[0-9a-f]{64}:\/etc\/$/.test(up.args[2]), `upload cp args (got ${up.args.join(" ")})`);
  },
};
