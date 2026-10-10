<script lang="ts">
  // Container environment. Values are masked until revealed (they often hold secrets).
  import type { ContainerInspect } from "$lib/docker/parse";
  import { isSecretKey } from "$lib/docker/parse";
  import { app } from "$lib/stores.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import EyeIcon from "@lucide/svelte/icons/eye";
  import EyeOffIcon from "@lucide/svelte/icons/eye-off";
  import SearchIcon from "@lucide/svelte/icons/search";

  let { inspect, error = "" }: { inspect: ContainerInspect | null; error?: string } = $props();

  let reveal = $state(false);
  let shown = $state<Record<string, boolean>>({});
  let query = $state("");

  const vars = $derived((inspect?.env ?? []).filter((v) => !query.trim() || v.key.toLowerCase().includes(query.trim().toLowerCase())));

  async function copy(v: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(v);
      app.addToast("info", "Copied");
    } catch {
      app.addToast("error", "Clipboard access denied");
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="docker-env">
  {#if error}
    <p class="p-3 text-destructive" role="alert">{error}</p>
  {:else if !inspect}
    <p class="p-3 text-muted-foreground">Loading…</p>
  {:else}
    <div class="flex flex-none items-center gap-1.5 border-b border-border px-2 py-1">
      <div class="relative min-w-24 flex-1 @lg/main:max-w-56">
        <SearchIcon class="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
        <input class="h-7 w-full rounded-md border border-input bg-transparent pr-2 pl-6 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50" placeholder="Filter variables" bind:value={query} />
      </div>
      <Button size="sm" variant="outline" class="h-7 gap-1 px-2 text-[12px]" data-testid="docker-env-reveal" onclick={() => (reveal = !reveal)}>
        {#if reveal}<EyeOffIcon class="size-3.5" /> Hide values{:else}<EyeIcon class="size-3.5" /> Reveal values{/if}
      </Button>
    </div>
    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full table-fixed text-[12px]">
        <tbody>
          {#each vars as v (v.key)}
            {@const visible = reveal || shown[v.key]}
            <tr class="border-b border-border/40 hover:bg-muted/40" data-testid="docker-env-row" data-key={v.key}>
              <td class="w-2/5 truncate px-2 py-1 font-mono text-chart-2" title={v.key}>{v.key}{#if isSecretKey(v.key)}<span class="ml-1 text-[10px] text-warning">secret?</span>{/if}</td>
              <td class="truncate px-2 py-1 font-mono" title={visible ? v.value : ""} data-testid="docker-env-value">{visible ? v.value : "••••••••"}</td>
              <td class="w-16 px-1 text-right">
                <button type="button" class="rounded-sm p-1 text-muted-foreground hover:bg-muted" aria-label={`Toggle ${v.key}`} onclick={() => (shown[v.key] = !shown[v.key])}>
                  {#if visible}<EyeOffIcon class="size-3" />{:else}<EyeIcon class="size-3" />{/if}
                </button>
                {#if visible}<button type="button" class="rounded-sm px-1 text-[10px] text-muted-foreground hover:bg-muted" onclick={() => copy(v.value)}>copy</button>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if vars.length === 0}<p class="p-3 text-muted-foreground">No environment variables.</p>{/if}
    </div>
  {/if}
</div>
