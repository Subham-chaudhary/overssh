<script lang="ts">
  // A compose project: services, aggregated logs, compose file editing (open, validate, apply).
  import { dockerStore } from "$lib/docker/docker.svelte";
  import { composeErrorLine, isRunning, projectServices } from "$lib/docker/parse";
  import { dotClass } from "$lib/docker/ui";
  import DetailTabs from "./DetailTabs.svelte";
  import LogsPanel from "./LogsPanel.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import PlayIcon from "@lucide/svelte/icons/play";
  import SquareIcon from "@lucide/svelte/icons/square";
  import RotateCwIcon from "@lucide/svelte/icons/rotate-cw";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import ArrowDownToLineIcon from "@lucide/svelte/icons/arrow-down-to-line";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import CheckIcon from "@lucide/svelte/icons/check";

  let { name }: { name: string } = $props();

  const project = $derived(dockerStore.projects.find((p) => p.name === name));
  const services = $derived(projectServices(name, dockerStore.cur.containers));
  const tab = $derived(dockerStore.tab.project ?? "services");
  const busy = $derived(dockerStore.busy[`proj:${name}`]);
  const out = $derived(dockerStore.composeOutput[name]);
  const files = $derived(project?.configFiles ?? []);

  async function down(): Promise<void> {
    if (await dockerStore.confirm("Compose down", `Stop and remove the containers and networks of "${name}"?`, "Down")) {
      await dockerStore.composeRun(name, `Brought down ${name}`, ["down"]);
    }
  }

  const btn = "h-7 gap-1 px-2 text-[12px]";
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col" data-testid="docker-project-detail" data-name={name}>
  <div class="flex-none border-b border-border px-3 py-2">
    <div class="flex min-w-0 items-center gap-2">
      <span class={`size-2.5 flex-none rounded-full ${project && project.running > 0 ? "bg-success" : "bg-muted-foreground/50"}`}></span>
      <h2 class="min-w-0 truncate text-sm font-semibold" data-testid="docker-detail-title">{name}</h2>
      <span class="flex-none rounded bg-muted px-1.5 py-0.5 text-[10px]">{project?.status ?? ""}</span>
      {#if busy}<span class="flex-none animate-pulse text-[11px] text-muted-foreground">{busy}</span>{/if}
    </div>
    <div class="mt-0.5 truncate text-[11px] text-muted-foreground">{files[0] ?? project?.workingDir ?? "no compose file recorded (project found from container labels)"}</div>
    <div class="mt-2 flex flex-wrap gap-1">
      <Button size="sm" class={btn} disabled={!!busy} data-testid="docker-compose-up" title="docker compose up -d" onclick={() => dockerStore.composeRun(name, `Started ${name}`, ["up", "-d"])}><PlayIcon class="size-3.5" /><span class="hidden @lg/main:inline">Up</span></Button>
      <Button size="sm" variant="outline" class={btn} disabled={!!busy} data-testid="docker-compose-down" title="docker compose down" onclick={down}><ArrowDownToLineIcon class="size-3.5" /><span class="hidden @lg/main:inline">Down</span></Button>
      <Button size="sm" variant="outline" class={btn} disabled={!!busy} data-testid="docker-compose-restart" onclick={() => dockerStore.composeRun(name, `Restarted ${name}`, ["restart"])}><RotateCwIcon class="size-3.5" /><span class="hidden @lg/main:inline">Restart</span></Button>
      <Button size="sm" variant="outline" class={btn} disabled={!!busy} data-testid="docker-compose-stop" onclick={() => dockerStore.composeRun(name, `Stopped ${name}`, ["stop"])}><SquareIcon class="size-3.5" /><span class="hidden @lg/main:inline">Stop</span></Button>
      <Button size="sm" variant="outline" class={btn} disabled={!!busy} data-testid="docker-compose-pull" onclick={() => dockerStore.composeRun(name, `Pulled ${name}`, ["pull"])}><DownloadIcon class="size-3.5" /><span class="hidden @lg/main:inline">Pull</span></Button>
    </div>
  </div>

  <DetailTabs kind="project" />

  <div class="min-h-0 flex-1 overflow-hidden">
    {#if tab === "services"}
      <div class="h-full overflow-auto" data-testid="docker-services">
        {#each services as s (s.service)}
          <div class="border-b border-border/40 px-3 py-1.5" data-testid="docker-service" data-service={s.service}>
            <div class="flex items-center gap-2">
              <span class="font-medium">{s.service}</span>
              <span class="text-[11px] text-muted-foreground">{s.containers.filter(isRunning).length}/{s.containers.length} running</span>
              <span class="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" class="h-6 px-1.5 text-[11px]" disabled={!!busy} onclick={() => dockerStore.composeRun(name, `Restarted ${s.service}`, ["restart", s.service])}>Restart</Button>
                <Button size="sm" variant="ghost" class="h-6 px-1.5 text-[11px]" disabled={!!busy} onclick={() => dockerStore.composeRun(name, `Started ${s.service}`, ["up", "-d", s.service])}>Up</Button>
              </span>
            </div>
            {#each s.containers as c (c.id)}
              <button type="button" class="flex w-full items-center gap-2 py-0.5 pl-3 text-left hover:bg-muted/40" onclick={() => dockerStore.select("container", c.id)}>
                <span class={`size-2 flex-none rounded-full ${dotClass(c)}`}></span>
                <span class="min-w-0 flex-1 truncate">{c.name}</span>
                <span class="flex-none truncate text-[11px] text-muted-foreground">{c.status}</span>
              </button>
            {/each}
          </div>
        {/each}
        {#if services.length === 0}<p class="p-3 text-muted-foreground">No containers for this project yet. Use Up to create them.</p>{/if}
      </div>
    {:else if tab === "logs"}
      <LogsPanel target={name} label={name} compose={true} running={(project?.running ?? 0) > 0} />
    {:else}
      <div class="h-full overflow-auto p-3" data-testid="docker-compose-files">
        {#if files.length === 0}
          <p class="text-muted-foreground">No compose file is recorded for this project. It may have been started with a different working directory.</p>
        {:else}
          <ul class="space-y-2">
            {#each files as f (f)}
              {@const chk = dockerStore.composeCheck[f]}
              <li class="rounded-md border border-border p-2" data-testid="docker-compose-file">
                <div class="flex flex-wrap items-center gap-2">
                  <FileTextIcon class="size-4 flex-none text-muted-foreground" />
                  <span class="min-w-0 flex-1 font-mono text-[12px] break-all">{f}</span>
                  <Button size="sm" variant="outline" class="h-7 px-2 text-[12px]" data-testid="docker-compose-open" onclick={() => dockerStore.openFile(f)}>Open in editor</Button>
                </div>
                {#if chk}
                  {#if chk.ok}
                    <p class="mt-1.5 flex items-center gap-1 text-[12px] text-success" data-testid="docker-compose-valid"><CheckIcon class="size-3.5" /> Valid</p>
                  {:else}
                    {@const line = composeErrorLine(chk.message)}
                    <p class="mt-1.5 rounded bg-destructive/10 px-2 py-1 font-mono text-[11px] break-words whitespace-pre-wrap text-destructive" role="alert" data-testid="docker-compose-invalid">{line ? `(line ${line}) ` : ""}{chk.message}</p>
                  {/if}
                {/if}
              </li>
            {/each}
          </ul>
          <div class="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" class={btn} disabled={!!busy} data-testid="docker-compose-validate" onclick={() => dockerStore.validateCompose(name)}>Validate</Button>
            <Button size="sm" class={btn} disabled={!!busy} data-testid="docker-compose-apply" onclick={() => dockerStore.applyCompose(name)}>Apply (docker compose up -d)</Button>
          </div>
          <p class="mt-2 text-[11px] text-muted-foreground">After you save a compose file in the editor, a notification offers Apply.</p>
        {/if}
      </div>
    {/if}
  </div>

  {#if out}
    <details class="flex-none border-t border-border" open data-testid="docker-compose-output">
      <summary class="cursor-pointer px-3 py-1 text-[11px] text-muted-foreground">
        {out.busy ? "Running" : out.code === 0 ? "Done" : `Failed (exit ${out.code ?? "?"})`}: <span class="font-mono">{out.cmd}</span>
      </summary>
      <pre class="max-h-40 overflow-auto bg-muted/40 px-3 py-1 font-mono text-[11px] whitespace-pre-wrap" data-testid="docker-compose-output-text">{out.text || (out.busy ? "…" : "(no output)")}</pre>
    </details>
  {/if}
</div>
