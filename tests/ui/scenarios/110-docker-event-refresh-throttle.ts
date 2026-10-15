import type { Scenario } from "../scenario";
import { assert, waitFor } from "../scenario";
import { dockerCalls, harness, openDocker, waitReady, sleep } from "../dockerHelpers";

// docs/GUIDE.md §17.2: after one event-driven refresh, the next waits for `refreshGap` (at least 2 s
// after the previous refresh ended). A steady trickle of real events (one every 0.6 s) must not
// make `docker ps` run every 0.35 s.
export const scenario: Scenario = {
  name: "docker: event-driven refreshes are throttled to refreshGap",
  async run({ page }) {
    await openDocker(page);
    await waitReady(page);
    await waitFor(async () => (await harness(page, (h) => h.dockerStreams().events)) >= 1, "events stream started");
    const psCount = async () => (await dockerCalls(page)).filter((c) => c.args[0] === "ps").length;
    await sleep(2300); // let the open-time refresh age past the gap
    const t0 = await psCount();
    await harness(page, (h) => h.dockerEmitEvent("container", "start", "solo", "c3"));
    await waitFor(async () => (await psCount()) === t0 + 1, "first event refreshes after the batch delay");
    // Second event 0.6 s later: the refresh must wait until ~2 s after the previous one ended.
    await sleep(600);
    await harness(page, (h) => h.dockerEmitEvent("container", "stop", "solo", "c3"));
    await sleep(900);
    assert((await psCount()) === t0 + 1, "no second docker ps within the 2 s gap");
    await waitFor(async () => (await psCount()) === t0 + 2, "second refresh runs after the gap", 6000);
  },
};
