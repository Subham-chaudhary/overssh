<script lang="ts">
  // `docker top <container>`: processes inside the container, refreshed on demand.
  import { dockerStore } from "$lib/docker/docker.svelte";
  import { friendlyDockerError, isRunning, parseTable, type Container, type Table } from "$lib/docker/parse";
  import { Button } from "$lib/components/ui/button/index.js";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";

  let { c }: { c: Container } = $props();

  let table = $state<Table>({ columns: [], rows: [] });
  let error = $state("");
  let loading = $state(false);
  let auto = $state(false);

  async function load(): Promise<void> {
    if (!isRunning(c)) return;
    loading = true;
    try {
      const out = await dockerStore.run(["top", c.id]);
      if (out.code !== 0) {
        error = friendlyDockerError(out.stderr, "docker top failed");
        return;
      }
      error = "";
      table = parseTable(out.stdout);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  const cid = $derived(c.id);
  const cstate = $derived(c.state);
  $effect(() => {
    void cid;
    void cstate;
    void load();
  });

  $effect(() => {
    if (!auto) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  });
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="docker-top">
  <div class="flex flex-none items-center gap-2 border-b border-border px-2 py-1">
    <Button size="sm" variant="outline" class="h-7 gap-1 px-2 text-[12px]" onclick={() => load()} disabled={loading}><RefreshCwIcon class={`size-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh</Button>
    <label class="flex items-center gap-1 text-[12px] text-muted-foreground"><input type="checkbox" bind:checked={auto} /> Every 3 s</label>
  </div>
  <div class="min-h-0 flex-1 overflow-auto">
    {#if !isRunning(c)}
      <p class="p-3 text-muted-foreground">The container is not running.</p>
    {:else if error}
      <p class="p-3 text-destructive" role="alert">{error}</p>
    {:else}
      <table class="w-full text-[12px]">
        <thead class="sticky top-0 bg-background text-left text-[11px] text-muted-foreground uppercase">
          <tr>{#each table.columns as col (col)}<th class="px-2 py-1 font-medium">{col}</th>{/each}</tr>
        </thead>
        <tbody>
          {#each table.rows as row, i (i)}
            <tr class="border-t border-border/40 hover:bg-muted/40" data-testid="docker-top-row">
              {#each row as cell, j (j)}<td class={`px-2 py-0.5 font-mono ${j === row.length - 1 ? "break-all" : "whitespace-nowrap"}`}>{cell}</td>{/each}
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
</div>
