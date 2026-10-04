<script lang="ts">
  // Git main-area page: commit graph, commit details and diffs (docs/GUIDE.md §14, §14.4.G2). Owner: agent G2.
  import { untrack } from "svelte";
  import CommitGraph from "./graph/CommitGraph.svelte";
  import CommitDetails from "./graph/CommitDetails.svelte";
  import WorkingDetails from "./graph/WorkingDetails.svelte";
  import FileDiffView from "./graph/FileDiffView.svelte";
  import Splitter from "./graph/Splitter.svelte";
  import { GraphData, ALL_REFS } from "./graph/graphData.svelte";
  import { CommitData } from "./graph/commitData.svelte";
  import { gitStore } from "../../lib/git/git.svelte";
  import { settings } from "../../lib/settings.svelte";
  import { UNCOMMITTED } from "../../lib/git/graph";
  import { changeDiffSources, commitDiffSources, type FileChange, type WorkingChange } from "../../lib/git/diff";
  import { app } from "../../lib/stores.svelte";
  import SearchIcon from "@lucide/svelte/icons/search";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import PanelBottomIcon from "@lucide/svelte/icons/panel-bottom";
  import PanelRightIcon from "@lucide/svelte/icons/panel-right";
  import Loader from "../Loader.svelte";

  const data = new GraphData();
  const commitData = new CommitData();

  let query = $state("");
  let uncommittedOpen = $state(false);
  let detailsPos = $state<"bottom" | "side">("bottom");
  let detailsSize = $state(300);
  let pageW = $state(900);
  let pageH = $state(600);

  /** Narrow pages always stack the details below the graph. */
  const side = $derived(detailsPos === "side" && pageW >= 760);
  const showFileList = $derived(pageW >= 760);

  const selection = $derived(gitStore.selection);
  const selSha = $derived(selection?.kind === "commit" ? selection.sha : null);
  const detailsOpen = $derived(selSha !== null || uncommittedOpen);
  const maxSize = $derived(Math.max(140, (side ? pageW : pageH) - 220));
  const effectiveSize = $derived(Math.min(detailsSize, maxSize));

  // --- loading -----------------------------------------------------------------
  let scope = "";
  $effect(() => {
    const key = `${gitStore.sessionId}|${gitStore.repo}`;
    void gitStore.revision;
    void settings.git.graphAllBranches;
    void settings.git.graphMaxCommits;
    void settings.git.showRemoteBranches;
    untrack(() => {
      if (key !== scope) {
        scope = key;
        data.reset();
        data.refFilter = null;
        commitData.clear();
        uncommittedOpen = false;
        query = "";
      }
    });
    const t = setTimeout(() => void data.reload(), 30);
    return () => clearTimeout(t);
  });

  function remoteNames(): Set<string> {
    return new Set(data.refs.filter((r) => r.kind === "remote").map((r) => r.name));
  }

  // Load the selected commit's details whenever the selection (not just its path) changes.
  $effect(() => {
    const sha = selSha;
    untrack(() => {
      if (!gitStore.repo) return;
      if (sha) {
        uncommittedOpen = false;
        commitData.setRemotes(remoteNames());
        if (commitData.sha !== sha) void commitData.load(sha, 0);
      } else {
        commitData.clear();
      }
    });
  });

  // --- selection helpers ---------------------------------------------------------
  function selectRow(sha: string): void {
    if (sha === UNCOMMITTED) {
      gitStore.selection = null;
      uncommittedOpen = true;
    } else {
      gitStore.selection = { kind: "commit", sha };
    }
  }

  function closeDetails(): void {
    gitStore.selection = null;
    uncommittedOpen = false;
  }

  function pickCommitFile(f: FileChange): void {
    const sha = commitData.sha;
    if (sha) gitStore.selection = { kind: "commit", sha, path: f.path };
  }

  function pickWorking(c: WorkingChange): void {
    gitStore.selection = { kind: "change", path: c.path, staged: c.staged, untracked: c.untracked };
  }

  function changeParent(i: number): void {
    if (commitData.sha) void commitData.load(commitData.sha, i);
  }

  function backFromDiff(): void {
    const s = gitStore.selection;
    if (s?.kind === "commit") gitStore.selection = { kind: "commit", sha: s.sha };
    else gitStore.selection = null;
  }

  // --- diff page state -----------------------------------------------------------
  const diff = $derived.by(() => {
    const s = selection;
    if (!s) return null;
    if (s.kind === "change") {
      const oldPath = data.dirty.find((c) => c.path === s.path && c.staged === s.staged)?.oldPath;
      const untracked = s.untracked ?? data.dirty.some((c) => c.path === s.path && c.untracked);
      return { sources: changeDiffSources({ path: s.path, staged: s.staged, untracked, oldPath }), change: null, commit: false as const };
    }
    if (!s.path) return null;
    const detail = commitData.detail;
    if (!detail || commitData.sha !== s.sha || (commitData.loading && commitData.files.length === 0)) return "loading" as const;
    const file: FileChange = commitData.files.find((f) => f.path === s.path) ?? {
      path: s.path,
      status: "M",
      added: 0,
      deleted: 0,
      binary: false,
    };
    return { sources: commitDiffSources(detail.sha, commitData.parent, file), change: file, commit: true as const };
  });

  const selected = $derived(selSha ?? (uncommittedOpen ? UNCOMMITTED : null));

  const filterOptions = $derived.by(() => {
    const groups = [
      { label: "Local branches", refs: data.refs.filter((r) => r.kind === "branch") },
      { label: "Remote branches", refs: data.refs.filter((r) => r.kind === "remote") },
      { label: "Tags", refs: data.refs.filter((r) => r.kind === "tag") },
    ];
    return groups.filter((g) => g.refs.length > 0);
  });
  const filterValue = $derived(data.refFilter ?? "");

  function onFilter(e: Event): void {
    const v = (e.currentTarget as HTMLSelectElement).value;
    data.setRefFilter(v === "" ? null : v);
  }

  const iconBtn =
    "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40";
