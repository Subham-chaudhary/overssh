<script lang="ts">
  // Details pane for a selected commit (docs/GUIDE.md §14.4.G2).
  import Loader from "../../Loader.svelte";
  import ChangedFiles from "./ChangedFiles.svelte";
  import RefBadge from "./RefBadge.svelte";
  import { copyText } from "./actions";
  import type { CommitData } from "./commitData.svelte";
  import { formatAbsolute, formatRelative, shortSha } from "../../../lib/git/log";
  import type { FileChange } from "../../../lib/git/diff";
  import XIcon from "@lucide/svelte/icons/x";
  import CopyIcon from "@lucide/svelte/icons/copy";
  import ListIcon from "@lucide/svelte/icons/list";
  import ListTreeIcon from "@lucide/svelte/icons/list-tree";

  let {
    data,
    activePath = null,
    onclose,
    onselectsha,
    onpickfile,
    onparent,
  }: {
    data: CommitData;
    activePath?: string | null;
    onclose: () => void;
    onselectsha: (sha: string) => void;
    onpickfile: (f: FileChange) => void;
    onparent: (index: number) => void;
  } = $props();

  let mode = $state<"list" | "tree">("list");

  const d = $derived(data.detail);
  const subject = $derived(d ? d.message.split("\n")[0] : "");
  const body = $derived(d ? d.message.split("\n").slice(1).join("\n").trim() : "");
  const sameCommitter = $derived(
    d !== null && d.committerName === d.authorName && d.committerEmail === d.authorEmail && d.committerDate === d.authorDate,
  );

  const iconBtn = "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground";
</script>

<div class="flex h-full min-h-0 flex-col bg-background text-[12px]" data-testid="commit-details">
  <div class="flex h-7 flex-none items-center gap-1 border-b border-border bg-sidebar px-2">
    <span class="flex-1 truncate text-[11px] text-muted-foreground">Commit {data.sha ? shortSha(data.sha) : ""}</span>
    <button type="button" class={iconBtn} aria-label="Close details" data-testid="details-close" onclick={onclose}><XIcon class="size-3.5" /></button>
  </div>

  <div class="min-h-0 flex-1 overflow-auto">
    {#if data.error}
      <p class="p-3 text-destructive" data-testid="details-error">{data.error}</p>
    {:else if !d}
      <div class="flex justify-center p-4"><Loader label="Loading commit" /></div>
    {:else}
      <div class="flex flex-col gap-2 p-3">
        <div class="text-[13px] font-semibold break-words" data-testid="details-subject">{subject}</div>
        {#if body}
          <pre class="m-0 font-sans text-[12px] break-words whitespace-pre-wrap text-foreground/90" data-testid="details-body">{body}</pre>
        {/if}

        <dl class="m-0 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1">
          <dt class="text-muted-foreground">Commit</dt>
          <dd class="m-0 flex min-w-0 items-center gap-1">
            <code class="truncate font-mono text-[11px]" data-testid="details-sha">{d.sha}</code>
            <button type="button" class={iconBtn} aria-label="Copy SHA" onclick={() => void copyText(d.sha, "SHA")}><CopyIcon class="size-3" /></button>
          </dd>

          {#if d.parents.length}
            <dt class="text-muted-foreground">{d.parents.length > 1 ? "Parents" : "Parent"}</dt>
            <dd class="m-0 flex flex-wrap gap-x-2">
              {#each d.parents as p (p)}
                <button type="button" class="font-mono text-[11px] text-primary hover:underline" data-testid="details-parent" onclick={() => onselectsha(p)}>{shortSha(p)}</button>
              {/each}
            </dd>
          {/if}

          <dt class="text-muted-foreground">Author</dt>
          <dd class="m-0 min-w-0 break-words">
            {d.authorName} <span class="text-muted-foreground">&lt;{d.authorEmail}&gt;</span>
            <span class="text-muted-foreground" title={formatAbsolute(d.authorDate)}> - {formatAbsolute(d.authorDate)} ({formatRelative(d.authorDate)})</span>
          </dd>

          {#if !sameCommitter}
            <dt class="text-muted-foreground">Committer</dt>
            <dd class="m-0 min-w-0 break-words">
              {d.committerName} <span class="text-muted-foreground">&lt;{d.committerEmail}&gt;</span>
              <span class="text-muted-foreground"> - {formatAbsolute(d.committerDate)}</span>
            </dd>
          {/if}

          {#if d.refs.length}
            <dt class="text-muted-foreground">Refs</dt>
            <dd class="m-0 flex flex-wrap gap-1">
              {#each d.refs as r (r.kind + r.name)}<RefBadge ref={r} />{/each}
            </dd>
          {/if}
        </dl>
      </div>

      <div class="flex items-center gap-2 border-y border-border bg-sidebar px-3 py-1">
        <span class="flex-1 truncate text-[11px] text-muted-foreground" data-testid="details-summary">
          {data.files.length} file{data.files.length === 1 ? "" : "s"} changed
          <span class="text-emerald-600 dark:text-emerald-400">+{data.stats.added}</span>
          <span class="text-red-600 dark:text-red-400">-{data.stats.deleted}</span>
        </span>
        {#if d.parents.length > 1}
          <label class="flex items-center gap-1 text-[11px] text-muted-foreground">
            vs
            <select
              class="rounded-md border border-border bg-background px-1 py-0.5 text-[11px] text-foreground"
              data-testid="details-parent-select"
              value={data.parentIndex}
              onchange={(e) => onparent(Number((e.currentTarget as HTMLSelectElement).value))}
            >
              {#each d.parents as p, i (p)}
                <option value={i}>parent {i + 1} ({shortSha(p)})</option>
              {/each}
            </select>
          </label>
        {/if}
        <button type="button" class={[iconBtn, mode === "list" && "bg-accent text-accent-foreground"]} aria-label="Show as list" data-testid="files-mode-list" onclick={() => (mode = "list")}><ListIcon class="size-3.5" /></button>
        <button type="button" class={[iconBtn, mode === "tree" && "bg-accent text-accent-foreground"]} aria-label="Show as tree" data-testid="files-mode-tree" onclick={() => (mode = "tree")}><ListTreeIcon class="size-3.5" /></button>
      </div>

      {#if data.loading && data.files.length === 0}
        <div class="flex justify-center p-3"><Loader label="Loading files" /></div>
      {:else if data.files.length === 0}
        <p class="p-3 text-muted-foreground">No file changes{d.parents.length > 1 ? " against this parent" : ""}.</p>
      {:else}
        <ChangedFiles files={data.files} {mode} {activePath} onpick={onpickfile} />
      {/if}
    {/if}
  </div>
</div>
