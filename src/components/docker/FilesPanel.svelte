<script lang="ts">
  // Container filesystem browser (read-only listing through `docker exec … ls`), a read-only
  // file viewer, download (docker cp to a VM temp dir, then SFTP) and copy-into-container
  // (SFTP upload to a VM temp dir, then docker cp). Temp dirs are always removed.
  import { open, save } from "@tauri-apps/plugin-dialog";
  import * as api from "$lib/api";
  import { app } from "$lib/stores.svelte";
  import { dockerStore } from "$lib/docker/docker.svelte";
  import { transfers, isActive, startDownload } from "$lib/transfers.svelte";
  import {
    cjoin,
    cparent,
    formatBytes,
    friendlyDockerError,
    isRunning,
    looksBinary,
    lsNeedsFallback,
    parseLsLa,
    type Container,
    type ContainerInspect,
    type FsEntry,
  } from "$lib/docker/parse";
  import FileViewer from "./FileViewer.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import FolderIcon from "@lucide/svelte/icons/folder";
  import FileIcon from "@lucide/svelte/icons/file";
  import LinkIcon from "@lucide/svelte/icons/link";
  import ArrowUpIcon from "@lucide/svelte/icons/arrow-up";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import UploadIcon from "@lucide/svelte/icons/upload";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import FolderOpenIcon from "@lucide/svelte/icons/folder-open";

  let { c, inspect }: { c: Container; inspect: ContainerInspect | null } = $props();

  const PREVIEW_CAP = 2 * 1024 * 1024;

  let dir = $state("/");
  let pathInput = $state("/");
  let entries = $state<FsEntry[]>([]);
  let error = $state("");
  let loading = $state(false);
  let working = $state("");
  let viewer = $state<{ path: string; content: string; truncated: boolean } | null>(null);

  const running = $derived(isRunning(c));

  async function exec(args: string[]) {
    return dockerStore.run(["exec", c.id, ...args]);
  }

  /** Only the newest listing may fill the page: a slow answer for an earlier folder must not replace it. */
  let listSeq = 0;
  async function list(path: string): Promise<void> {
    const my = ++listSeq;
    loading = true;
    error = "";
    try {
      const target = path.endsWith("/") ? path : `${path}/`;
      let out = await exec(["ls", "-la", "--time-style=+%s", target]);
      if (lsNeedsFallback(out.code, out.stderr)) out = await exec(["ls", "-la", target]);
      if (my !== listSeq) return;
      if (out.code !== 0) {
        error = friendlyDockerError(out.stderr, `Cannot list ${path}`);
        return;
      }
      entries = parseLsLa(out.stdout);
      dir = path;
      pathInput = path;
    } catch (e) {
      if (my === listSeq) error = e instanceof Error ? e.message : String((e as { message?: string }).message ?? e);
    } finally {
      if (my === listSeq) loading = false;
    }
  }

  const cid = $derived(c.id);
  $effect(() => {
    void cid;
    const on = running;
    viewer = null;
    if (on) void list("/");
  });

  function openEntry(e: FsEntry): void {
    const p = cjoin(dir, e.name);
    if (e.kind === "dir") void list(p);
    else if (e.kind === "link") void list(e.target.startsWith("/") ? e.target : cjoin(dir, e.target)).then(() => error && void view(e));
    else void view(e);
  }

  async function view(e: FsEntry): Promise<void> {
    const p = cjoin(dir, e.name);
    if (e.size > PREVIEW_CAP * 4) {
      app.addToast("error", `${e.name} is ${formatBytes(e.size)}; too large to preview. Use Download.`);
      return;
    }
    working = `Reading ${e.name}`;
    try {
      const out = await exec(["head", "-c", String(PREVIEW_CAP + 1), p]);
      if (out.code !== 0) {
        app.addToast("error", friendlyDockerError(out.stderr, "Cannot read file"));
        error = "";
        return;
      }
      error = "";
      if (looksBinary(out.stdout)) {
        app.addToast("info", `${e.name} looks binary. Use Download.`);
        return;
      }
      const truncated = out.stdout.length > PREVIEW_CAP;
      viewer = { path: p, content: truncated ? out.stdout.slice(0, PREVIEW_CAP) : out.stdout, truncated };
    } finally {
      working = "";
    }
  }

  // --- temp dir helpers (VM side) --------------------------------------------------

  async function withTemp<T>(fn: (tmp: string) => Promise<T>, keep?: (v: T) => boolean): Promise<T | null> {
    const sid = dockerStore.sessionId;
    if (!sid) return null;
    const tmp = `/tmp/overssh-docker-${crypto.randomUUID().slice(0, 8)}`;
    let leave = false;
    try {
      await api.createDir(sid, tmp);
      const v = await fn(tmp);
      leave = keep?.(v) ?? false;
      return v;
    } catch (e) {
      app.addToast("error", e instanceof Error ? e.message : String((e as { message?: string }).message ?? e));
      return null;
    } finally {
      if (!leave) void api.remove(sid, tmp, true).catch(() => {});
    }
  }

  /** Cleans `tmp` once the transfer job has finished (jobs run in the background). */
  function cleanupAfterJob(jobId: string, tmp: string): void {
    const sid = dockerStore.sessionId;
    if (!sid) return;
    const started = Date.now();
    const t = setInterval(() => {
      const job = transfers.jobs.find((j) => j.id === jobId);
      if ((job && !isActive(job)) || (!job && Date.now() - started > 5000) || Date.now() - started > 30 * 60_000) {
        clearInterval(t);
        void api.remove(sid, tmp, true).catch(() => {});
      }
    }, 1000);
  }

  async function download(path: string, kind: FsEntry["kind"]): Promise<void> {
    const sid = dockerStore.sessionId;
    if (!sid) return;
    const name = path.slice(path.lastIndexOf("/") + 1) || "root";
    const isDir = kind === "dir";
    const dest = isDir ? await open({ directory: true, title: `Save ${name} into…` }) : await save({ defaultPath: name });
    if (!dest || typeof dest !== "string") return;
    working = `Downloading ${name}`;
    try {
      await withTemp(
        async (tmp) => {
          const cp = await dockerStore.run(["cp", `${c.id}:${path}`, `${tmp}/`]);
          if (cp.code !== 0) throw new Error(friendlyDockerError(cp.stderr, "docker cp failed"));
          const staged = `${tmp}/${name}`;
          if (isDir) {
            const job = await startDownload(sid, [staged], dest);
            if (job) cleanupAfterJob(job, tmp);
            return { job };
          }
          await api.download(sid, staged, dest);
          app.addToast("success", `Saved ${name}`);
          return { job: null as string | null };
        },
        (v) => v.job !== null,
      );
    } finally {
      working = "";
    }
  }

  async function upload(directory: boolean): Promise<void> {
    const sid = dockerStore.sessionId;
    if (!sid) return;
    const local = await open({ directory, multiple: false, title: directory ? "Copy folder into container" : "Copy file into container" });
    if (!local || typeof local !== "string") return;
    working = "Copying into container";
    try {
      const ok = await withTemp(async (tmp) => {
        const remote = await api.upload(sid, local, tmp);
        const cp = await dockerStore.run(["cp", remote, `${c.id}:${dir.endsWith("/") ? dir : dir + "/"}`]);
        if (cp.code !== 0) throw new Error(friendlyDockerError(cp.stderr, "docker cp failed"));
        return true;
      });
      if (ok) {
        app.addToast("success", `Copied into ${c.name}:${dir}`);
        await list(dir);
      }
    } finally {
      working = "";
    }
  }

  const bindMounts = $derived((inspect?.mounts ?? []).filter((m) => m.source));
  const when = (e: FsEntry) => (e.mtime ? new Date(e.mtime * 1000).toLocaleString() : e.mtimeText);
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="docker-files">
  {#if !running}
    <p class="p-3 text-muted-foreground">Start the container to browse its files.</p>
  {:else if viewer}
    <div class="flex flex-none items-center gap-2 border-b border-border px-2 py-1">
      <Button size="sm" variant="ghost" class="h-7 gap-1 px-2 text-[12px]" data-testid="docker-file-back" onclick={() => (viewer = null)}><ArrowLeftIcon class="size-3.5" /> Back</Button>
      <span class="min-w-0 flex-1 truncate font-mono text-[12px]" data-testid="docker-file-path">{viewer.path}</span>
      {#if viewer.truncated}<span class="text-[11px] text-warning">first {formatBytes(PREVIEW_CAP)} only</span>{/if}
      <span class="text-[11px] text-muted-foreground">read-only</span>
      <Button size="sm" variant="outline" class="h-7 gap-1 px-2 text-[12px]" onclick={() => viewer && download(viewer.path, "file")}><DownloadIcon class="size-3.5" /> Download</Button>
    </div>
    <div class="min-h-0 flex-1"><FileViewer path={viewer.path} content={viewer.content} /></div>
  {:else}
    <div class="flex flex-none flex-wrap items-center gap-1 border-b border-border px-2 py-1">
      <Button size="icon" variant="ghost" class="size-7" title="Parent folder" aria-label="Parent folder" disabled={dir === "/"} data-testid="docker-files-up" onclick={() => list(cparent(dir))}><ArrowUpIcon class="size-3.5" /></Button>
      <form class="min-w-24 flex-1" onsubmit={(e) => { e.preventDefault(); void list(cjoin("/", pathInput || "/")); }}>
        <input class="h-7 w-full rounded-md border border-input bg-transparent px-2 font-mono text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label="Container path" data-testid="docker-files-path" bind:value={pathInput} />
      </form>
      <Button size="icon" variant="ghost" class="size-7" title="Refresh" aria-label="Refresh" onclick={() => list(dir)}><RefreshCwIcon class={`size-3.5 ${loading ? "animate-spin" : ""}`} /></Button>
      <Button size="sm" variant="outline" class="h-7 gap-1 px-2 text-[12px]" title="Copy a local file into this folder" data-testid="docker-files-upload" onclick={() => upload(false)}><UploadIcon class="size-3.5" /><span class="hidden @lg/main:inline">File…</span></Button>
      <Button size="sm" variant="outline" class="h-7 gap-1 px-2 text-[12px]" title="Copy a local folder into this folder" onclick={() => upload(true)}><UploadIcon class="size-3.5" /><span class="hidden @lg/main:inline">Folder…</span></Button>
    </div>
    {#if bindMounts.length}
      <div class="flex flex-none flex-wrap items-center gap-1 border-b border-border px-2 py-1 text-[11px]">
        <span class="text-muted-foreground">Mounted from the host:</span>
        {#each bindMounts as m, i (i)}
          <button type="button" class="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 hover:bg-muted" title={`Open ${m.source} in the Explorer`} data-testid="docker-files-hostmount" onclick={() => dockerStore.browseHostPath(m.source)}>
            <FolderOpenIcon class="size-3" /> <span class="font-mono">{m.destination}</span>
          </button>
          <button type="button" class="font-mono text-primary hover:underline" onclick={() => list(m.destination)}>(in container)</button>
        {/each}
      </div>
    {/if}
    {#if working}<div class="flex-none animate-pulse border-b border-border px-3 py-1 text-[11px] text-muted-foreground">{working}…</div>{/if}
    <div class="min-h-0 flex-1 overflow-auto">
      {#if error}
        <p class="p-3 text-destructive" role="alert" data-testid="docker-files-error">{error}</p>
      {:else}
        <table class="w-full text-[12px]">
          <thead class="sticky top-0 bg-background text-left text-[11px] text-muted-foreground uppercase">
            <tr><th class="px-2 py-1 font-medium">Name</th><th class="hidden px-2 py-1 text-right font-medium @lg/main:table-cell">Size</th><th class="hidden px-2 py-1 font-medium @2xl/main:table-cell">Modified</th><th class="hidden px-2 py-1 font-medium @2xl/main:table-cell">Mode</th><th></th></tr>
          </thead>
          <tbody>
            {#each entries as e (e.name)}
              <tr class="group border-t border-border/40 hover:bg-muted/40" data-testid="docker-fs-row" data-name={e.name} data-kind={e.kind}>
                <td class="px-2 py-0.5">
                  <button type="button" class="flex max-w-full items-center gap-1.5 text-left" ondblclick={() => openEntry(e)} onclick={() => (e.kind === "dir" ? openEntry(e) : null)} onkeydown={(ev) => ev.key === "Enter" && openEntry(e)}>
                    {#if e.kind === "dir"}<FolderIcon class="size-3.5 flex-none text-primary" />{:else if e.kind === "link"}<LinkIcon class="size-3.5 flex-none text-muted-foreground" />{:else}<FileIcon class="size-3.5 flex-none text-muted-foreground" />{/if}
                    <span class="truncate">{e.name}</span>{#if e.target}<span class="truncate text-muted-foreground">→ {e.target}</span>{/if}
                  </button>
                </td>
                <td class="hidden px-2 py-0.5 text-right font-mono text-muted-foreground tabular-nums @lg/main:table-cell">{e.kind === "dir" ? "" : formatBytes(e.size)}</td>
                <td class="hidden px-2 py-0.5 whitespace-nowrap text-muted-foreground @2xl/main:table-cell">{when(e)}</td>
                <td class="hidden px-2 py-0.5 font-mono text-muted-foreground @2xl/main:table-cell">{e.mode}</td>
                <td class="px-1 text-right whitespace-nowrap">
                  {#if e.kind === "file" || e.kind === "link"}<button type="button" class="rounded-sm px-1 text-[11px] text-primary opacity-0 group-hover:opacity-100 hover:underline focus:opacity-100" data-testid="docker-fs-view" onclick={() => view(e)}>View</button>{/if}
                  <button type="button" class="rounded-sm px-1 text-[11px] text-primary opacity-0 group-hover:opacity-100 hover:underline focus:opacity-100" data-testid="docker-fs-download" onclick={() => download(cjoin(dir, e.name), e.kind)}>Download</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if entries.length === 0 && !loading}<p class="p-3 text-muted-foreground">Empty folder.</p>{/if}
      {/if}
    </div>
  {/if}
</div>