</script>

<div
  class="flex h-full min-h-0 min-w-0 flex-col bg-editor text-foreground"
  data-testid="git-view"
  bind:clientWidth={pageW}
  bind:clientHeight={pageH}
>
  {#if !app.activeSessionId}
    <div class="flex h-full items-center justify-center p-6 text-[12px] text-muted-foreground" data-testid="git-empty-session">
      Connect to a host to see its Git history.
    </div>
  {:else if !gitStore.repo}
    <div class="flex h-full items-center justify-center p-6 text-center text-[12px] text-muted-foreground" data-testid="git-empty-repo">
      No Git repository found here. Open a folder inside a repository from the Explorer, or initialize one from Source Control.
    </div>
  {:else if diff === "loading"}
    <div class="flex h-full items-center justify-center"><Loader label="Loading diff" /></div>
  {:else if diff}
    <FileDiffView
      sources={diff.sources}
      change={diff.change}
      files={diff.commit ? commitData.files : []}
      showList={diff.commit && showFileList}
      parents={diff.commit ? (commitData.detail?.parents ?? []) : []}
      parentIndex={commitData.parentIndex}
      onback={backFromDiff}
      onpick={pickCommitFile}
      onparent={changeParent}
    />
  {:else}
    <div class="flex flex-none items-center gap-2 border-b border-border bg-sidebar px-2 py-1" data-testid="graph-toolbar">
      <select
        class="h-6 max-w-[220px] rounded-md border border-border bg-background px-1.5 text-[12px]"
        data-testid="graph-branch-filter"
        aria-label="Branch filter"
        value={filterValue}
        onchange={onFilter}
      >
        <option value="">{settings.git.graphAllBranches ? "All branches (default)" : "Current branch (default)"}</option>
        <option value={ALL_REFS}>All branches</option>
        <option value="HEAD">Current branch</option>
        {#each filterOptions as g (g.label)}
          <optgroup label={g.label}>
            {#each g.refs as r (r.full)}<option value={r.full}>{r.name}</option>{/each}
          </optgroup>
        {/each}
      </select>
      <div class="relative min-w-0 flex-1">
        <SearchIcon class="pointer-events-none absolute top-1/2 left-1.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          class="h-6 w-full rounded-md border border-border bg-background pr-2 pl-6 text-[12px] outline-none focus-visible:border-ring"
          placeholder="Search message, author or SHA"
          aria-label="Search commits"
          data-testid="graph-search"
          bind:value={query}
        />
      </div>
      <button type="button" class={iconBtn} aria-label="Refresh" title="Refresh" data-testid="graph-refresh" onclick={() => gitStore.revision++}>
        <RefreshCwIcon class={["size-3.5", data.loading && "animate-spin"]} />
      </button>
      <button
        type="button"
        class={iconBtn}
        aria-label={side ? "Show details below" : "Show details at the side"}
        title={side ? "Show details below" : "Show details at the side"}
        data-testid="details-position"
        disabled={pageW < 760}
        onclick={() => (detailsPos = detailsPos === "side" ? "bottom" : "side")}
      >
        {#if side}<PanelBottomIcon class="size-3.5" />{:else}<PanelRightIcon class="size-3.5" />{/if}
      </button>
    </div>

    <div class={["flex min-h-0 flex-1", side ? "flex-row" : "flex-col"]}>
      <div class="min-h-0 min-w-0 flex-1">
        <CommitGraph {data} {selected} {query} width={pageW} onselect={selectRow} />
      </div>
      {#if detailsOpen}
        <Splitter vertical={side} bind:size={detailsSize} min={140} max={maxSize} testid="details-splitter" />
        <div
          class="flex-none overflow-hidden"
          style={side ? `width:${effectiveSize}px` : `height:${effectiveSize}px`}
          data-testid="details-pane"
        >
          {#if selSha}
            <CommitDetails
              data={commitData}
              activePath={selection?.kind === "commit" ? (selection.path ?? null) : null}
              onclose={closeDetails}
              onselectsha={selectRow}
              onpickfile={pickCommitFile}
              onparent={changeParent}
            />
          {:else}
            <WorkingDetails changes={data.dirty} onclose={closeDetails} onpick={pickWorking} />
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
