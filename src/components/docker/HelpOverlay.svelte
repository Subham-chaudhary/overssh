<script lang="ts">
  import { dockerStore } from "$lib/docker/docker.svelte";
  import { Kbd } from "$lib/components/ui/kbd/index.js";

  const keys: [string, string][] = [
    ["j / k, Up / Down", "Move in the list"],
    ["[ / ]", "Previous / next detail tab"],
    ["Left / Right", "Previous / next list type"],
    ["l", "Logs tab"],
    ["s", "Stop (or start a stopped container)"],
    ["r", "Restart"],
    ["p", "Pause / unpause"],
    ["d", "Remove (asks first)"],
    ["e", "Exec shell in a new terminal"],
    ["a", "Attach in a new terminal"],
    ["/", "Focus the filter"],
    ["R", "Refresh lists"],
    ["?", "This help"],
    ["Esc", "Close this help or clear the filter"],
  ];
</script>

{#if dockerStore.help}
  <div class="absolute inset-0 z-40 flex items-center justify-center bg-black/30 backdrop-blur-[2px]" role="presentation" onclick={() => (dockerStore.help = false)} data-testid="docker-help">
    <div class="w-full max-w-sm rounded-lg border border-border bg-popover p-4 text-[12px] shadow-lg" role="dialog" aria-label="Docker keyboard shortcuts" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
      <div class="mb-2 text-sm font-semibold">Docker keys</div>
      <p class="mb-2 text-muted-foreground">Active while the list is focused.</p>
      <ul class="space-y-1">
        {#each keys as [k, d] (k)}
          <li class="flex items-center justify-between gap-3">
            <span class="text-muted-foreground">{d}</span>
            <Kbd>{k}</Kbd>
          </li>
        {/each}
      </ul>
    </div>
  </div>
{/if}
