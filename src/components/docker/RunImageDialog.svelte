<script lang="ts">
  // Simple "docker run" dialog: name, ports, env, volumes, detach, restart policy, command.
  import { untrack } from "svelte";
  import { dockerStore } from "$lib/docker/docker.svelte";
  import { buildRunArgs, friendlyDockerError } from "$lib/docker/parse";
  import { app } from "$lib/stores.svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";

  let image = $state("");
  let name = $state("");
  let ports = $state("");
  let env = $state("");
  let volumes = $state("");
  let command = $state("");
  let restart = $state("no");
  let detach = $state(true);
  let rm = $state(false);
  let running = $state(false);
  let error = $state("");

  const open = $derived(dockerStore.runImage !== null);
  let wasOpen = false;
  $effect(() => {
    const o = open;
    if (o && !wasOpen) {
      untrack(() => {
        image = dockerStore.runImage ?? "";
        name = ports = env = volumes = command = error = "";
        restart = "no";
        detach = true;
        rm = false;
        running = false;
      });
    }
    wasOpen = o;
  });

  const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  const args = $derived(buildRunArgs({ image, name, ports: lines(ports), env: lines(env.replace(/,/g, "\n")), volumes: lines(volumes), detach, restart, rm, command }));
  const valid = $derived(image.trim() !== "");

  async function go(): Promise<void> {
    if (!valid) return;
    running = true;
    error = "";
    try {
      const out = await dockerStore.run(args);
      if (out.code !== 0) {
        error = friendlyDockerError(out.stderr, "docker run failed");
        return;
      }
      app.addToast("success", `Started ${name.trim() || image.trim()}`);
      dockerStore.runImage = null;
      dockerStore.scope = "containers";
      await dockerStore.refresh(undefined, ["containers", "volumes", "networks", "df"]);
      const created = out.stdout.trim().split("\n").pop()?.trim() ?? "";
      const c = dockerStore.cur.containers.find((x) => created && x.id.startsWith(created.slice(0, 12)));
      if (c) dockerStore.select("container", c.id);
    } catch (e) {
      error = e instanceof Error ? e.message : String((e as { message?: string }).message ?? e);
    } finally {
      running = false;
    }
  }

  const input = "h-8 w-full rounded-md border border-input bg-transparent px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
</script>

<Dialog.Root open={open} onOpenChange={(o) => { if (!o) dockerStore.runImage = null; }}>
  <Dialog.Content class="max-h-[90vh] overflow-y-auto sm:max-w-lg" data-testid="docker-run-dialog">
    <Dialog.Header>
      <Dialog.Title>Run image</Dialog.Title>
      <Dialog.Description>Create and start a container from <span class="font-mono">{image || "an image"}</span>.</Dialog.Description>
    </Dialog.Header>
    <form class="space-y-2 text-[12px]" onsubmit={(e) => { e.preventDefault(); void go(); }}>
      <label class="block"><span class="text-muted-foreground">Image</span><input class={input} data-testid="docker-run-image" bind:value={image} /></label>
      <label class="block"><span class="text-muted-foreground">Name (optional)</span><input class={input} data-testid="docker-run-name" bind:value={name} placeholder="my-app" /></label>
      <label class="block"><span class="text-muted-foreground">Ports (host:container, one per line)</span><Textarea class="min-h-14 font-mono text-[12px]" data-testid="docker-run-ports" bind:value={ports} placeholder="8080:80" /></label>
      <label class="block"><span class="text-muted-foreground">Environment (KEY=value, one per line)</span><Textarea class="min-h-14 font-mono text-[12px]" data-testid="docker-run-env" bind:value={env} /></label>
      <label class="block"><span class="text-muted-foreground">Volumes (/host:/container[:ro] or name:/container)</span><Textarea class="min-h-14 font-mono text-[12px]" data-testid="docker-run-volumes" bind:value={volumes} /></label>
      <label class="block"><span class="text-muted-foreground">Command (optional)</span><input class={input} data-testid="docker-run-command" bind:value={command} placeholder="sh -c 'sleep 3600'" /></label>
      <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
        <label class="flex items-center gap-2"><Switch bind:checked={detach} data-testid="docker-run-detach" /> Detach (-d)</label>
        <label class="flex items-center gap-2"><Switch bind:checked={rm} /> Remove on exit (--rm)</label>
        <label class="flex items-center gap-2">Restart
          <select class="h-7 rounded-md border border-input bg-transparent px-1.5" bind:value={restart}>
            <option value="no">no</option><option value="always">always</option><option value="unless-stopped">unless-stopped</option><option value="on-failure">on-failure</option>
          </select>
        </label>
      </div>
      {#if !detach}<p class="text-warning">Without Detach the command runs to completion here and its output is not shown. Prefer Exec shell for interactive use.</p>{/if}
      <p class="font-mono text-[11px] break-all text-muted-foreground" data-testid="docker-run-preview">docker {args.join(" ")}</p>
      {#if error}<p class="rounded bg-destructive/10 px-2 py-1 text-destructive" role="alert" data-testid="docker-run-error">{error}</p>{/if}
      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => (dockerStore.runImage = null)}>Cancel</Button>
        <Button type="submit" disabled={!valid || running} data-testid="docker-run-go">{running ? "Starting…" : "Run"}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
