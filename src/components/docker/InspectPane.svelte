<script lang="ts">
  // `docker inspect` as a collapsible JSON tree with search. Env values are masked by default.
  import { dockerStore } from "$lib/docker/docker.svelte";
  import { friendlyDockerError } from "$lib/docker/parse";
  import { app } from "$lib/stores.svelte";
  import JsonNode from "./JsonNode.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import SearchIcon from "@lucide/svelte/icons/search";
  import EyeIcon from "@lucide/svelte/icons/eye";
  import EyeOffIcon from "@lucide/svelte/icons/eye-off";
  import CopyIcon from "@lucide/svelte/icons/copy";

  let { args }: { args: string[] } = $props();

  let data = $state.raw<unknown>(null);
  let error = $state("");
  let loading = $state(true);
  let query = $state("");
  let reveal = $state(false);
  let raw = "";

  $effect(() => {
    const a = args;
    loading = true;
    error = "";
    let live = true;
    dockerStore
      .run(a)
      .then((out) => {
        if (!live) return;
        if (out.code !== 0) {
          error = friendlyDockerError(out.stderr, "inspect failed");
          data = null;
          return;
        }
        raw = out.stdout;
        try {
          const v = JSON.parse(out.stdout);
          data = Array.isArray(v) && v.length === 1 ? v[0] : v;
        } catch {
          error = "Could not parse inspect output";
          data = null;
        }
      })
      .catch((e) => live && (error = e instanceof Error ? e.message : String(e)))
      .finally(() => live && (loading = false));
    return () => {
      live = false;
    };
  });

  async function copy(): Promise<void> {
    // Copies with env values masked unless revealed, so a paste into a chat does not leak secrets by accident.
    try {
      let text = JSON.stringify(data, null, 2);
      if (!reveal) text = text.replace(/("[A-Za-z0-9_.\-]+=)[^"]*(")/g, "$1••••••$2");
      await navigator.clipboard.writeText(text);
      app.addToast("info", reveal ? "Inspect JSON copied" : "Inspect JSON copied (env values masked)");
    } catch {
      app.addToast("error", "Clipboard access denied");
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="docker-inspect">
  <div class="flex flex-none items-center gap-1.5 border-b border-border px-2 py-1">
    <div class="relative min-w-24 flex-1 @lg/main:max-w-64">
      <SearchIcon class="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
      <input class="h-7 w-full rounded-md border border-input bg-transparent pr-2 pl-6 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50" placeholder="Search keys and values" data-testid="docker-inspect-search" bind:value={query} />
    </div>
    <Button size="sm" variant="outline" class="h-7 gap-1 px-2 text-[12px]" data-testid="docker-inspect-reveal" onclick={() => (reveal = !reveal)}>
      {#if reveal}<EyeOffIcon class="size-3.5" /> Hide env{:else}<EyeIcon class="size-3.5" /> Reveal env{/if}
    </Button>
    <Button size="icon" variant="ghost" class="size-7" title="Copy JSON" aria-label="Copy JSON" onclick={copy}><CopyIcon class="size-3.5" /></Button>
  </div>
  <div class="min-h-0 flex-1 overflow-auto p-2 font-mono text-[12px] leading-5">
    {#if loading}
      <p class="text-muted-foreground">Loading…</p>
    {:else if error}
      <p class="text-destructive" role="alert">{error}</p>
    {:else if data !== null}
      <JsonNode value={data} {query} {reveal} />
    {/if}
  </div>
</div>
