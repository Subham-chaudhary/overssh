<script lang="ts">
  // One node of the collapsible JSON tree (recursive). Env entries ("KEY=value" under an
  // "Env" array) have their value masked unless `reveal` is on.
  import JsonNode from "./JsonNode.svelte";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";

  let {
    name,
    value,
    depth = 0,
    query = "",
    reveal = false,
    inEnv = false,
    last = true,
  }: { name?: string; value: unknown; depth?: number; query?: string; reveal?: boolean; inEnv?: boolean; last?: boolean } = $props();

  const isArr = $derived(Array.isArray(value));
  const isObj = $derived(typeof value === "object" && value !== null);
  const entries = $derived.by((): [string, unknown][] => {
    if (!isObj) return [];
    return isArr ? (value as unknown[]).map((v, i) => [String(i), v]) : Object.entries(value as Record<string, unknown>);
  });

  const q = $derived(query.trim().toLowerCase());

  function has(v: unknown, key: string | undefined): boolean {
    if (!q) return true;
    if (key && key.toLowerCase().includes(q)) return true;
    if (v === null || typeof v !== "object") return String(v).toLowerCase().includes(q);
    return Object.entries(v as Record<string, unknown>).some(([k, x]) => has(x, k));
  }

  const matchHere = $derived(has(value, name));
  let manual = $state<boolean | null>(null);
  const open = $derived(manual ?? (q ? true : depth < 1));

  function mask(s: string): string {
    const i = s.indexOf("=");
    return i < 0 ? s : `${s.slice(0, i)}=${reveal ? s.slice(i + 1) : "••••••"}`;
  }

  const preview = $derived(isArr ? `[${entries.length}]` : `{${entries.length}}`);
  const hl = (s: string) => (q && s.toLowerCase().includes(q) ? "rounded-sm bg-warning/40" : "");
</script>

{#if matchHere}
  {#if isObj}
    <div data-testid="json-node">
      <button type="button" class="flex items-center gap-0.5 rounded-sm text-left hover:bg-muted/60" aria-expanded={open} onclick={() => (manual = !open)}>
        <ChevronRightIcon class={`motion-chevron size-3 flex-none text-muted-foreground ${open ? "motion-open" : ""}`} />
        {#if name !== undefined}<span class={`text-chart-2 ${hl(name)}`}>{name}</span><span class="text-muted-foreground">:</span>{/if}
        <span class="text-muted-foreground">{preview}</span>
      </button>
      {#if open}
        <div class="ml-3 border-l border-border/50 pl-2">
          {#each entries as [k, v], i (k)}
            <JsonNode name={isArr ? undefined : k} value={v} depth={depth + 1} {query} {reveal} inEnv={inEnv || k === "Env"} last={i === entries.length - 1} />
          {/each}
          {#if entries.length === 0}<span class="text-muted-foreground">empty</span>{/if}
        </div>
      {/if}
    </div>
  {:else}
    <div class="flex gap-1 pl-3.5 break-all" data-testid="json-leaf">
      {#if name !== undefined}<span class={`flex-none text-chart-2 ${hl(name)}`}>{name}</span><span class="flex-none text-muted-foreground">:</span>{/if}
      {#if typeof value === "string"}
        <span class={`whitespace-pre-wrap text-success ${hl(value)}`}>"{inEnv && name === undefined ? mask(value) : value}"</span>
      {:else if value === null}
        <span class="text-muted-foreground">null</span>
      {:else}
        <span class={`${typeof value === "number" ? "text-chart-3" : "text-chart-4"} ${hl(String(value))}`}>{String(value)}</span>
      {/if}
    </div>
  {/if}
{/if}
