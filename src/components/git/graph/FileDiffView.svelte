<script lang="ts">
  // Main-area diff page for one file of a commit or one working change (docs/GUIDE.md §14.4.G2).
  import Loader from "../../Loader.svelte";
  import ChangedFiles from "./ChangedFiles.svelte";
  import DiffPane from "./DiffPane.svelte";
  import * as api from "../../../lib/api";
  import { app } from "../../../lib/stores.svelte";
  import { settings } from "../../../lib/settings.svelte";
  import { join } from "../../../lib/paths";
  import { gitStore, GitError } from "../../../lib/git/git.svelte";
  import { catBlobArgs, isMissingPathError, looksBinary, STATUS_LABEL, type DiffSide, type DiffSources, type FileChange } from "../../../lib/git/diff";
  import { shortSha } from "../../../lib/git/log";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import ArrowUpIcon from "@lucide/svelte/icons/arrow-up";
  import ArrowDownIcon from "@lucide/svelte/icons/arrow-down";
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import ChevronLeftIcon from "@lucide/svelte/icons/chevron-left";

  let {
    sources,
    change = null,
    files = [],
    showList = false,
    parents = [],
    parentIndex = 0,
    onback,
    onpick,
    onparent,
  }: {
    sources: DiffSources;
    change?: FileChange | null;
    /** Other files of the commit, for next / previous and the left list. */
    files?: readonly FileChange[];
    showList?: boolean;
    parents?: readonly string[];
    parentIndex?: number;
    onback: () => void;
    onpick?: (f: FileChange) => void;
    onparent?: (i: number) => void;
  } = $props();

  type Content =
    | { status: "loading" }
    | { status: "ready"; original: string; modified: string }
    | { status: "binary" }
    | { status: "error"; message: string };

  let content = $state<Content>({ status: "loading" });
  let pane: DiffPane | undefined = $state();
  let token = 0;
  let lastKey = "";

  const key = $derived(JSON.stringify([sources.original, sources.modified, change?.binary ?? false]));

  class BinaryError extends Error {}

  function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : api.isAppError(err) ? err.message : String(err);
  }

  async function loadSide(side: DiffSide): Promise<string> {
    if (side.kind === "empty") return "";
    if (side.kind === "git") {
      let text: string;
      try {
        text = await gitStore.run(catBlobArgs(side.spec));
      } catch (err) {
        if (err instanceof GitError && isMissingPathError(err.message)) return "";
        throw err;
      }
      if (looksBinary(text)) throw new BinaryError();
      return text;
    }
    const id = gitStore.sessionId;
    const repo = gitStore.repo;
    if (!id || !repo) throw new Error("No repository");
    try {
      const f = await api.readFile(id, join(repo, side.path));
      if (f.isBinary) throw new BinaryError();
      return f.content;
    } catch (err) {
      if (api.isAppError(err) && err.kind === "NotFound") return "";
      throw err;
    }
  }

  $effect(() => {
    const k = key;
    void gitStore.revision; // working changes can change under us (stage / unstage)
    const src = sources;
    const isBinary = change?.binary ?? false;
    const my = ++token;
    if (k !== lastKey) content = { status: "loading" };
    lastKey = k;
    if (isBinary) {
      content = { status: "binary" };
      return;
    }
    void (async () => {
      try {
        const [original, modified] = await Promise.all([loadSide(src.original), loadSide(src.modified)]);
        if (my !== token) return;
        const cur = content;
        if (cur.status === "ready" && cur.original === original && cur.modified === modified) return;
        content = { status: "ready", original, modified };
      } catch (err) {
        if (my !== token) return;
        content = err instanceof BinaryError ? { status: "binary" } : { status: "error", message: errMsg(err) };
      }
    })();
  });

  const idx = $derived(files.findIndex((f) => f.path === sources.path));
  function step(delta: number): void {
    const f = files[idx + delta];
    if (f) onpick?.(f);
  }

  function openInEditor(): void {
    const id = gitStore.sessionId;
    const repo = gitStore.repo;
    if (!id || !repo) return;
    void app.openFile(id, join(repo, sources.path));
    app.sidebarView = "explorer";
  }

  const btn =
    "inline-flex h-6 items-center gap-1 rounded-md border border-border bg-secondary px-2 text-[11px] text-secondary-foreground hover:opacity-90 disabled:opacity-40";
  const toggled = "border-primary bg-primary/15";
</script>

