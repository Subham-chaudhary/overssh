<script lang="ts">
  // Docker sidebar (docs/GUIDE.md §15.3.D): Compose projects, Containers (running/stopped),
  // Images, Volumes, Networks; filter box, counts, right-click and hover actions.
  import { onMount } from "svelte";
  import { dockerStore } from "$lib/docker/docker.svelte";
  import { projectServices, isRunning, formatBytes, type Container } from "$lib/docker/parse";
  import { dotClass, matches, portsSummary, LIST_CAP } from "$lib/docker/ui";
  import { settings } from "$lib/settings.svelte";
  import DockerState from "./DockerState.svelte";
  import DockerMenu, { type MenuItem } from "./DockerMenu.svelte";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import SearchIcon from "@lucide/svelte/icons/search";
  import XIcon from "@lucide/svelte/icons/x";
  import PlayIcon from "@lucide/svelte/icons/play";
  import SquareIcon from "@lucide/svelte/icons/square";
  import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import BroomIcon from "@lucide/svelte/icons/broom";

  onMount(() => {
    dockerStore.activated = true;
  });

  const d = $derived(dockerStore.cur);
  const ready = $derived(dockerStore.state === "ready");
  const filter = $derived(dockerStore.filter);

  let open = $state({ projects: true, running: true, stopped: true, images: true, volumes: false, networks: false });
  let more = $state<Record<string, boolean>>({});
  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  let projOpen = $state<Record<string, boolean>>({});

  const showStopped = $derived(settings.docker.showStoppedContainers);
  const containers = $derived(d.containers.filter((c) => matches(filter, c.name, c.image, c.id, c.project ?? "")));
  const running = $derived(containers.filter(isRunning));
  const stopped = $derived(showStopped ? containers.filter((c) => !isRunning(c)) : []);
  const projects = $derived(
    dockerStore.projects.filter((p) => matches(filter, p.name) || d.containers.some((c) => c.project === p.name && matches(filter, c.name, c.service ?? ""))),
  );
  const images = $derived(d.images.filter((i) => matches(filter, i.ref, i.id)));
  const volumes = $derived(d.volumes.filter((v) => matches(filter, v.name)));
  const networks = $derived(d.networks.filter((n) => matches(filter, n.name)));

  function sel(kind: "container" | "image" | "volume" | "network" | "project", id: string): void {
    dockerStore.select(kind, id);
  }
  const isSel = (kind: string, id: string) => dockerStore.selection?.kind === kind && dockerStore.selection.id === id;

  function containerMenu(e: MouseEvent, c: Container): void {
    e.preventDefault();
    sel("container", c.id);
    const run = isRunning(c);
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        run
          ? { label: "Stop", onclick: () => void dockerStore.containerAction(c, "stop") }
          : { label: "Start", onclick: () => void dockerStore.containerAction(c, "start") },
        { label: "Restart", onclick: () => void dockerStore.containerAction(c, "restart") },
        { label: c.state === "paused" ? "Unpause" : "Pause", disabled: !run, onclick: () => void dockerStore.containerAction(c, c.state === "paused" ? "unpause" : "pause") },
        { sep: true, label: "" },
        { label: "View logs", onclick: () => (dockerStore.tab.container = "logs") },
        { label: "Exec shell", disabled: !run, onclick: () => dockerStore.execShell(c) },
        { label: "Copy ID", onclick: () => void navigator.clipboard?.writeText(c.id) },
        { sep: true, label: "" },
        { label: "Remove…", danger: true, onclick: () => void removeAsk(c) },
      ],
    };
  }

  async function removeAsk(c: Container): Promise<void> {
    const ok = await dockerStore.confirm("Remove container", `Remove ${c.name}?${isRunning(c) ? " It is running and will be force-removed." : ""}`, "Remove");
    if (ok) await dockerStore.removeContainer(c, isRunning(c));
  }

  function act(e: Event, fn: () => void): void {
    e.stopPropagation();
    fn();
  }
</script>

