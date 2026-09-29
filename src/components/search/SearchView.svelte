<script lang="ts">
  // Sidebar "Search" view (docs/GUIDE.md §13.4.R): grep/rg across files on the VM.
  import { tick } from "svelte";
  import { app } from "$lib/stores.svelte";
  import {
    searchStore as s,
    effectiveRoot,
    runSearch,
    cancelSearch,
    clearResults,
    highlightRegex,
    openMatch,
  } from "$lib/search.svelte";
  import { basename, dirname } from "$lib/paths";

  let queryEl = $state<HTMLInputElement | null>(null);

  const root = $derived(effectiveRoot());
  const resultRoot = $derived(s.resultRoot);
  const canSearch = $derived(!!s.query && !!app.activeSessionId && !!root);

  $effect(() => {
    if (s.focusRequest > 0) {
      void tick().then(() => {
        queryEl?.focus();
        queryEl?.select();
      });
    }
  });

  function rel(path: string): string {
    const base = resultRoot.endsWith("/") ? resultRoot : resultRoot + "/";
    return path.startsWith(base) ? path.slice(base.length) : path;
  }

  function relDir(path: string): string {
    const d = dirname(rel(path));
    return d === "." || d === "/" || d === "" ? "" : d;
  }

  /** Splits `text` into [text, isMatch] segments using the current query flags. */
  function segments(text: string, re: RegExp | null): [string, boolean][] {
    const t = text.replace(/^\s+/, "");
    if (!re) return [[t, false]];
    const out: [string, boolean][] = [];
    let last = 0;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      if (m[0] === "") {
        re.lastIndex++;
        continue;
      }
      if (m.index > last) out.push([t.slice(last, m.index), false]);
      out.push([m[0], true]);
      last = m.index + m[0].length;
    }
    if (last < t.length) out.push([t.slice(last), false]);
    return out.length ? out : [[t, false]];
  }

  const hl = $derived(highlightRegex());

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      void runSearch();
    }
  }

  const toggleCls = (on: boolean) =>
    "flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] leading-none " +
    (on ? "bg-primary/30 text-foreground ring-1 ring-primary" : "text-muted-foreground hover:bg-accent");
  const inputCls =
    "h-7 w-full min-w-0 rounded border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring";
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden text-sm" data-testid="search-view">
  <div class="flex flex-col gap-1.5 border-b border-border p-2">
    <div class="flex items-center justify-between">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Search</span>
      <button
        type="button"
        class="rounded px-1 text-[11px] text-muted-foreground hover:bg-accent"
        title="Clear results"
        aria-label="Clear search results"
        onclick={clearResults}>Clear</button
      >
    </div>

    <div class="relative">
      <input
        bind:this={queryEl}
        bind:value={s.query}
        onkeydown={onKey}
        class={inputCls + " pr-[4.5rem]"}
        placeholder="Search"
        aria-label="Search query"
        data-testid="search-query"
        spellcheck="false"
        autocomplete="off"
      />
      <div class="absolute right-1 top-1 flex gap-0.5">
        <button type="button" class={toggleCls(s.caseSensitive)} title="Match case" aria-label="Match case" aria-pressed={s.caseSensitive} onclick={() => (s.caseSensitive = !s.caseSensitive)}>Aa</button>
        <button type="button" class={toggleCls(s.wholeWord)} title="Match whole word" aria-label="Match whole word" aria-pressed={s.wholeWord} onclick={() => (s.wholeWord = !s.wholeWord)}><span class="underline decoration-1 underline-offset-2">ab</span></button>
        <button type="button" class={toggleCls(s.regex)} title="Use regular expression" aria-label="Use regular expression" aria-pressed={s.regex} onclick={() => (s.regex = !s.regex)}>.*</button>
      </div>
    </div>

    <button
      type="button"
      class="self-start text-[11px] text-muted-foreground hover:text-foreground"
      aria-expanded={s.showDetails}
      onclick={() => (s.showDetails = !s.showDetails)}
    >
      {s.showDetails ? "▾" : "▸"} Filters
    </button>

    {#if s.showDetails}
      <label class="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
        Folder
        <input bind:value={s.root} onkeydown={onKey} class={inputCls} placeholder={app.activeExplorer?.cwd ?? "/"} aria-label="Search folder" data-testid="search-root" spellcheck="false" />
      </label>
      <label class="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
        Files to include
        <input bind:value={s.include} onkeydown={onKey} class={inputCls} placeholder="e.g. *.ts, *.svelte" aria-label="Files to include" data-testid="search-include" spellcheck="false" />
      </label>
      <label class="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
        Files to exclude
        <input bind:value={s.exclude} onkeydown={onKey} class={inputCls} placeholder="e.g. *.min.js" aria-label="Files to exclude" data-testid="search-exclude" spellcheck="false" />
      </label>
      <label class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <input type="checkbox" bind:checked={s.hidden} /> Include hidden files
      </label>
      <p class="text-[10px] text-muted-foreground">Always skipped: .git, node_modules, .cache, __pycache__, venv, .venv, dist, build, target.</p>
    {/if}

    <div class="flex min-w-0 items-center gap-1.5">
      {#if s.running}
        <button type="button" class="h-6 flex-none rounded bg-destructive/80 px-2 text-xs text-white hover:bg-destructive" data-testid="search-cancel" onclick={cancelSearch}>Cancel</button>
        <span class="inline-block h-3 w-3 flex-none animate-spin rounded-full border border-muted-foreground border-t-transparent motion-reduce:animate-pulse" role="status" aria-label="Searching"></span>
      {:else}
        <button type="button" class="h-6 flex-none rounded bg-primary px-2 text-xs text-primary-foreground disabled:opacity-50" disabled={!canSearch} data-testid="search-run" onclick={runSearch}>Search</button>
      {/if}
      <span class="min-w-0 truncate text-[11px] text-muted-foreground" title={root}>in {root || "(no session)"}</span>
    </div>
  </div>

  <div class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto" data-testid="search-results">
    {#if !app.activeSessionId}
      <p class="p-3 text-xs text-muted-foreground">Connect to a host to search.</p>
    {/if}

    {#if s.error}
      <p class="p-2 text-xs text-destructive" data-testid="search-error">{s.error}</p>
    {/if}

    {#if s.running || s.done}
      <p class="px-2 py-1 text-[11px] text-muted-foreground" data-testid="search-summary">
        {s.total}{s.truncated ? "+" : ""} result{s.total === 1 ? "" : "s"} in {s.groups.length} file{s.groups.length === 1 ? "" : "s"}{s.running ? "…" : ""}{s.cancelled && !s.running ? " (cancelled)" : ""}
      </p>
      {#if s.truncated}
        <p class="px-2 pb-1 text-[11px] text-amber-500" data-testid="search-truncated">Results truncated at the limit. Refine your search.</p>
      {/if}
      {#if s.done && !s.running && !s.error && s.total === 0 && !s.cancelled}
        <p class="px-2 text-xs text-muted-foreground">No results found.</p>
      {/if}
    {/if}

    {#each s.groups as g (g.path)}
      <div data-testid="search-group" data-path={g.path}>
        <button
          type="button"
          class="flex w-full min-w-0 items-center gap-1 px-1.5 py-0.5 text-left text-xs hover:bg-accent"
          aria-expanded={!g.collapsed}
          title={g.path}
          onclick={() => (g.collapsed = !g.collapsed)}
        >
          <span class="w-3 shrink-0 text-muted-foreground">{g.collapsed ? "▸" : "▾"}</span>
          <span class="min-w-0 shrink-0 max-w-[70%] truncate font-medium">{basename(g.path)}</span>
          <span class="min-w-0 truncate text-[11px] text-muted-foreground">{relDir(g.path)}</span>
          <span class="ml-auto shrink-0 rounded-full bg-muted px-1.5 text-[10px]">{g.matches.length}</span>
        </button>
        {#if !g.collapsed}
          {#each g.matches as m (m.line)}
            <button
              type="button"
              class="flex w-full min-w-0 items-baseline gap-1.5 truncate py-px pl-6 pr-2 text-left font-mono text-[11px] hover:bg-accent"
              data-testid="search-match"
              title={`${g.path}:${m.line}`}
              onclick={() => openMatch(g.path, m.line, m.text)}
            >
              <span class="shrink-0 text-muted-foreground">{m.line}</span>
              <span class="truncate">{#each segments(m.text, hl) as [t, hit]}{#if hit}<mark class="rounded-sm bg-primary/30 text-foreground">{t}</mark>{:else}{t}{/if}{/each}</span>
            </button>
          {/each}
        {/if}
      </div>
    {/each}
  </div>
</div>
