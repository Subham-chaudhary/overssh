<script lang="ts">
  // Docker main page (docs/GUIDE.md §15.3.D): lazydocker-like. Left: list of the current
  // scope (containers, images, volumes, networks, compose projects). Right: tabbed detail
  // of the selected object. Narrow pages (< 640 px) show one pane at a time.
  import { clipboardWrite } from "$lib/clipboard";
  import { onMount } from "svelte";
  import { dockerStore, type SelKind } from "$lib/docker/docker.svelte";
  import { isRunning, formatBytes, type Container } from "$lib/docker/parse";
  import { settings } from "$lib/settings.svelte";
  import { dotClass, matches, portsSummary, LIST_CAP, TABS } from "$lib/docker/ui";
  import DockerState from "./DockerState.svelte";
  import DockerMenu, { type MenuItem } from "./DockerMenu.svelte";
  import HelpOverlay from "./HelpOverlay.svelte";
  import ContainerDetail from "./ContainerDetail.svelte";
  import ImageDetail from "./ImageDetail.svelte";
  import ComposeDetail from "./ComposeDetail.svelte";
  import ResourceDetail from "./ResourceDetail.svelte";
  import SystemDetail from "./SystemDetail.svelte";
  import RunImageDialog from "./RunImageDialog.svelte";
  import PruneDialog from "./PruneDialog.svelte";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import SearchIcon from "@lucide/svelte/icons/search";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import CircleHelpIcon from "@lucide/svelte/icons/circle-help";

  onMount(() => {
    dockerStore.activated = true;
    dockerStore.statsWanted++;
    return () => {
      dockerStore.statsWanted--;
    };
  });

  type Scope = typeof dockerStore.scope;
  const SCOPES: { id: Scope; label: string }[] = [
    { id: "containers", label: "Containers" },
    { id: "projects", label: "Compose" },
    { id: "images", label: "Images" },
    { id: "volumes", label: "Volumes" },
    { id: "networks", label: "Networks" },
  ];
  const KIND: Record<Scope, SelKind> = { containers: "container", projects: "project", images: "image", volumes: "volume", networks: "network" };

  const d = $derived(dockerStore.cur);
  const ready = $derived(dockerStore.state === "ready");
  const filter = $derived(dockerStore.filter);
  const scope = $derived(dockerStore.scope);
  const sel = $derived(dockerStore.selection);

  let width = $state(900);
  const narrow = $derived(width < 640);
  let showAll = $state(false);
  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  let filterEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);

  interface Row {
    id: string;
    label: string;
    sub: string;
    right: string;
    dot: string;
    container?: Container;
  }

  const rows = $derived.by((): Row[] => {
    const showStopped = settings.docker.showStoppedContainers;
    switch (scope) {
      case "containers": {
        const list = d.containers.filter((c) => matches(filter, c.name, c.image, c.id, c.project ?? "", c.status));
        return [...list]
          .sort((a, b) => Number(isRunning(b)) - Number(isRunning(a)) || a.name.localeCompare(b.name))
          .filter((c) => showStopped || isRunning(c))
          .map((c) => {
            const st = dockerStore.statsFor(c);
            return {
              id: c.id,
              label: c.name,
              sub: c.image,
              right: st && isRunning(c) ? `${st.latest.cpu.toFixed(0)}% ${formatBytes(st.latest.memUsed)}` : portsSummary(c.ports, 1),
              dot: dotClass(c),
              container: c,
            };
          });
      }
      case "projects":
        return dockerStore.projects
          .filter((p) => matches(filter, p.name))
          .map((p) => ({ id: p.name, label: p.name, sub: p.configFiles[0] ?? "", right: `${p.running}/${p.total}`, dot: p.running > 0 ? "bg-success" : "bg-muted-foreground/50" }));
      case "images":
        return d.images
          .filter((i) => matches(filter, i.ref, i.id))
          .map((i) => ({ id: i.id, label: i.dangling ? `<none> ${i.id}` : i.ref, sub: i.createdSince, right: i.sizeText || formatBytes(i.size), dot: i.containers > 0 ? "bg-success" : "bg-muted-foreground/40" }));
      case "volumes":
        return d.volumes.filter((v) => matches(filter, v.name)).map((v) => ({ id: v.name, label: v.name, sub: v.project ?? "", right: v.driver, dot: "bg-muted-foreground/40" }));
      case "networks":
        return d.networks.filter((n) => matches(filter, n.name)).map((n) => ({ id: n.name, label: n.name, sub: n.driver, right: n.scope, dot: "bg-muted-foreground/40" }));
    }
  });
  const shown = $derived(showAll ? rows : rows.slice(0, LIST_CAP));

  const counts = $derived({
    containers: d.containers.length,
    projects: dockerStore.projects.length,
    images: d.images.length,
    volumes: d.volumes.length,
    networks: d.networks.length,
  });

  const selContainer = $derived(sel?.kind === "container" ? d.containers.find((c) => c.id === sel.id) : undefined);

  function pick(id: string): void {
    dockerStore.select(KIND[scope], id);
  }
  const isSel = (id: string) => sel?.kind === KIND[scope] && sel.id === id;

  function move(delta: number): void {
    if (shown.length === 0) return;
    const i = shown.findIndex((r) => isSel(r.id));
    const next = Math.max(0, Math.min(shown.length - 1, i < 0 ? 0 : i + delta));
    pick(shown[next].id);
    queueMicrotask(() => listEl?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: "nearest" }));
  }

  function switchScope(delta: number): void {
    const i = SCOPES.findIndex((s) => s.id === scope);
    dockerStore.scope = SCOPES[(i + delta + SCOPES.length) % SCOPES.length].id;
    showAll = false;
  }

  function cycleTab(delta: number): void {
    const kind = sel?.kind;
    const tabs = kind ? TABS[kind] : undefined;
    if (!kind || !tabs) return;
    const cur = dockerStore.tab[kind] ?? tabs[0].id;
    const i = tabs.findIndex((t) => t.id === cur);
    dockerStore.tab[kind] = tabs[(i + delta + tabs.length) % tabs.length].id;
  }

  async function removeAsk(c: Container): Promise<void> {
    const ok = await dockerStore.confirm("Remove container", `Remove ${c.name}?${isRunning(c) ? " It is running and will be force-removed." : ""}`, "Remove");
    if (ok) await dockerStore.removeContainer(c, isRunning(c));
  }

  function onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (t.matches("input, textarea, select, [contenteditable]")) {
      if (e.key === "Escape" && t === filterEl) {
        dockerStore.filter = "";
        listEl?.focus();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const c = selContainer;
    switch (e.key) {
      case "j":
      case "ArrowDown":
        move(1);
        break;
      case "k":
      case "ArrowUp":
        move(-1);
        break;
      case "ArrowRight":
        switchScope(1);
        break;
      case "ArrowLeft":
        switchScope(-1);
        break;
      case "]":
        cycleTab(1);
        break;
      case "[":
        cycleTab(-1);
        break;
      case "l":
        if (sel && TABS[sel.kind]?.some((x) => x.id === "logs")) dockerStore.tab[sel.kind] = "logs";
        break;
      case "s":
        if (c) void dockerStore.containerAction(c, isRunning(c) ? "stop" : "start");
        break;
      case "r":
        if (c) void dockerStore.containerAction(c, "restart");
        break;
      case "p":
        if (c && isRunning(c)) void dockerStore.containerAction(c, c.state === "paused" ? "unpause" : "pause");
        break;
      case "d":
        if (c) void removeAsk(c);
        break;
      case "e":
        if (c && isRunning(c)) dockerStore.execShell(c);
        break;
      case "a":
        if (c && isRunning(c)) dockerStore.attach(c);
        break;
      case "/":
        filterEl?.focus();
        break;
      case "R":
        void dockerStore.detect();
        break;
      case "?":
        dockerStore.help = !dockerStore.help;
        break;
      case "Escape":
        if (dockerStore.help) dockerStore.help = false;
        else if (dockerStore.filter) dockerStore.filter = "";
        else return;
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function rowMenu(e: MouseEvent, r: Row): void {
    e.preventDefault();
    pick(r.id);
    const c = r.container;
    if (!c) return;
    const run = isRunning(c);
    menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        run ? { label: "Stop", shortcut: "s", onclick: () => void dockerStore.containerAction(c, "stop") } : { label: "Start", shortcut: "s", onclick: () => void dockerStore.containerAction(c, "start") },
        { label: "Restart", shortcut: "r", onclick: () => void dockerStore.containerAction(c, "restart") },
        { label: "Exec shell", shortcut: "e", disabled: !run, onclick: () => dockerStore.execShell(c) },
        { label: "Copy ID", onclick: () => void clipboardWrite(c.id) },
        { sep: true, label: "" },
        { label: "Remove…", shortcut: "d", danger: true, onclick: () => void removeAsk(c) },
      ],
    };
  }

  const showDetail = $derived(!narrow || sel !== null);
  const showList = $derived(!narrow || sel === null);
</script>

<div class="relative flex h-full min-h-0 min-w-0 flex-col text-[12px]" bind:clientWidth={width} data-testid="docker-view" data-state={dockerStore.state} data-scope={scope}>
  {#if !ready}
    <DockerState />
  {:else}
    <!-- toolbar -->
    <div class="flex flex-none flex-wrap items-center gap-1.5 border-b border-border px-2 py-1">
      <div class="flex flex-wrap items-center gap-0.5" role="tablist" data-testid="docker-scopes">
        {#each SCOPES as s (s.id)}
          <button
            type="button"
            role="tab"
            aria-selected={scope === s.id}
            data-testid={`docker-scope-${s.id}`}
            class={`rounded-md px-2 py-1 text-[12px] ${scope === s.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted"}`}
            onclick={() => {
              dockerStore.scope = s.id;
              showAll = false;
            }}
          >
            {s.label}<span class="ml-1 text-[10px] text-muted-foreground">{counts[s.id]}</span>
          </button>
        {/each}
        <button
          type="button"
          data-testid="docker-scope-system"
          class={`rounded-md px-2 py-1 text-[12px] ${sel?.kind === "system" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-muted"}`}
          onclick={() => dockerStore.select("system", "system")}
        >
          System
        </button>
      </div>
      <div class="relative ml-auto min-w-28 flex-1 @lg/main:max-w-56">
        <SearchIcon class="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
        <input
          bind:this={filterEl}
          class="h-7 w-full rounded-md border border-input bg-transparent pr-2 pl-6 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          placeholder="Filter ( / )"
          data-testid="docker-main-filter"
          bind:value={dockerStore.filter}
        />
      </div>
      <button type="button" class="rounded-sm p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Refresh (R)" aria-label="Refresh" onclick={() => void dockerStore.detect()}>
        <RefreshCwIcon class={`size-3.5 ${d.loading ? "animate-spin" : ""}`} />
      </button>
      <button type="button" class="rounded-sm p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Keyboard help (?)" aria-label="Keyboard help" data-testid="docker-help-open" onclick={() => (dockerStore.help = true)}>
        <CircleHelpIcon class="size-3.5" />
      </button>
    </div>
    {#if d.listError}
      <div class="flex-none border-b border-destructive/40 bg-destructive/10 px-3 py-1 text-[11px] text-destructive" role="alert" data-testid="docker-list-error">{d.listError}</div>
    {/if}

    <div class="flex min-h-0 min-w-0 flex-1">
      {#if showList}
        <div
          bind:this={listEl}
          tabindex="0"
          role="listbox"
          aria-label="Docker objects"
          data-testid="docker-list"
          class={`min-h-0 flex-none overflow-y-auto border-r border-border outline-none focus-visible:ring-1 focus-visible:ring-ring/50 ${narrow ? "w-full" : "w-64 @2xl/main:w-80"}`}
          onkeydown={onKey}
        >
          {#each shown as r (r.id)}
            <div
              role="option"
              aria-selected={isSel(r.id)}
              tabindex="-1"
              data-testid="docker-list-row"
              data-selected={isSel(r.id)}
              data-name={r.label}
              data-state={r.container?.state}
              class={`flex cursor-default items-center gap-2 border-b border-border/40 px-2 py-1 hover:bg-muted/50 ${isSel(r.id) ? "bg-accent" : ""}`}
              onclick={() => pick(r.id)}
              onkeydown={(e) => e.key === "Enter" && pick(r.id)}
              oncontextmenu={(e) => rowMenu(e, r)}
            >
              <span class={`size-2 flex-none rounded-full ${r.dot} ${dockerStore.busy[r.id] ? "animate-pulse" : ""}`}></span>
              <div class="min-w-0 flex-1">
                <div class="truncate">{r.label}</div>
                {#if r.sub}<div class="truncate text-[10px] text-muted-foreground">{r.sub}</div>{/if}
              </div>
              <span class="flex-none truncate font-mono text-[10px] text-muted-foreground">{r.right}</span>
            </div>
          {/each}
          {#if rows.length > LIST_CAP && !showAll}
            <button type="button" class="w-full px-2 py-1.5 text-left text-[11px] text-primary hover:underline" onclick={() => (showAll = true)}>Show {rows.length - LIST_CAP} more…</button>
          {/if}
          {#if rows.length === 0}
            <p class="p-3 text-[11px] text-muted-foreground" data-testid="docker-list-empty">
              {filter ? `Nothing matches "${filter}".` : d.loaded ? `No ${scope} on this host.` : "Loading…"}
            </p>
          {/if}
        </div>
      {/if}

      {#if showDetail}
        <div class="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="docker-detail">
          {#if narrow && sel}
            <button type="button" class="flex flex-none items-center gap-1 border-b border-border px-2 py-1 text-left text-muted-foreground hover:text-foreground" onclick={() => (dockerStore.selection = null)}>
              <ArrowLeftIcon class="size-3.5" /> Back to list
            </button>
          {/if}
          {#key sel ? `${sel.kind}:${sel.id}` : "system"}
            <!-- §15.3.A: quick fade when the selected object changes -->
            <div class="motion-fade flex min-h-0 min-w-0 flex-1 flex-col">
              {#if sel?.kind === "container"}
                {#if selContainer}
                  <ContainerDetail c={selContainer} />
                {:else}
                  <p class="p-4 text-muted-foreground">This container no longer exists.</p>
                {/if}
              {:else if sel?.kind === "image"}
                <ImageDetail id={sel.id} />
              {:else if sel?.kind === "project"}
                <ComposeDetail name={sel.id} />
              {:else if sel?.kind === "volume" || sel?.kind === "network"}
                <ResourceDetail kind={sel.kind} name={sel.id} />
              {:else}
                <SystemDetail />
              {/if}
            </div>
          {/key}
        </div>
      {/if}
    </div>
  {/if}
  <HelpOverlay />
</div>

{#if menu}
  <DockerMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => (menu = null)} />
{/if}
<RunImageDialog />
<PruneDialog />