<div class="flex h-full min-h-0 flex-col bg-editor" data-testid="git-file-diff" data-path={sources.path}>
  <div class="flex flex-none flex-wrap items-center gap-1.5 border-b border-border bg-sidebar px-2 py-1 text-[12px]">
    <button type="button" class={btn} data-testid="diff-back" onclick={onback}><ArrowLeftIcon class="size-3.5" />Graph</button>
    <div class="flex min-w-0 flex-1 items-center gap-1.5">
      {#if change}
        <span class="shrink-0 rounded-sm border border-border px-1 text-[10px]" title={STATUS_LABEL[change.status]}>{change.status}</span>
      {/if}
      <span class="truncate font-medium" title={sources.path} data-testid="diff-title">{sources.path}</span>
      {#if sources.oldPath && sources.oldPath !== sources.path}
        <span class="truncate text-muted-foreground">(from {sources.oldPath})</span>
      {/if}
      <span class="truncate text-[11px] text-muted-foreground">{sources.originalLabel} &rarr; {sources.modifiedLabel}</span>
    </div>

    {#if parents.length > 1}
      <label class="flex items-center gap-1 text-[11px] text-muted-foreground">
        vs
        <select
          class="rounded-md border border-border bg-background px-1 py-0.5 text-[11px] text-foreground"
          data-testid="diff-parent-select"
          value={parentIndex}
          onchange={(e) => onparent?.(Number((e.currentTarget as HTMLSelectElement).value))}
        >
          {#each parents as p, i (p)}<option value={i}>parent {i + 1} ({shortSha(p)})</option>{/each}
        </select>
      </label>
    {/if}
    {#if files.length > 1}
      <button type="button" class={btn} aria-label="Previous file" disabled={idx <= 0} data-testid="diff-prev-file" onclick={() => step(-1)}><ChevronLeftIcon class="size-3.5" /></button>
      <button type="button" class={btn} aria-label="Next file" disabled={idx < 0 || idx >= files.length - 1} data-testid="diff-next-file" onclick={() => step(1)}><ChevronRightIcon class="size-3.5" /></button>
    {/if}
    <button type="button" class={btn} aria-label="Previous change" data-testid="diff-prev-change" onclick={() => pane?.goToDiff("previous")}><ArrowUpIcon class="size-3.5" /></button>
    <button type="button" class={btn} aria-label="Next change" data-testid="diff-next-change" onclick={() => pane?.goToDiff("next")}><ArrowDownIcon class="size-3.5" /></button>
    <button
      type="button"
      class={[btn, !settings.git.diffSideBySide && toggled]}
      data-testid="diff-toggle-inline"
      aria-pressed={!settings.git.diffSideBySide}
      onclick={() => (settings.git.diffSideBySide = !settings.git.diffSideBySide)}
    >
      {settings.git.diffSideBySide ? "Inline" : "Side by side"}
    </button>
    <button
      type="button"
      class={[btn, settings.git.ignoreWhitespace && toggled]}
      data-testid="diff-toggle-whitespace"
      aria-pressed={settings.git.ignoreWhitespace}
      title="Ignore leading and trailing whitespace"
      onclick={() => (settings.git.ignoreWhitespace = !settings.git.ignoreWhitespace)}
    >
      Ignore whitespace
    </button>
    <button type="button" class={btn} data-testid="diff-open-file" onclick={openInEditor}><ExternalLinkIcon class="size-3.5" />Open file</button>
  </div>

  <div class="flex min-h-0 flex-1">
    {#if showList && files.length > 0}
      <div class="w-[260px] flex-none overflow-auto border-r border-border bg-background" data-testid="diff-file-list">
        <ChangedFiles {files} mode="list" activePath={sources.path} onpick={(f) => onpick?.(f)} />
      </div>
    {/if}
    <div class="relative min-h-0 min-w-0 flex-1">
      {#if content.status === "ready"}
        <DiffPane
          bind:this={pane}
          original={content.original}
          modified={content.modified}
          path={sources.path}
          sideBySide={settings.git.diffSideBySide}
          ignoreWhitespace={settings.git.ignoreWhitespace}
        />
      {:else if content.status === "loading"}
        <div class="flex h-full items-center justify-center"><Loader label="Loading diff" /></div>
      {:else if content.status === "binary"}
        <div class="flex h-full items-center justify-center text-muted-foreground" data-testid="diff-binary">Binary file not shown.</div>
      {:else}
        <div class="flex h-full items-center justify-center p-4 text-destructive" data-testid="diff-error">{content.message}</div>
      {/if}
    </div>
  </div>
</div>
