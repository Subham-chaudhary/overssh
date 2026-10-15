import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";
import { harness, openDocker, waitReady } from "../dockerHelpers";

// Several tags of one image share an image ID (`docker images` prints one row per image). The main
// page list keyed its rows by the ID, so the duplicate keys broke the list.
export const scenario: Scenario = {
  name: "docker: images sharing an ID get one row; Run dialog keeps commas in values",
  async run({ page }) {
    await harness(page, (h) =>
      h.dockerFakeSet({
        images: [
          { id: "a1a1a1a1a1a1", repo: "nginx", tag: "latest", size: "187MB" },
          { id: "a1a1a1a1a1a1", repo: "nginx", tag: "1.25", size: "187MB" },
          { id: "b2b2b2b2b2b2", repo: "postgres", tag: "16", size: "432MB" },
        ],
      }),
    );
    await openDocker(page);
    await waitReady(page);
    await page.locator('[data-testid="docker-scope-images"]').click();
    await waitFor(async () => (await page.locator('[data-testid="docker-list-row"]').count()) === 2, "2 image rows (one per image)");
    const text = await page.locator('[data-testid="docker-list"]').innerText().catch(() => "");
    const rows = await page.locator('[data-testid="docker-list-row"]').allInnerTexts();
    assert(rows.some((r) => r.includes("nginx:latest") && r.includes("nginx:1.25")), `the nginx row names both tags (got ${JSON.stringify(rows)} ${text})`);

    // The Run dialog keeps commas inside values: one entry per line, not per comma.
    await page.locator('[data-testid="docker-list-row"]', { hasText: "postgres" }).click();
    await page.locator('[data-testid="docker-image-run"]').click();
    await page.locator('[data-testid="docker-run-dialog"]').waitFor();
    await page.locator('[data-testid="docker-run-env"]').fill("ALLOWED=a.com,b.com\nMODE=test");
    await page.locator('[data-testid="docker-run-volumes"]').fill("/srv/data:/data:ro,z");
    const preview = await page.locator('[data-testid="docker-run-preview"]').innerText();
    assert(preview.includes("-e ALLOWED=a.com,b.com") && preview.includes("-e MODE=test"), `env keeps its commas (got ${preview})`);
    assert(preview.includes("-v /srv/data:/data:ro,z") && !preview.includes("-e b.com") && !preview.includes("-v z"), `volume keeps its options (got ${preview})`);
  },
};
