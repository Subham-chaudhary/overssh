<script lang="ts">
  import { dockerStore } from "$lib/docker/docker.svelte";
  import { imageLabel } from "$lib/docker/ui";
  import { formatBytes, friendlyDockerError, parseHistory, type HistoryLayer } from "$lib/docker/parse";
  import { app } from "$lib/stores.svelte";
  import DetailTabs from "./DetailTabs.svelte";
  import InspectPane from "./InspectPane.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import PlayIcon from "@lucide/svelte/icons/play";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import TagIcon from "@lucide/svelte/icons/tag";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import BroomIcon from "@lucide/svelte/icons/broom";

  let { id }: { id: string } = $props();

  const imgs = $derived(dockerStore.cur.images.filter((i) => i.id === id));
  const img = $derived(imgs[0]);
  const ref = $derived(img && !img.dangling ? img.ref : id);
  const tab = $derived(dockerStore.tab.image ?? "overview");
  const users = $derived(dockerStore.cur.containers.filter((c) => c.image === ref || c.image === id || imgs.some((i) => i.ref === c.image)));
  const busy = $derived(dockerStore.busy[`img:${id}`]);

  let layers = $state<HistoryLayer[]>([]);
  let histError = $state("");
  $effect(() => {
    if (tab !== "history") return;
    histError = "";
    let live = true;
    dockerStore
      .run(["history", "--no-trunc", "--format", "{{json .}}", ref])
      .then((out) => {
        if (!live) return;
        if (out.code !== 0) histError = friendlyDockerError(out.stderr, "history failed");
        else layers = parseHistory(out.stdout);
      })
      .catch((e) => live && (histError = e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  });

  const maxLayer = $derived(Math.max(1, ...layers.map((l) => l.size)));

  async function pull(): Promise<void> {
    if (!img || img.dangling || img.tag === "<none>") return;
    await dockerStore.act(`img:${id}`, `Pulled ${ref}`, ["pull", ref], { refresh: ["images", "containers", "df"] });
  }

  async function tag(): Promise<void> {
    const t = await app.ask({ title: "Tag image", message: `New tag for ${ref}`, input: { value: img && !img.dangling ? img.repository + ":" : "" }, confirmLabel: "Tag" });
    if (t?.trim()) await dockerStore.act(`img:${id}`, `Tagged ${t.trim()}`, ["tag", ref, t.trim()], { refresh: ["images"] });
  }

  async function remove(force = false): Promise<void> {
    const ok = await dockerStore.confirm("Remove image", `Remove ${ref}?${users.length ? ` ${users.length} container(s) use it.` : ""}`, "Remove");
    if (!ok) return;
    const out = await dockerStore.act(`img:${id}`, `Removed ${ref}`, force ? ["rmi", "-f", id] : ["rmi", img && !img.dangling ? ref : id], { refresh: ["images", "containers", "df"] });
    if (out && dockerStore.selection?.id === id) dockerStore.selection = null;
  }

  async function pruneDangling(): Promise<void> {
    if (await dockerStore.confirm("Prune dangling images", "Remove all images without a tag?", "Prune")) {
      await dockerStore.act("img:prune", "Pruned dangling images", ["image", "prune", "-f"], { refresh: ["images", "df"] });
    }
  }

  const btn = "h-7 gap-1 px-2 text-[12px]";
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col" data-testid="docker-image-detail">
  {#if !img}
    <p class="p-4 text-muted-foreground">This image no longer exists.</p>
  {:else}
    <div class="flex-none border-b border-border px-3 py-2">
      <div class="flex min-w-0 items-center gap-2">
        <h2 class="min-w-0 truncate text-sm font-semibold" data-testid="docker-detail-title">{imageLabel(img)}</h2>
        {#if img.dangling}<span class="flex-none rounded bg-warning/20 px-1.5 py-0.5 text-[10px] text-warning uppercase">dangling</span>{/if}
        {#if busy}<span class="flex-none animate-pulse text-[11px] text-muted-foreground">{busy}</span>{/if}
      </div>
      <div class="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
        <span class="font-mono">{img.id}</span><span>{img.sizeText || formatBytes(img.size)}</span><span>{img.createdSince}</span>
      </div>
      <div class="mt-2 flex flex-wrap gap-1">
        <Button size="sm" class={btn} data-testid="docker-image-run" onclick={() => (dockerStore.runImage = ref)}><PlayIcon class="size-3.5" /><span class="hidden @lg/main:inline">Run…</span></Button>
        <Button size="sm" variant="outline" class={btn} disabled={img.dangling || img.tag === "<none>" || !!busy} data-testid="docker-image-pull" onclick={pull}><DownloadIcon class="size-3.5" /><span class="hidden @lg/main:inline">Pull</span></Button>
        <Button size="sm" variant="outline" class={btn} onclick={tag}><TagIcon class="size-3.5" /><span class="hidden @lg/main:inline">Tag…</span></Button>
        <Button size="sm" variant="outline" class={`${btn} text-destructive`} disabled={!!busy} data-testid="docker-image-remove" onclick={() => remove(false)}><Trash2Icon class="size-3.5" /><span class="hidden @lg/main:inline">Remove</span></Button>
        <Button size="sm" variant="outline" class={btn} data-testid="docker-image-prune" onclick={pruneDangling}><BroomIcon class="size-3.5" /><span class="hidden @lg/main:inline">Prune dangling</span></Button>
      </div>
    </div>
    <DetailTabs kind="image" />
    <div class="min-h-0 flex-1 overflow-hidden">
      {#if tab === "overview"}
        <div class="h-full overflow-auto p-3 text-[12px]">
          <h3 class="mb-1 text-[11px] font-semibold text-muted-foreground uppercase">Tags</h3>
          <ul class="mb-3 space-y-0.5 font-mono">
            {#each imgs as i (i.ref)}<li>{i.dangling ? "(untagged)" : imageLabel(i)}</li>{/each}
          </ul>
          <h3 class="mb-1 text-[11px] font-semibold text-muted-foreground uppercase">Containers using this image</h3>
          {#if users.length === 0}
            <p class="text-muted-foreground">None.</p>
          {:else}
            <ul class="space-y-0.5">
              {#each users as c (c.id)}
                <li><button type="button" class="text-primary hover:underline" onclick={() => dockerStore.select("container", c.id)}>{c.name}</button> <span class="text-muted-foreground">{c.state}</span></li>
              {/each}
            </ul>
          {/if}
          {#if img.digest && img.digest !== "<none>"}<p class="mt-3 font-mono text-[11px] break-all text-muted-foreground">{img.digest}</p>{/if}
        </div>
      {:else if tab === "history"}
        <div class="h-full overflow-auto p-2" data-testid="docker-history">
          {#if histError}
            <p class="p-2 text-destructive" role="alert">{histError}</p>
          {:else}
            {#each layers as l, i (i)}
              <div class="border-b border-border/40 py-1 text-[12px]" data-testid="docker-layer">
                <div class="flex items-center gap-2">
                  <span class="w-16 flex-none text-right font-mono text-[11px] tabular-nums text-muted-foreground">{l.sizeText}</span>
                  <div class="h-1.5 flex-1 rounded-full bg-muted"><div class="h-full rounded-full bg-chart-1" style={`width:${(l.size * 100) / maxLayer}%`}></div></div>
                  <span class="w-24 flex-none truncate text-[11px] text-muted-foreground">{l.createdSince}</span>
                </div>
                <div class="mt-0.5 pl-[4.5rem] font-mono text-[11px] break-all whitespace-pre-wrap">{l.createdBy}</div>
              </div>
            {/each}
          {/if}
        </div>
      {:else}
        <InspectPane args={["inspect", "--type", "image", id]} />
      {/if}
    </div>
  {/if}
</div>
