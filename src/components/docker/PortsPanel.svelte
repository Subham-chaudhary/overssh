<script lang="ts">
  // Published and exposed ports of a container; "Forward port" reuses the Ports (forwarding) store.
  import { dockerStore } from "$lib/docker/docker.svelte";
  import type { Container, ContainerInspect, PortMapping } from "$lib/docker/parse";
  import { Button } from "$lib/components/ui/button/index.js";
  import CableIcon from "@lucide/svelte/icons/cable";

  let { c, inspect }: { c: Container; inspect: ContainerInspect | null } = $props();

  // Inspect knows exposed-but-unpublished ports of stopped containers too; `ps` is the fallback.
  const ports = $derived<PortMapping[]>(inspect && inspect.ports.length ? inspect.ports : c.ports);
  const nets = $derived(inspect?.networks ?? []);

  let busy = $state<string | null>(null);
  async function forward(p: PortMapping): Promise<void> {
    busy = `${p.containerPort}/${p.proto}`;
    try {
      await dockerStore.forwardPort(c, p);
    } finally {
      busy = null;
    }
  }
</script>

<div class="h-full overflow-auto p-3" data-testid="docker-ports">
  {#if ports.length === 0}
    <p class="text-muted-foreground">This container exposes no ports.</p>
  {:else}
    <table class="w-full text-[12px]">
      <thead class="text-left text-[11px] text-muted-foreground uppercase">
        <tr><th class="py-1 pr-2 font-medium">Host</th><th class="py-1 pr-2 font-medium">Container</th><th class="py-1 pr-2 font-medium">Proto</th><th></th></tr>
      </thead>
      <tbody>
        {#each ports as p, i (i)}
          <tr class="border-t border-border/40" data-testid="docker-port-row" data-container-port={p.containerPort}>
            <td class="py-1 pr-2 font-mono">{p.hostPort ? `${p.hostIp && p.hostIp !== "0.0.0.0" ? p.hostIp + ":" : ""}${p.hostPort}` : "not published"}</td>
            <td class="py-1 pr-2 font-mono">{p.containerPort}</td>
            <td class="py-1 pr-2">{p.proto}</td>
            <td class="py-1 text-right">
              {#if p.proto === "tcp"}
                <Button size="sm" variant="outline" class="h-6 gap-1 px-2 text-[11px]" disabled={busy !== null || c.state !== "running"} data-testid="docker-port-forward" onclick={() => forward(p)}>
                  <CableIcon class="size-3" /> Forward port
                </Button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="mt-2 text-[11px] text-muted-foreground">Forwarding adds a local rule to Ports (localhost:port on this PC to the VM).</p>
  {/if}
  {#if nets.length}
    <h3 class="mt-4 mb-1 text-[11px] font-semibold text-muted-foreground uppercase">Networks</h3>
    <table class="w-full text-[12px]">
      <tbody>
        {#each nets as n (n.name)}
          <tr class="border-t border-border/40"><td class="py-1 pr-2">{n.name}</td><td class="py-1 pr-2 font-mono">{n.ip || "-"}</td><td class="py-1 font-mono text-muted-foreground">{n.gateway}</td></tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
