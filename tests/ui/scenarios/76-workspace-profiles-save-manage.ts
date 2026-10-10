import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";

// docs/GUIDE.md §15.3.P: workspace profiles. Save the running workspace as a profile (Hosts
// sidebar section), see it listed, rename, duplicate, reorder, set "open at startup", delete,
// and check the stored file holds references only (no secrets) and the palette commands exist.
export const scenario: Scenario = {
  name: "Workspace profiles: save current, list, rename, duplicate, reorder, startup flag, delete",
  async run({ page }) {
    await page.evaluate(() => window.__harness.setReadFileDelay(0));
    await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");

    // Nothing connected: the Save button is disabled, the empty hint is shown.
    assert((await page.getByTestId("profiles-empty").count()) === 1, "empty hint in the Hosts view");
    assert(await page.getByTestId("profiles-save").isDisabled(), "Save is disabled without a connection");

    await page.locator('[aria-label="Connect alpha"]').click();
    await waitFor(async () => (await page.evaluate(() => window.__harness.sessions().length)) === 1, "connected");
    const readme = page.locator('[data-path="/home/testuser/readme.txt"]');
    await waitFor(async () => (await readme.count()) === 1, "tree rendered");
    await readme.click();
    await waitFor(async () => (await page.locator('[role="tab"][title="/home/testuser/readme.txt"]').count()) === 1, "file open");

    await page.getByRole("button", { name: "Hosts" }).click();
    await waitFor(async () => (await page.getByTestId("profiles-section").count()) === 1, "section back");
    await waitFor(async () => !(await page.getByTestId("profiles-save").isDisabled()), "Save enabled once connected");

    // --- save current ----------------------------------------------------------------------
    await page.getByTestId("profiles-save").click();
    await waitFor(async () => (await page.getByTestId("profile-save-dialog").count()) === 1, "save dialog");
    const preview = await page.getByTestId("profile-save-preview").innerText();
    assert(/1 host/.test(preview) && /1 file/.test(preview), `preview summarises the workspace (${preview})`);
    await page.getByTestId("profile-save-name").fill("Dev stack");
    await page.getByTestId("profile-icon-rocket").click();
    await page.getByTestId("profile-color").first().click();
    await page.getByTestId("profile-save-submit").click();
    await waitFor(async () => (await page.locator('[data-testid="profile-row"][data-name="Dev stack"]').count()) === 1, "profile listed");

    await waitFor(async () => {
      const f = (await page.evaluate(() => window.__harness.getStore("workspaces"))) as { profiles?: unknown[] } | null;
      return (f?.profiles?.length ?? 0) === 1;
    }, "profile persisted in the workspaces store");
    const file = (await page.evaluate(() => window.__harness.getStore("workspaces"))) as {
      profiles: { icon: string; color: string; hosts: { ref: { key: string }; files: { path: string }[]; explorer: { panes: { cwd: string }[] } }[] }[];
    };
    const p0 = file.profiles[0];
    assert(p0.icon === "rocket" && /^#[0-9a-f]{6}$/.test(p0.color), "icon and colour stored");
    assert(p0.hosts[0].ref.key === "config:alpha", "host stored as a reference to the ssh-config host");
    assert(p0.hosts[0].files[0].path === "/home/testuser/readme.txt", "open file stored");
    assert(p0.hosts[0].explorer.panes[0].cwd === "/home/testuser", "explorer root stored");
    assert(!/password|passphrase|"content"|Hello from/i.test(JSON.stringify(file)), "no secrets or file contents in the store");

    // --- palette commands -----------------------------------------------------------------------
    await page.keyboard.press("Control+Shift+P");
    await waitFor(async () => (await page.locator('[data-slot="command-input"]').count()) === 1, "palette open");
    await page.locator('[data-slot="command-input"]').fill("Workspace Profiles");
    await waitFor(async () => (await page.locator('[data-slot="command-item"]').count()) === 3, "three profile commands");
    const titles = await page.locator('[data-slot="command-item"]').allInnerTexts();
    assert(
      ["Open", "Save Current", "Manage"].every((t) => titles.some((x) => x.includes(`Workspace Profiles: ${t}`))),
      `palette commands: ${titles.join(" | ")}`,
    );
    await page.locator('[data-slot="command-item"]', { hasText: "Workspace Profiles: Open" }).click();
    await waitFor(async () => (await page.getByTestId("profile-picker").count()) === 1, "quick picker opened from the palette");
    assert((await page.getByTestId("profile-picker-item").count()) === 1, "picker lists the profile");
    assert((await page.getByTestId("profile-picker-backdrop").evaluate((el) => getComputedStyle(el).backdropFilter)).includes("blur"), "blurred backdrop");
    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.getByTestId("profile-picker").count()) === 0, "picker closed with Esc");

    // --- manage: rename, duplicate, reorder, startup, delete ---------------------------------------
    await page.getByTestId("profiles-manage").click();
    await waitFor(async () => (await page.getByTestId("profile-manage-dialog").count()) === 1, "manage dialog");
    const rows = page.getByTestId("profile-manage-row");
    await page.getByTestId("profile-rename").click();
    await page.getByTestId("profile-rename-input").fill("Production");
    await page.getByTestId("profile-rename-input").press("Enter");
    await waitFor(async () => (await page.locator('[data-testid="profile-manage-row"][data-name="Production"]').count()) === 1, "renamed in the dialog");
    await waitFor(async () => (await page.locator('[data-testid="profile-row"][data-name="Production"]').count()) === 1, "renamed in the sidebar");

    await page.getByTestId("profile-duplicate").click();
    await waitFor(async () => (await rows.count()) === 2, "duplicated");
    assert((await rows.nth(1).getAttribute("data-name")) === "Production copy", "copy gets a unique name");
    await rows.nth(1).getByTestId("profile-up").click();
    await waitFor(async () => (await rows.nth(0).getAttribute("data-name")) === "Production copy", "moved up");
    await rows.nth(0).getByTestId("profile-startup").click();
    await waitFor(async () => {
      const f = (await page.evaluate(() => window.__harness.getStore("workspaces"))) as { startupId: string | null; profiles: { name: string; id: string }[] };
      return f.startupId !== null && f.profiles.find((p) => p.id === f.startupId)?.name === "Production copy" && f.profiles[0].name === "Production copy";
    }, "startup flag and order persisted");

    await rows.nth(0).getByTestId("profile-delete").click();
    await page.locator('[role="alertdialog"]').getByRole("button", { name: "Delete" }).click();
    await waitFor(async () => (await rows.count()) === 1, "deleted");
    assert((await rows.first().getAttribute("data-name")) === "Production", "the other profile is left");
    await waitFor(async () => {
      const f = (await page.evaluate(() => window.__harness.getStore("workspaces"))) as { startupId: string | null; profiles: unknown[] };
      return f.startupId === null && f.profiles.length === 1;
    }, "deleting the startup profile clears the flag");

    await page.keyboard.press("Escape");
    await waitFor(async () => (await page.getByTestId("profile-manage-dialog").count()) === 0, "dialog closed");
  },
};
