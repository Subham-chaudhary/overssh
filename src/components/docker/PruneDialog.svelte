<script lang="ts">
  // Prune dialog: one checkbox per resource kind with its reclaimable size from `system df`.
  import { untrack } from "svelte";
  import { dockerStore } from "$lib/docker/docker.svelte";
  import { buildPruneCommands, formatBytes, type PruneChoice } from "$lib/docker/parse";
  import { app } from "$lib/stores.svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";

  let choice = $state<PruneChoice>({ containers: true, images: true, allImages: false, volumes: false, networks: true, buildCache: false });
  let running = $state(false);
  let result = $state<{ reclaimed: number; errors: string[] } | null>(null);

  const df = $derived(dockerStore.cur.df);
  const find = (re: RegExp) => df.find((r) => re.test(r.type));
  const rows = $derived([
    { key: "containers" as const, label: "Stopped containers", hint: find(/^containers/i)?.reclaimableText },
    { key: "images" as const, label: "Dangling images", hint: find(/^images/i)?.reclaimableText },
    { key: "volumes" as const, label: "Unused volumes (data is lost)", hint: find(/volume/i)?.reclaimableText, danger: true },
    { key: "networks" as const, label: "Unused networks", hint: undefined },
    { key: "buildCache" as const, label: "Build cache", hint: find(/build/i)?.reclaimableText },
  ]);
  const cmds = $derived(buildPruneCommands(choice));

  let wasOpen = false;
  $effect(() => {
    const open = dockerStore.pruneOpen;
    if (open && !wasOpen) {
      untrack(() => {
        result = null;
        running = false;
      });
    }
    wasOpen = open;
    // Sizes come from `system df`, which runs only while a view needs it.
    if (open) return untrack(() => dockerStore.useDf());
  });

  async function go(): Promise<void> {
    if (choice.volumes && !(await app.ask({ title: "Delete volume data?", message: "Unused volumes will be removed permanently.", confirmLabel: "Delete volumes", danger: true }))) return;
    running = true;
    try {
      result = await dockerStore.prune(choice);
      if (result.errors.length === 0) app.addToast("success", `Pruned, reclaimed ${formatBytes(result.reclaimed)}`);
      else app.addToast("error", `Prune finished with errors: ${result.errors[0]}`);
    } finally {
      running = false;
    }
  }
</script>

<Dialog.Root bind:open={dockerStore.pruneOpen}>
  <Dialog.Content class="sm:max-w-md" data-testid="docker-prune-dialog">
    <Dialog.Header>
      <Dialog.Title>Prune Docker</Dialog.Title>
      <Dialog.Description>Remove unused objects on this host. Sizes are what <span class="font-mono">docker system df</span> reports as reclaimable.</Dialog.Description>
    </Dialog.Header>
    <div class="space-y-2 text-[12px]">
      {#each rows as r (r.key)}
        <label class="flex items-center gap-2">
          <Checkbox bind:checked={choice[r.key]} data-testid={`docker-prune-${r.key}`} />
          <span class={r.danger ? "text-destructive" : ""}>{r.label}</span>
          {#if r.hint}<span class="ml-auto font-mono text-[11px] text-muted-foreground">{r.hint}</span>{/if}
        </label>
        {#if r.key === "images" && choice.images}
          <label class="flex items-center gap-2 pl-6 text-muted-foreground">
            <Checkbox bind:checked={choice.allImages} data-testid="docker-prune-allimages" />
            <span>Also all images not used by a container (<span class="font-mono">-a</span>)</span>
          </label>
        {/if}
      {/each}
      <p class="font-mono text-[11px] text-muted-foreground" data-testid="docker-prune-preview">{cmds.map((c) => `docker ${c.join(" ")}`).join(" && ") || "nothing selected"}</p>
      {#if result}
        <p class="rounded bg-muted px-2 py-1" data-testid="docker-prune-result">Reclaimed {formatBytes(result.reclaimed)}{result.errors.length ? `, ${result.errors.length} error(s): ${result.errors.join("; ")}` : ""}</p>
      {/if}
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (dockerStore.pruneOpen = false)}>{result ? "Close" : "Cancel"}</Button>
      <Button variant="destructive" disabled={running || cmds.length === 0} data-testid="docker-prune-go" onclick={go}>{running ? "Pruning…" : "Prune"}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
