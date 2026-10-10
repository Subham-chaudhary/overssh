<script lang="ts">
  // Non-ready states of the Docker view: disabled, no session, detecting, not installed,
  // daemon down, permission denied (offers sudo -n), sudo needs a password, other errors.
  import { dockerStore } from "$lib/docker/docker.svelte";
  import { settings } from "$lib/settings.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import ContainerIcon from "@lucide/svelte/icons/container";

  let { compact = false }: { compact?: boolean } = $props();
  const st = $derived(dockerStore.state);
  const msg = $derived(dockerStore.cur.message);

  function useSudo(): void {
    settings.docker.command = "sudo docker";
    void dockerStore.detect();
  }
  function useDocker(): void {
    settings.docker.command = "docker";
    void dockerStore.detect();
  }
  function usePodman(): void {
    settings.docker.command = "podman";
    void dockerStore.detect();
  }
</script>

<div class={`motion-fade flex flex-col items-center justify-center gap-2 p-4 text-center text-[12px] text-muted-foreground ${compact ? "" : "h-full"}`} data-testid={`docker-state-${st}`}>
  <ContainerIcon class="size-7 opacity-60" />
  {#if st === "disabled"}
    <p>Docker support is turned off in Settings.</p>
    <Button size="sm" variant="outline" onclick={() => (settings.docker.enabled = true)}>Enable Docker</Button>
  {:else if st === "disconnected"}
    <p>Connect to a host to manage its containers.</p>
  {:else if st === "detecting" || st === "idle"}
    <p>Looking for Docker on this host…</p>
  {:else if st === "missing"}
    <p class="font-medium text-foreground">{settings.docker.command === "podman" ? "podman" : "docker"} is not installed on this host.</p>
    <p>Install it on the VM, or try another engine:</p>
    <div class="flex flex-wrap justify-center gap-2">
      {#if settings.docker.command !== "podman"}<Button size="sm" variant="outline" onclick={usePodman}>Use podman</Button>{/if}
      {#if settings.docker.command !== "docker"}<Button size="sm" variant="outline" onclick={useDocker}>Use docker</Button>{/if}
      <Button size="sm" variant="outline" onclick={() => dockerStore.detect()}>Check again</Button>
    </div>
  {:else if st === "daemon-down"}
    <p class="font-medium text-foreground">The Docker daemon is not running.</p>
    <p>Start it on the VM, for example <span class="font-mono">sudo systemctl start docker</span>.</p>
    {#if msg}<p class="max-w-xs break-words font-mono text-[11px]">{msg}</p>{/if}
    <Button size="sm" variant="outline" onclick={() => dockerStore.detect()}>Check again</Button>
  {:else if st === "denied"}
    <p class="font-medium text-foreground">Permission denied on the Docker socket.</p>
    <p>
      Add your user to the docker group and log in again:
      <span class="block font-mono text-[11px]">sudo usermod -aG docker $USER</span>
      or run Docker through <span class="font-mono">sudo -n</span> (needs passwordless sudo).
    </p>
    <div class="flex flex-wrap justify-center gap-2">
      <Button size="sm" onclick={useSudo} data-testid="docker-use-sudo">Use "sudo -n docker"</Button>
      <Button size="sm" variant="outline" onclick={() => dockerStore.detect()}>Check again</Button>
    </div>
  {:else if st === "sudo-password"}
    <p class="font-medium text-foreground">sudo needs a password.</p>
    <p>OverSSH runs <span class="font-mono">sudo -n</span> (no prompt). Allow it without a password for docker, or use the docker group.</p>
    <Button size="sm" variant="outline" onclick={useDocker}>Use plain docker</Button>
  {:else}
    <p class="font-medium text-foreground">Could not talk to Docker.</p>
    {#if msg}<p class="max-w-xs break-words font-mono text-[11px]">{msg}</p>{/if}
    <Button size="sm" variant="outline" onclick={() => dockerStore.detect()}>Try again</Button>
  {/if}
</div>
