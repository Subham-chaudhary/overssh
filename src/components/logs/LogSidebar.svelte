<script lang="ts">
  import { untrack } from "svelte";
  import { app } from "$lib/stores.svelte";
  import * as api from "$lib/api";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import {
    closeLog,
    describeSource,
    logStore,
    openLog,
    removeSaved,
    saveSource,
    setPrefs,
  } from "$lib/logs.svelte";
  import type { LogDiscovery, LogSourceKind, LogSourceSpec } from "$lib/types";
  import XIcon from "@lucide/svelte/icons/x";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import BookmarkPlusIcon from "@lucide/svelte/icons/bookmark-plus";
  import FileTextIcon from "@lucide/svelte/icons/file-text";

  const DEFAULT_FILES = ["/var/log/syslog", "/var/log/messages", "/var/log/auth.log"];

  let sessionId = $state<string | null>(app.activeSessionId);
  let kind = $state<LogSourceKind>("file");
  let target = $state("");
  let sudo = $state(false);
  let discovery = $state<LogDiscovery | null>(null);
  let discovering = $state(false);
  let unit = $state("");
  let pathInput = $state<HTMLInputElement | null>(null);
  let lastFocusReq = logStore.focusOpenRequest;

  // Follow the active session unless the picked one is gone.
  $effect(() => {
    const ids = app.sessions.map((s) => s.id);
    if (!sessionId || !ids.includes(sessionId)) sessionId = app.activeSessionId ?? ids[0] ?? null;
  });

  let discoverSeq = 0;
  async function discover(id: string) {
    const mine = ++discoverSeq;
    discovering = true;
    try {
      const d = await api.logsDiscover(id);
      if (mine === discoverSeq) discovery = d; // the picked session changed meanwhile: not this one's list
    } catch {
      if (mine === discoverSeq) discovery = null;
    } finally {
      if (mine === discoverSeq) discovering = false;
    }
  }

  $effect(() => {
    const id = sessionId;
    discovery = null;
    if (id) untrack(() => void discover(id));
    else {
      discoverSeq++; // no session: drop an answer still on its way
      discovering = false;
    }
  });

  // Palette "Open Log File…" focuses the path box.
  $effect(() => {
    const req = logStore.focusOpenRequest;
    if (req !== lastFocusReq) {
      lastFocusReq = req;
      kind = "file";
      queueMicrotask(() => pathInput?.focus());
    }
  });

  const host = $derived.by(() => {
    const s = app.sessions.find((x) => x.id === sessionId);
    return s ? `${s.user}@${s.hostname}` : null;
  });
  const savedHere = $derived(logStore.saved.filter((s) => s.host === host));
  const explorerSelected = $derived(app.activeExplorer?.selected ?? null);
  const files = $derived(discovery?.files.length ? discovery.files : DEFAULT_FILES);

  function currentSpec(): LogSourceSpec | null {
    const t = target.trim();
    switch (kind) {
      case "file":
        return t ? { kind, path: t, sudo } : null;
      case "journal":
        return { kind, unit: t || undefined, sudo };
      case "docker":
        return t ? { kind, container: t, sudo } : null;
      default:
        return t ? { kind, command: t, sudo } : null;
    }
  }

  function open(spec: LogSourceSpec | null) {
    if (!spec || !sessionId) return;
    void openLog(sessionId, spec);
  }

  function saveCurrent() {
    const spec = currentSpec();
    if (!spec || !host) return;
    saveSource(host, describeSource(spec), spec);
  }

  const placeholder = $derived(
    kind === "file" ? "/var/log/app.log" : kind === "journal" ? "unit (optional), e.g. nginx" : kind === "docker" ? "container name" : "any command that prints logs",
  );
</script>

