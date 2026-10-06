import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §13.4.P: ConnectDialog shows a "Proxy jump (-J)" field prefilled
// from ssh config, sends the override on connect, and a jump hop's password
// prompt names the hop and is answered under `jumpAuth[hop]`.
export const scenario: Scenario = {
  name: "ConnectDialog: proxy jump field is prefilled, editable and sent; hop prompts are per hop",
  async beforeLoad({ page }) {
    await page.addInitScript(() => {
      window.__HARNESS_EXTRA_HOSTS__ = [
        { alias: "inner", hostname: "10.0.0.5", user: "ops", port: 22, identityFiles: [], proxyJump: "bastion" },
      ];
    });
  },
  async run({ page }) {
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 4, "4 hosts incl. inner");
    const hint = page.locator('[data-testid="host-row"][data-alias="inner"] [data-testid="via-hint"]');
    assert(((await hint.textContent()) ?? "").includes("bastion"), "via-bastion hint in the host list");

    const lastReq = () => page.evaluate(() => window.__harness.connectRequests().at(-1));
    const reqCount = () => page.evaluate(() => window.__harness.connectRequests().length);
    const connectBtn = page.getByRole("button", { name: "Connect", exact: true });

    // 1. Prefilled from config, unchanged -> sent as-is.
    await page.locator('[data-testid="host-row"][data-alias="inner"] button').first().click();
    const jump = page.locator("#cf-jump");
    await waitFor(async () => (await jump.count()) === 1, "dialog open");
    assert((await jump.inputValue()) === "bastion", "prefilled from ssh config");
    await connectBtn.click();
    await waitFor(async () => (await reqCount()) === 1, "connect #1");
    assert((await lastReq())?.proxyJump === "bastion", "proxyJump sent");

    // 2. Typed chain on a host without one.
    await page.getByRole("button", { name: "Hosts" }).click();
    await page.locator('[data-testid="host-row"][data-alias="alpha"] button').first().click();
    await waitFor(async () => (await jump.count()) === 1, "dialog open (alpha)");
    assert((await jump.inputValue()) === "", "empty when config has none");
    await jump.fill("a,b@jump:2222");
    await connectBtn.click();
    await waitFor(async () => (await reqCount()) === 2, "connect #2");
    assert((await lastReq())?.proxyJump === "a,b@jump:2222", "typed chain sent");

    // 3. Clearing a config-provided jump -> explicit "none".
    await page.getByRole("button", { name: "Hosts" }).click();
    await page.locator('[data-testid="host-row"][data-alias="inner"] button').first().click();
    await waitFor(async () => (await jump.count()) === 1, "dialog open (inner again)");
    await jump.fill("");
    await connectBtn.click();
    await waitFor(async () => (await reqCount()) === 3, "connect #3");
    assert((await lastReq())?.proxyJump === "none", "cleared jump sent as none");

    // 4. A hop's password prompt names the hop; the answer goes under jumpAuth[hop].
    await page.getByRole("button", { name: "Hosts" }).click();
    await page.evaluate(() =>
      window.__harness.failNextConnect({
        kind: "NeedPassword",
        message: "Password required for u@bastion (jump host)",
        hop: "u@bastion:22",
      }),
    );
    await page.locator('[aria-label="Connect beta"]').click();
    const hop = page.locator('[data-testid="prompt-hop"]');
    await waitFor(async () => (await hop.count()) >= 1, "hop prompt shown");
    assert(((await hop.first().textContent()) ?? "").includes("u@bastion:22"), "prompt names the hop");
    const pw = page.getByPlaceholder("Password");
    await pw.fill("hunter2");
    await pw.press("Enter");
    await waitFor(async () => (await reqCount()) === 5, "retry sent");
    const retry = await lastReq();
    assert(retry?.jumpAuth?.["u@bastion:22"]?.password === "hunter2", "password stored under the hop");
    assert(retry?.password === undefined, "target password untouched");
  },
};
