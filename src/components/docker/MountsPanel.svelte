<script lang="ts">
  // Bind mounts and volumes of a container. "Browse" opens the Explorer on the host path.
  import { dockerStore } from "$lib/docker/docker.svelte";
  import type { ContainerInspect } from "$lib/docker/parse";
  import { Button } from "$lib/components/ui/button/index.js";
  import FolderOpenIcon from "@lucide/svelte/icons/folder-open";

  let { inspect, error = "" }: { inspect: ContainerInspect | null; error?: string } = $props();
</script>

<div class="h-full overflow-auto p-3" data-testid="docker-mounts">
  {#if error}
    <p class="text-destructive" role="alert">{error}</p>
  {:else if !inspect}
    <p class="text-muted-foreground">Loading…</p>
  {:else if inspect.mounts.length === 0}
    <p class="text-muted-foreground">No mounts.</p>
  {:else}
    <table class="w-full text-[12px]">
      <thead class="text-left text-[11px] text-muted-foreground uppercase">
        <tr><th class="py-1 pr-2 font-medium">Type</th><th class="py-1 pr-2 font-medium">Source</th><th class="py-1 pr-2 font-medium">Destination</th><th class="py-1 pr-2 font-medium">Mode</th><th></th></tr>
      </thead>
      <tbody>
        {#each inspect.mounts as m, i (i)}
          <tr class="border-t border-border/40" data-testid="docker-mount-row">
            <td class="py-1 pr-2">{m.type}</td>
            <td class="max-w-0 py-1 pr-2 font-mono break-all" title={m.source}>{m.name || m.source}</td>
            <td class="py-1 pr-2 font-mono break-all">{m.destination}</td>
            <td class="py-1 pr-2">{m.rw ? "rw" : "ro"}</td>
            <td class="py-1 text-right">
              {#if m.source}
                <Button size="sm" variant="outline" class="h-6 gap-1 px-2 text-[11px]" data-testid="docker-mount-browse" onclick={() => dockerStore.browseHostPath(m.source)}><FolderOpenIcon class="size-3" /> Browse</Button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
