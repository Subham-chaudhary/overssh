<script lang="ts">
  // Volume and network detail: overview, inspect, remove, browse a volume's mountpoint.
  import { dockerStore } from "$lib/docker/docker.svelte";
  import { isBuiltinNetwork } from "$lib/docker/parse";
  import DetailTabs from "./DetailTabs.svelte";
  import InspectPane from "./InspectPane.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import FolderOpenIcon from "@lucide/svelte/icons/folder-open";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import BroomIcon from "@lucide/svelte/icons/broom";

  let { kind, name }: { kind: "volume" | "network"; name: string } = $props();

  const vol = $derived(kind === "volume" ? dockerStore.cur.volumes.find((v) => v.name === name) : undefined);
  const net = $derived(kind === "network" ? dockerStore.cur.networks.find((n) => n.name === name) : undefined);
  const tab = $derived(dockerStore.tab[kind] ?? "overview");
  const users = $derived(
    dockerStore.cur.containers.filter((c) => (kind === "volume" ? c.mounts.includes(name) : c.networks.includes(name))),
  );
  const exists = $derived(kind === "volume" ? !!vol : !!net);
  const busy = $derived(dockerStore.busy[`${kind}:${name}`]);
  const builtin = $derived(net ? isBuiltinNetwork(net) : false);
  const labels = $derived(Object.entries((vol ?? net)?.labels ?? {}));

  async function remove(): Promise<void> {
    const ok = await dockerStore.confirm(`Remove ${kind}`, `Remove ${kind} "${name}"?${users.length ? ` ${users.length} container(s) use it.` : ""}`, "Remove");
    if (!ok) return;
    const args = kind === "volume" ? ["volume", "rm", name] : ["network", "rm", name];
    const out = await dockerStore.act(`${kind}:${name}`, `Removed ${name}`, args, { refresh: [kind === "volume" ? "volumes" : "networks", "df"] });
    if (out) dockerStore.selection = null;
  }

  async function prune(): Promise<void> {
    if (await dockerStore.confirm(`Prune ${kind}s`, `Remove all unused ${kind}s?`, "Prune")) {
      await dockerStore.act(`${kind}:prune`, `Pruned ${kind}s`, [kind, "prune", "-f"], { refresh: [kind === "volume" ? "volumes" : "networks", "df"] });
    }
  }

  const btn = "h-7 gap-1 px-2 text-[12px]";
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col" data-testid={`docker-${kind}-detail`}>
  {#if !exists}
    <p class="p-4 text-muted-foreground">This {kind} no longer exists.</p>
  {:else}
    <div class="flex-none border-b border-border px-3 py-2">
      <div class="flex min-w-0 items-center gap-2">
        <h2 class="min-w-0 truncate text-sm font-semibold" data-testid="docker-detail-title">{name}</h2>
        {#if busy}<span class="flex-none animate-pulse text-[11px] text-muted-foreground">{busy}</span>{/if}
      </div>
      <div class="mt-0.5 text-[11px] text-muted-foreground">{(vol ?? net)?.driver} · {(vol ?? net)?.scope}</div>
      <div class="mt-2 flex flex-wrap gap-1">
        {#if vol}
          <Button size="sm" variant="outline" class={btn} disabled={!vol.mountpoint} data-testid="docker-volume-browse" onclick={() => dockerStore.browseHostPath(vol.mountpoint)}><FolderOpenIcon class="size-3.5" /><span class="hidden @lg/main:inline">Browse volume</span></Button>
        {/if}
        <Button size="sm" variant="outline" class={`${btn} text-destructive`} disabled={!!busy || builtin} data-testid="docker-resource-remove" onclick={remove}><Trash2Icon class="size-3.5" /><span class="hidden @lg/main:inline">Remove</span></Button>
        <Button size="sm" variant="outline" class={btn} data-testid="docker-resource-prune" onclick={prune}><BroomIcon class="size-3.5" /><span class="hidden @lg/main:inline">Prune unused</span></Button>
      </div>
    </div>
    <DetailTabs {kind} />
    <div class="min-h-0 flex-1 overflow-hidden">
      {#if tab === "overview"}
        <div class="h-full overflow-auto p-3 text-[12px]">
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            {#if vol}
              <dt class="text-muted-foreground">Mountpoint</dt><dd class="font-mono break-all">{vol.mountpoint || "-"}</dd>
              {#if vol.project}<dt class="text-muted-foreground">Compose project</dt><dd>{vol.project}</dd>{/if}
            {:else if net}
              <dt class="text-muted-foreground">ID</dt><dd class="font-mono">{net.id}</dd>
              <dt class="text-muted-foreground">Internal</dt><dd>{net.internal ? "yes" : "no"}</dd>
              <dt class="text-muted-foreground">IPv6</dt><dd>{net.ipv6 ? "yes" : "no"}</dd>
              {#if net.project}<dt class="text-muted-foreground">Compose project</dt><dd>{net.project}</dd>{/if}
            {/if}
          </dl>
          <h3 class="mt-3 mb-1 text-[11px] font-semibold text-muted-foreground uppercase">Used by</h3>
          {#if users.length === 0}
            <p class="text-muted-foreground">No containers.</p>
          {:else}
            <ul>
              {#each users as c (c.id)}<li><button type="button" class="text-primary hover:underline" onclick={() => dockerStore.select("container", c.id)}>{c.name}</button> <span class="text-muted-foreground">{c.state}</span></li>{/each}
            </ul>
          {/if}
          {#if labels.length}
            <h3 class="mt-3 mb-1 text-[11px] font-semibold text-muted-foreground uppercase">Labels</h3>
            <ul class="font-mono text-[11px]">{#each labels as [k, v] (k)}<li class="break-all">{k}={v}</li>{/each}</ul>
          {/if}
        </div>
      {:else}
        <InspectPane args={["inspect", "--type", kind, name]} />
      {/if}
    </div>
  {/if}
</div>
