<script lang="ts">
  // Tab strip for the detail pane. State lives in dockerStore.tab[kind] so the
  // keyboard handler ([ and ]) and context menus can switch tabs too.
  import { dockerStore } from "$lib/docker/docker.svelte";
  import { TABS } from "$lib/docker/ui";

  let { kind }: { kind: string } = $props();
  const tabs = $derived(TABS[kind] ?? []);
  const current = $derived(dockerStore.tab[kind] ?? tabs[0]?.id);
</script>

<div class="flex flex-none items-center gap-0.5 overflow-x-auto border-b border-border px-2" role="tablist" data-testid="docker-tabs">
  {#each tabs as t (t.id)}
    <button
      type="button"
      role="tab"
      aria-selected={current === t.id}
      data-testid={`docker-tab-${t.id}`}
      class={`-mb-px flex-none border-b-2 px-2.5 py-1.5 text-[12px] outline-none ${current === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
      onclick={() => (dockerStore.tab[kind] = t.id)}
    >
      {t.label}
    </button>
  {/each}
</div>