<div class="flex h-full min-h-0 flex-col text-[12px]" data-testid="docker-sidebar" data-state={dockerStore.state}>
  <div class="flex h-8 flex-none items-center justify-between px-3">
    <span class="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Docker</span>
    {#if ready}
      <div class="flex items-center gap-0.5">
        <button
          type="button"
          class="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Prune…"
          aria-label="Prune"
          data-testid="docker-prune-open"
          onclick={() => {
            dockerStore.select("system", "system");
            dockerStore.pruneOpen = true;
          }}
        >
          <BroomIcon class="size-3.5" />
        </button>
        <button type="button" class="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="Refresh" aria-label="Refresh" data-testid="docker-refresh" onclick={() => void dockerStore.detect()}>
          <RefreshCwIcon class={`size-3.5 ${d.loading ? "animate-spin" : ""}`} />
        </button>
      </div>
    {/if}
  </div>

  {#if !ready}
    <DockerState />
  {:else}
    {#if d.info}
      <div class="flex-none px-3 pb-1 text-[11px] text-muted-foreground" data-testid="docker-info">
        {d.info.engine} {d.info.version}{d.info.rootless ? " · rootless" : ""} · {d.info.running}/{d.info.containers} running
      </div>
    {/if}
    <div class="relative mx-2 mb-1.5 flex-none">
      <SearchIcon class="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
      <input
        class="h-7 w-full rounded-md border border-input bg-transparent pr-6 pl-6 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        placeholder="Filter…"
        data-testid="docker-filter"
        bind:value={dockerStore.filter}
      />
      {#if filter}
        <button type="button" class="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear filter" onclick={() => (dockerStore.filter = "")}>
          <XIcon class="size-3" />
        </button>
      {/if}
    </div>
    {#if d.listError}
      <div class="mx-2 mb-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive" role="alert" data-testid="docker-list-error">{d.listError}</div>
    {/if}

    <div class="min-h-0 flex-1 overflow-y-auto pb-2">
      {#snippet head(title: string, count: number, key: "projects" | "running" | "stopped" | "images" | "volumes" | "networks")}
        <button
          type="button"
          class="flex h-6 w-full items-center gap-0.5 border-t border-border pl-0.5 text-left text-[11px] font-semibold tracking-wide uppercase hover:bg-muted/40"
          aria-expanded={open[key]}
          data-testid={`docker-section-${key}`}
          onclick={() => (open[key] = !open[key])}
        >
          <ChevronRightIcon class={`motion-chevron size-3.5 shrink-0 ${open[key] ? "motion-open" : ""}`} />
          <span class="truncate">{title}</span>
          <span class="ml-1 rounded-full bg-muted px-1.5 text-[10px] font-normal text-muted-foreground normal-case" data-testid={`docker-count-${key}`}>{count}</span>
        </button>
      {/snippet}

      {#snippet crow(c: Container, indent: boolean)}
        {@const st = dockerStore.statsFor(c)}
        <div
          role="button"
          tabindex="0"
          data-testid="docker-container-row"
          data-name={c.name}
          data-state={c.state}
          class={`group flex w-full cursor-default items-center gap-1.5 py-0.5 pr-2 text-left outline-none hover:bg-muted/50 focus-visible:bg-muted/50 ${indent ? "pl-7" : "pl-4"} ${isSel("container", c.id) ? "bg-accent" : ""}`}
          onclick={() => sel("container", c.id)}
          onkeydown={(e) => (e.key === "Enter" || e.key === " ") && sel("container", c.id)}
          oncontextmenu={(e) => containerMenu(e, c)}
        >
          <span class={`size-2 flex-none rounded-full ${dotClass(c)} ${dockerStore.busy[c.id] ? "animate-pulse" : ""}`} title={c.status}></span>
          <span class="min-w-0 flex-1 truncate">{c.name}</span>
          {#if st && isRunning(c)}
            <span class="flex-none font-mono text-[10px] text-muted-foreground tabular-nums group-hover:hidden">{st.latest.cpu.toFixed(0)}%</span>
          {:else}
            <span class="hidden flex-none truncate font-mono text-[10px] text-muted-foreground group-hover:hidden @xs/side:inline">{portsSummary(c.ports, 1)}</span>
          {/if}
          <span class="hidden flex-none gap-0.5 group-hover:flex">
            {#if isRunning(c)}
              <button type="button" class="rounded-sm p-0.5 hover:bg-background" title="Stop" aria-label={`Stop ${c.name}`} onclick={(e) => act(e, () => void dockerStore.containerAction(c, "stop"))}><SquareIcon class="size-3" /></button>
              <button type="button" class="rounded-sm p-0.5 hover:bg-background" title="Restart" aria-label={`Restart ${c.name}`} onclick={(e) => act(e, () => void dockerStore.containerAction(c, "restart"))}><RotateCwIcon class="size-3" /></button>
            {:else}
              <button type="button" class="rounded-sm p-0.5 hover:bg-background" title="Start" aria-label={`Start ${c.name}`} onclick={(e) => act(e, () => void dockerStore.containerAction(c, "start"))}><PlayIcon class="size-3" /></button>
              <button type="button" class="rounded-sm p-0.5 text-destructive hover:bg-background" title="Remove" aria-label={`Remove ${c.name}`} onclick={(e) => act(e, () => void removeAsk(c))}><Trash2Icon class="size-3" /></button>
            {/if}
          </span>
        </div>
      {/snippet}

      {@render head("Compose", projects.length, "projects")}
      {#if open.projects}
        {#each projects as p (p.name)}
          {@const svcs = projectServices(p.name, d.containers)}
          <div data-testid="docker-project" data-name={p.name}>
            <div class={`flex items-center ${isSel("project", p.name) ? "bg-accent" : ""} hover:bg-muted/50`}>
              <button type="button" class="p-0.5 pl-1.5 text-muted-foreground" aria-label="Toggle services" onclick={() => (projOpen[p.name] = !projOpen[p.name])}>
                <ChevronRightIcon class={`motion-chevron size-3 ${projOpen[p.name] ? "motion-open" : ""}`} />
              </button>
              <button type="button" class="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 pr-2 text-left" data-testid="docker-project-row" onclick={() => sel("project", p.name)}>
                <span class={`size-2 flex-none rounded-full ${p.running > 0 ? "bg-success" : "bg-muted-foreground/50"}`}></span>
                <span class="min-w-0 flex-1 truncate">{p.name}</span>
                <span class="flex-none font-mono text-[10px] text-muted-foreground">{p.running}/{p.total}</span>
              </button>
            </div>
            {#if projOpen[p.name]}
              {#each svcs as s (s.service)}
                {#each s.containers as c (c.id)}
                  {@render crow(c, true)}
                {/each}
              {/each}
            {/if}
          </div>
        {/each}
        {#if projects.length === 0}<p class="px-4 py-0.5 text-[11px] text-muted-foreground">No compose projects.</p>{/if}
      {/if}

      {@render head("Containers", running.length, "running")}
      {#if open.running}
        {#each more.running ? running : running.slice(0, LIST_CAP) as c (c.id)}
          {@render crow(c, false)}
        {/each}
        {#if running.length > LIST_CAP && !more.running}
          <button type="button" class="px-4 py-0.5 text-[11px] text-primary hover:underline" onclick={() => (more.running = true)}>Show {running.length - LIST_CAP} more…</button>
        {/if}
        {#if running.length === 0}<p class="px-4 py-0.5 text-[11px] text-muted-foreground">No running containers.</p>{/if}
      {/if}

      {#if showStopped}
        {@render head("Stopped", stopped.length, "stopped")}
        {#if open.stopped}
          {#each more.stopped ? stopped : stopped.slice(0, LIST_CAP) as c (c.id)}
            {@render crow(c, false)}
          {/each}
          {#if stopped.length > LIST_CAP && !more.stopped}
            <button type="button" class="px-4 py-0.5 text-[11px] text-primary hover:underline" onclick={() => (more.stopped = true)}>Show {stopped.length - LIST_CAP} more…</button>
          {/if}
        {/if}
      {/if}

      {@render head("Images", images.length, "images")}
      {#if open.images}
        {#each more.images ? images : images.slice(0, LIST_CAP) as i (i.id + i.ref)}
          <button
            type="button"
            data-testid="docker-image-row"
            data-ref={i.ref}
            class={`flex w-full items-center gap-1.5 py-0.5 pr-2 pl-4 text-left hover:bg-muted/50 ${isSel("image", i.id) ? "bg-accent" : ""}`}
            onclick={() => sel("image", i.id)}
          >
            <span class={`min-w-0 flex-1 truncate ${i.dangling ? "text-muted-foreground italic" : ""}`}>{i.dangling ? `<none> ${i.id}` : i.ref}</span>
            <span class="flex-none font-mono text-[10px] text-muted-foreground">{i.sizeText || formatBytes(i.size)}</span>
          </button>
        {/each}
        {#if images.length > LIST_CAP && !more.images}
          <button type="button" class="px-4 py-0.5 text-[11px] text-primary hover:underline" onclick={() => (more.images = true)}>Show {images.length - LIST_CAP} more…</button>
        {/if}
      {/if}

      {@render head("Volumes", volumes.length, "volumes")}
      {#if open.volumes}
        {#each volumes.slice(0, LIST_CAP) as v (v.name)}
          <button
            type="button"
            data-testid="docker-volume-row"
            class={`flex w-full items-center gap-1.5 py-0.5 pr-2 pl-4 text-left hover:bg-muted/50 ${isSel("volume", v.name) ? "bg-accent" : ""}`}
            onclick={() => sel("volume", v.name)}
          >
            <span class="min-w-0 flex-1 truncate">{v.name}</span>
            <span class="flex-none text-[10px] text-muted-foreground">{v.driver}</span>
          </button>
        {/each}
      {/if}

      {@render head("Networks", networks.length, "networks")}
      {#if open.networks}
        {#each networks.slice(0, LIST_CAP) as n (n.id + n.name)}
          <button
            type="button"
            data-testid="docker-network-row"
            class={`flex w-full items-center gap-1.5 py-0.5 pr-2 pl-4 text-left hover:bg-muted/50 ${isSel("network", n.name) ? "bg-accent" : ""}`}
            onclick={() => sel("network", n.name)}
          >
            <span class="min-w-0 flex-1 truncate">{n.name}</span>
            <span class="flex-none text-[10px] text-muted-foreground">{n.driver}</span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

{#if menu}
  <DockerMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
{/if}
