<script lang="ts">
  // System page: engine info, `docker system df` cards with reclaimable space, pull, prune.
  import { dockerStore } from "$lib/docker/docker.svelte";
  import { formatBytes } from "$lib/docker/parse";
  import { Button } from "$lib/components/ui/button/index.js";
  import BroomIcon from "@lucide/svelte/icons/broom";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";

  const d = $derived(dockerStore.cur);
  const info = $derived(d.info);
  let pullRef = $state("");
  const busy = $derived(dockerStore.busy["system"] || dockerStore.busy["pull"]);

  const totalSize = $derived(d.df.reduce((a, r) => a + r.size, 0));
  const totalReclaim = $derived(d.df.reduce((a, r) => a + r.reclaimable, 0));

  async function pull(): Promise<void> {
    const ref = pullRef.trim();
    if (!ref) return;
    const out = await dockerStore.act("pull", `Pulled ${ref}`, ["pull", ref], { refresh: ["images", "df"] });
    if (out) pullRef = "";
  }
</script>

<div class="h-full overflow-auto p-3" data-testid="docker-system">
  <div class="mb-3 flex items-center gap-2">
    <h2 class="text-sm font-semibold">System</h2>
    <Button size="sm" variant="ghost" class="h-7 gap-1 px-2 text-[12px]" onclick={() => dockerStore.refresh(undefined, ["df"])}><RefreshCwIcon class="size-3.5" /> Refresh usage</Button>
    <Button size="sm" variant="outline" class="ml-auto h-7 gap-1 px-2 text-[12px]" disabled={!!busy} data-testid="docker-system-prune" onclick={() => (dockerStore.pruneOpen = true)}><BroomIcon class="size-3.5" /> Prune…</Button>
  </div>

  {#if info}
    <dl class="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[12px]" data-testid="docker-system-info">
      <dt class="text-muted-foreground">Engine</dt><dd>{info.engine} {info.version}{info.rootless ? " (rootless)" : ""}</dd>
      {#if info.os}<dt class="text-muted-foreground">Host OS</dt><dd>{info.os}</dd>{/if}
      <dt class="text-muted-foreground">Containers</dt><dd>{info.running} running of {info.containers}</dd>
      <dt class="text-muted-foreground">Images</dt><dd>{info.images}</dd>
      <dt class="text-muted-foreground">Compose</dt><dd>{info.composeVersion ?? "plugin not found (projects are read from container labels)"}</dd>
    </dl>
  {/if}

  <div class="grid gap-2 @lg/main:grid-cols-2" data-testid="docker-df">
    {#each d.df as r (r.type)}
      <section class="rounded-md border border-border p-2" data-testid="docker-df-card" data-type={r.type}>
        <div class="flex items-baseline justify-between"><span class="text-[11px] font-semibold text-muted-foreground uppercase">{r.type}</span><span class="font-mono text-sm">{r.sizeText}</span></div>
        <div class="mt-1 h-1.5 rounded-full bg-muted"><div class="h-full rounded-full bg-chart-1" style={`width:${Math.max(0, Math.min(100, 100 - r.percent))}%`}></div></div>
        <div class="mt-1 flex justify-between text-[11px] text-muted-foreground"><span>{r.active} active of {r.total}</span><span>{r.reclaimableText} reclaimable ({r.percent}%)</span></div>
      </section>
    {/each}
  </div>
  {#if d.df.length === 0}
    <p class="text-muted-foreground">No usage data yet.</p>
  {:else}
    <p class="mt-2 text-[11px] text-muted-foreground" data-testid="docker-df-total">Total {formatBytes(totalSize)} · about {formatBytes(totalReclaim)} reclaimable</p>
  {/if}

  <h3 class="mt-5 mb-1 text-[11px] font-semibold text-muted-foreground uppercase">Pull an image</h3>
  <form class="flex max-w-md gap-2" onsubmit={(e) => { e.preventDefault(); void pull(); }}>
    <input class="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50" placeholder="nginx:latest" data-testid="docker-pull-input" bind:value={pullRef} />
    <Button type="submit" size="sm" class="h-8 gap-1 px-3 text-[12px]" disabled={!pullRef.trim() || !!dockerStore.busy["pull"]} data-testid="docker-pull-go"><DownloadIcon class="size-3.5" /> Pull</Button>
  </form>
  {#if dockerStore.busy["pull"]}<p class="mt-1 animate-pulse text-[11px] text-muted-foreground">Pulling…</p>{/if}
</div>
