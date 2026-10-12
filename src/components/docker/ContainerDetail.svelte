<script lang="ts">
  import { clipboardWrite } from "$lib/clipboard";
  import { dockerStore } from "$lib/docker/docker.svelte";
  import { isRunning, type Container, type ContainerInspect } from "$lib/docker/parse";
  import { dotClass } from "$lib/docker/ui";
  import { app } from "$lib/stores.svelte";
  import DetailTabs from "./DetailTabs.svelte";
  import LogsPanel from "./LogsPanel.svelte";
  import StatsPanel from "./StatsPanel.svelte";
  import InspectPane from "./InspectPane.svelte";
  import EnvPanel from "./EnvPanel.svelte";
  import PortsPanel from "./PortsPanel.svelte";
  import TopPanel from "./TopPanel.svelte";
  import MountsPanel from "./MountsPanel.svelte";
  import FilesPanel from "./FilesPanel.svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import PlayIcon from "@lucide/svelte/icons/play";
  import SquareIcon from "@lucide/svelte/icons/square";
  import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
  import PauseIcon from "@lucide/svelte/icons/pause";
  import SkullIcon from "@lucide/svelte/icons/skull";
  import TerminalIcon from "@lucide/svelte/icons/square-terminal";
  import PlugIcon from "@lucide/svelte/icons/plug";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import FileJsonIcon from "@lucide/svelte/icons/file-json";

  let { c }: { c: Container } = $props();

  const run = $derived(isRunning(c));
  const busy = $derived(dockerStore.busy[c.id]);
  const tab = $derived(dockerStore.tab.container ?? "logs");

  let inspect = $state<ContainerInspect | null>(null);
  let inspectError = $state("");
  let lastKey = "";
  $effect(() => {
    // Reload inspect when the container's state changes (ports, env, mounts rarely do).
    const key = `${c.id}|${c.state}|${c.status.split(" ")[0]}`;
    if (key === lastKey) return;
    lastKey = key;
    inspectError = "";
    dockerStore
      .inspectContainer(c.id)
      .then((i) => {
        // Another container was selected meanwhile: its own inspect owns the pane.
        if (lastKey === key) inspect = i;
      })
      .catch((e) => {
        if (lastKey !== key) return;
        inspect = null;
        inspectError = e instanceof Error ? e.message : String(e);
      });
  });

  let rmOpen = $state(false);
  let rmForce = $state(false);
  let rmVolumes = $state(false);

  function openRemove(): void {
    rmForce = run;
    rmVolumes = false;
    rmOpen = true;
  }

  async function doRemove(): Promise<void> {
    rmOpen = false;
    await dockerStore.removeContainer(c, rmForce, rmVolumes);
  }

  async function rename(): Promise<void> {
    const name = await app.ask({ title: "Rename container", input: { value: c.name }, confirmLabel: "Rename" });
    if (name && name.trim() && name.trim() !== c.name) await dockerStore.renameContainer(c, name.trim());
  }

  async function kill(): Promise<void> {
    if (await dockerStore.confirm("Kill container", `Send SIGKILL to ${c.name}?`, "Kill")) await dockerStore.containerAction(c, "kill");
  }

  const btn = "h-7 gap-1 px-2 text-[12px]";
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col" data-testid="docker-container-detail" data-name={c.name} data-state={c.state}>
  <div class="flex-none border-b border-border px-3 py-2">
    <div class="flex min-w-0 items-center gap-2">
      <span class={`size-2.5 flex-none rounded-full ${dotClass(c)}`}></span>
      <h2 class="min-w-0 truncate text-sm font-semibold" data-testid="docker-detail-title">{c.name}</h2>
      <span class="flex-none rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase" data-testid="docker-detail-state">{c.state}{c.health ? ` · ${c.health}` : ""}</span>
      {#if busy}<span class="flex-none animate-pulse text-[11px] text-muted-foreground">{busy}</span>{/if}
    </div>
    <div class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground">
      <span class="truncate">{c.image}</span>
      <span class="font-mono">{c.id.slice(0, 12)}</span>
      <span class="truncate">{c.status}</span>
    </div>
    <div class="mt-2 flex flex-wrap items-center gap-1" data-testid="docker-actions">
      {#if run}
        <Button size="sm" variant="outline" class={btn} title="Stop (s)" data-testid="docker-act-stop" disabled={!!busy} onclick={() => dockerStore.containerAction(c, "stop")}><SquareIcon class="size-3.5" /><span class="hidden @lg/main:inline">Stop</span></Button>
      {:else}
        <Button size="sm" variant="outline" class={btn} title="Start (s)" data-testid="docker-act-start" disabled={!!busy} onclick={() => dockerStore.containerAction(c, "start")}><PlayIcon class="size-3.5" /><span class="hidden @lg/main:inline">Start</span></Button>
      {/if}
      <Button size="sm" variant="outline" class={btn} title="Restart (r)" data-testid="docker-act-restart" disabled={!!busy} onclick={() => dockerStore.containerAction(c, "restart")}><RotateCwIcon class="size-3.5" /><span class="hidden @lg/main:inline">Restart</span></Button>
      {#if run}
        <Button size="sm" variant="outline" class={btn} title={c.state === "paused" ? "Unpause (p)" : "Pause (p)"} data-testid="docker-act-pause" disabled={!!busy} onclick={() => dockerStore.containerAction(c, c.state === "paused" ? "unpause" : "pause")}>
          <PauseIcon class="size-3.5" /><span class="hidden @lg/main:inline">{c.state === "paused" ? "Unpause" : "Pause"}</span>
        </Button>
        <Button size="sm" variant="outline" class={btn} title="Kill (SIGKILL)" data-testid="docker-act-kill" disabled={!!busy} onclick={kill}><SkullIcon class="size-3.5" /><span class="hidden @lg/main:inline">Kill</span></Button>
        <Button size="sm" variant="outline" class={btn} title="Exec shell in a new terminal (e)" data-testid="docker-act-exec" onclick={() => dockerStore.execShell(c)}><TerminalIcon class="size-3.5" /><span class="hidden @lg/main:inline">Exec shell</span></Button>
        <Button size="sm" variant="outline" class={btn} title="Attach (a)" data-testid="docker-act-attach" onclick={() => dockerStore.attach(c)}><PlugIcon class="size-3.5" /><span class="hidden @lg/main:inline">Attach</span></Button>
      {/if}
      <Button size="sm" variant="outline" class={btn} title="Rename" data-testid="docker-act-rename" onclick={rename}><PencilIcon class="size-3.5" /><span class="hidden @lg/main:inline">Rename</span></Button>
      <Button size="sm" variant="outline" class={btn} title="Copy container ID" data-testid="docker-act-copyid" onclick={() => { void clipboardWrite(c.id); app.addToast("info", "Container ID copied"); }}><CopyIcon class="size-3.5" /><span class="hidden @lg/main:inline">Copy ID</span></Button>
      <Button size="sm" variant="outline" class={btn} title="View inspect JSON" data-testid="docker-act-inspect" onclick={() => (dockerStore.tab.container = "inspect")}><FileJsonIcon class="size-3.5" /><span class="hidden @lg/main:inline">Inspect</span></Button>
      <Button size="sm" variant="outline" class={`${btn} text-destructive`} title="Remove (d)" data-testid="docker-act-remove" disabled={!!busy} onclick={openRemove}><Trash2Icon class="size-3.5" /><span class="hidden @lg/main:inline">Remove</span></Button>
    </div>
  </div>

  <DetailTabs kind="container" />

  <div class="min-h-0 flex-1 overflow-hidden" data-testid="docker-tab-body" data-tab={tab}>
    {#if tab === "logs"}
      <LogsPanel target={c.id} label={c.name} running={run} />
    {:else if tab === "stats"}
      <StatsPanel {c} />
    {:else if tab === "inspect"}
      <InspectPane args={["inspect", "--type", "container", c.id]} />
    {:else if tab === "env"}
      <EnvPanel {inspect} error={inspectError} />
    {:else if tab === "ports"}
      <PortsPanel {c} {inspect} />
    {:else if tab === "top"}
      <TopPanel {c} />
    {:else if tab === "mounts"}
      <MountsPanel {inspect} error={inspectError} />
    {:else if tab === "files"}
      <FilesPanel {c} {inspect} />
    {/if}
  </div>
</div>

<Dialog.Root bind:open={rmOpen}>
  <Dialog.Content class="sm:max-w-sm" data-testid="docker-remove-dialog">
    <Dialog.Header>
      <Dialog.Title>Remove container</Dialog.Title>
      <Dialog.Description>Remove <span class="font-mono">{c.name}</span>? This cannot be undone.</Dialog.Description>
    </Dialog.Header>
    <div class="space-y-2 text-[12px]">
      <label class="flex items-center justify-between gap-2">
        <span>Force (kill it if running)</span>
        <Switch bind:checked={rmForce} data-testid="docker-remove-force" />
      </label>
      <label class="flex items-center justify-between gap-2">
        <span>Also remove its anonymous volumes</span>
        <Switch bind:checked={rmVolumes} data-testid="docker-remove-volumes" />
      </label>
      {#if run && !rmForce}<p class="text-warning">The container is running; without Force this will fail.</p>{/if}
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (rmOpen = false)}>Cancel</Button>
      <Button variant="destructive" data-testid="docker-remove-confirm" onclick={doRemove}>Remove</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
