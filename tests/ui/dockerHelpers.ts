// Shared helpers for the Docker scenarios 70-72 (tests/ui/mockDocker.ts is the fake CLI).
import type { Page } from "playwright-core";
import { waitFor } from "./scenario";

type H = {
  sessions: () => unknown[];
  dockerCalls: () => { args: string[]; command: string | null; stdin: string | null }[];
  dockerFakeSet: (p: Record<string, unknown>) => void;
  dockerLogStreams: () => { id: string; target: string; compose: boolean; follow: boolean; opts: Record<string, unknown> }[];
  dockerStreams: () => { stats: number; events: number };
  dockerPushLog: (target: string, text: string) => void;
  dockerEmitEvent: (type: string, action: string, name: string, id: string) => void;
  dockerState: () => { name: string; state: string }[];
  setReadFileDelay: (ms: number) => void;
};

export const harness = <T>(page: Page, fn: (h: H) => T, arg?: unknown): Promise<T> =>
  page.evaluate(([src, a]) => {
    const h = (window as unknown as { __harness: H }).__harness;
    return (new Function("h", "a", `return (${src})(h, a)`) as (h: H, a: unknown) => T)(h, a);
  }, [fn.toString(), arg] as const);

export const dockerCalls = (page: Page) => harness(page, (h) => h.dockerCalls());

/** Connects host alpha and opens the Docker view (sidebar + main page). */
export async function openDocker(page: Page): Promise<void> {
  await waitFor(async () => (await page.locator('[data-testid="host-row"]').count()) === 3, "hosts loaded");
  await page.locator('[aria-label="Connect alpha"]').click();
  await waitFor(async () => (await harness(page, (h) => h.sessions().length)) === 1, "connected");
  await page.getByRole("button", { name: "Docker", exact: true }).click();
}

export async function waitReady(page: Page): Promise<void> {
  await waitFor(async () => (await page.locator('[data-testid="docker-sidebar"]').getAttribute("data-state")) === "ready", "docker ready", 15000);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