<div class="flex h-full min-w-0 flex-col overflow-x-hidden overflow-y-auto text-sm" data-testid="log-sidebar">
  <div class="border-b border-border p-3">
    <label class="mb-1 block text-xs font-medium text-muted-foreground" for="log-session">Session</label>
    {#if app.sessions.length === 0}
      <p class="text-xs text-muted-foreground">Connect to a host to read its logs.</p>
    {:else}
      <select
        id="log-session"
        bind:value={sessionId}
        data-testid="log-session"
        class="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground"
      >
        {#each app.sessions as s (s.id)}
          <option value={s.id}>{s.label}</option>
        {/each}
      </select>
    {/if}
  </div>

  {#if sessionId}
    <!-- open form -->
    <div class="space-y-2 border-b border-border p-3">
      <div class="text-xs font-medium text-muted-foreground">Open log…</div>
      <div class="flex gap-1.5">
        <select
          bind:value={kind}
          aria-label="Source type"
          data-testid="log-kind"
          class="h-8 max-w-[45%] flex-none rounded-lg border border-input bg-background px-1.5 text-xs text-foreground"
        >
          <option value="file">File</option>
          <option value="journal">Journal</option>
          <option value="docker">Docker</option>
          <option value="command">Command</option>
        </select>
        <Input
          bind:ref={pathInput}
          bind:value={target}
          {placeholder}
          class="h-8 min-w-0 flex-1 font-mono text-xs"
          aria-label="Log source"
          data-testid="log-target"
          onkeydown={(e) => {
            if (e.key === "Enter") open(currentSpec());
          }}
        />
      </div>
      {#if kind === "file" && explorerSelected}
        <button
          type="button"
          class="block w-full truncate text-left text-xs text-primary hover:underline"
          title={explorerSelected}
          onclick={() => (target = explorerSelected)}
        >
          Use explorer selection: {explorerSelected}
        </button>
      {/if}
      <label class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <input type="checkbox" bind:checked={sudo} class="accent-primary" />
        Run with sudo (asks for password)
      </label>
      <div class="flex gap-1.5">
        <Button size="sm" class="min-w-0 flex-1" data-testid="log-open" disabled={!currentSpec()} onclick={() => open(currentSpec())}>Open</Button>
        <Button size="sm" variant="outline" disabled={!currentSpec()} title="Save this source for this host" aria-label="Save source" onclick={saveCurrent}>
          <BookmarkPlusIcon class="size-4" />
        </Button>
      </div>
    </div>

    <!-- quick picks -->
    <div class="space-y-1 border-b border-border p-3">
      <div class="flex items-center justify-between text-xs font-medium text-muted-foreground">
        Quick picks
        <Button variant="ghost" size="icon-xs" aria-label="Rescan" title="Rescan this host" disabled={discovering} onclick={() => sessionId && void discover(sessionId)}>
          <RefreshCwIcon class={["size-3", discovering && "animate-spin motion-reduce:animate-none"]} />
        </Button>
      </div>
      {#each files as f (f)}
        <button
          type="button"
          class="flex w-full items-center gap-1.5 truncate rounded-md px-1.5 py-1 text-left font-mono text-xs hover:bg-accent"
          data-testid="log-quick-file"
          onclick={() => open({ kind: "file", path: f })}
        >
          <FileTextIcon class="size-3.5 shrink-0 opacity-70" />{f}
        </button>
      {/each}
      <button
        type="button"
        class="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left font-mono text-xs hover:bg-accent"
        data-testid="log-quick-journal"
        onclick={() => open({ kind: "journal" })}
      >
        journalctl
      </button>
      <div class="flex gap-1">
        <Input
          bind:value={unit}
          list="log-units"
          placeholder="journalctl -u <unit>"
          class="h-7 min-w-0 flex-1 font-mono text-xs"
          aria-label="Journal unit"
          onkeydown={(e) => {
            if (e.key === "Enter" && unit.trim()) open({ kind: "journal", unit: unit.trim() });
          }}
        />
        <datalist id="log-units">
          {#each discovery?.units ?? [] as u (u)}<option value={u}></option>{/each}
        </datalist>
        <Button size="sm" variant="outline" disabled={!unit.trim()} onclick={() => open({ kind: "journal", unit: unit.trim() })}>Go</Button>
      </div>
      {#if discovery?.containers.length}
        <div class="pt-1 text-xs font-medium text-muted-foreground">Docker containers</div>
        {#each discovery.containers as c (c)}
          <button
            type="button"
            class="flex w-full items-center truncate rounded-md px-1.5 py-1 text-left font-mono text-xs hover:bg-accent"
            data-testid="log-quick-docker"
            onclick={() => open({ kind: "docker", container: c })}
          >
            {c}
          </button>
        {/each}
      {/if}
    </div>

    <!-- saved -->
    {#if savedHere.length}
      <div class="space-y-1 border-b border-border p-3">
        <div class="text-xs font-medium text-muted-foreground">Saved for {host}</div>
        {#each savedHere as s (s.id)}
          <div class="group flex items-center rounded-md hover:bg-accent">
            <button
              type="button"
              class="min-w-0 flex-1 truncate px-1.5 py-1 text-left font-mono text-xs"
              title={describeSource(s.source)}
              data-testid="log-saved"
              onclick={() => open(s.source)}
            >
              {s.name}
            </button>
            <button type="button" class="mr-1 hidden rounded p-0.5 hover:bg-background group-hover:block" aria-label={`Remove saved ${s.name}`} onclick={() => removeSaved(s.id)}>
              <XIcon class="size-3" />
            </button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- open streams -->
  <div class="space-y-1 border-b border-border p-3">
    <div class="text-xs font-medium text-muted-foreground">Open logs ({logStore.tabs.length})</div>
    {#each logStore.tabs as t (t.id)}
      <div class={["group flex items-center rounded-md hover:bg-accent", t.id === logStore.activeId && "bg-accent"]}>
        <button
          type="button"
          class="min-w-0 flex-1 truncate px-1.5 py-1 text-left text-xs"
          data-testid="log-open-stream"
          onclick={() => {
            logStore.activeId = t.id;
          }}
        >
          <span
            class={[
              "mr-1 inline-block size-2 rounded-full align-middle",
              t.status === "live" ? "bg-success" : t.status === "error" ? "bg-destructive" : "bg-muted-foreground",
            ]}
          ></span>{t.title}
          <span class="text-muted-foreground">{t.sessionLabel}</span>
        </button>
        <button type="button" class="mr-1 rounded p-0.5 hover:bg-background" aria-label={`Close ${t.title}`} onclick={() => void closeLog(t.id)}>
          <XIcon class="size-3" />
        </button>
      </div>
    {/each}
  </div>

  <!-- prefs -->
  <div class="space-y-2 p-3">
    <div class="text-xs font-medium text-muted-foreground">Buffer</div>
    <label class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
      Max lines kept
      <input
        type="number"
        min="1000"
        step="1000"
        class="h-7 w-20 rounded-md border border-input bg-transparent px-1.5 text-xs"
        value={logStore.prefs.maxLines}
        data-testid="log-max-lines"
        onchange={(e) => setPrefs({ maxLines: Math.max(1000, Number(e.currentTarget.value) || 100_000) })}
      />
    </label>
    <label class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs">
      Initial tail lines
      <input
        type="number"
        min="0"
        step="100"
        class="h-7 w-20 rounded-md border border-input bg-transparent px-1.5 text-xs"
        value={logStore.prefs.tailLines}
        onchange={(e) => setPrefs({ tailLines: Math.max(0, Number(e.currentTarget.value) || 0) })}
      />
    </label>
  </div>
</div>
