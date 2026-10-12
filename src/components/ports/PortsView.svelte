<script lang="ts">
  // Ports sidebar: SSH port-forward manager (docs/GUIDE.md §13.4.P). Rules are
  // grouped by host; each can be started/stopped, edited, deleted.
  import { clipboardWrite } from "$lib/clipboard";
  import { onMount } from "svelte";
  import { app } from "../../lib/stores.svelte";
  import { settings } from "../../lib/settings.svelte";
  import { hostStore } from "../../lib/hosts.svelte";
  import {
    forwardStore,
    hostLabel,
    refreshStats,
    removeRule,
    runtimeOf,
    stopAll,
    runningCount,
    toggleRule,
  } from "../../lib/forwards.svelte";
  import type { ForwardRule } from "../../lib/types";
  import RuleDialog from "./RuleDialog.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import ClipboardPasteIcon from "@lucide/svelte/icons/clipboard-paste";
  import PlayIcon from "@lucide/svelte/icons/play";
  import SquareIcon from "@lucide/svelte/icons/square";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import CopyIcon from "@lucide/svelte/icons/copy";

  let dialogOpen = $state(false);
  let editing = $state<ForwardRule | null>(null);
  let startInPaste = $state(false);
  let lastRequest = forwardStore.formRequest;

  onMount(() => void refreshStats());

  // Palette commands ask the view to open the dialog.
  $effect(() => {
    const req = forwardStore.formRequest;
    if (req !== lastRequest) {
      lastRequest = req;
      openAdd(forwardStore.formMode === "paste");
    }
  });

  function openAdd(paste = false): void {
    editing = null;
    startInPaste = paste;
    dialogOpen = true;
  }

  function openEdit(rule: ForwardRule): void {
    editing = rule;
    startInPaste = false;
    dialogOpen = true;
  }

  async function doDelete(rule: ForwardRule): Promise<void> {
    const ok = await app.ask({
      title: "Delete forward",
      message: `Remove "${rule.label}"? A running forward is stopped first.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) await removeRule(rule.id);
  }

  const groups = $derived.by(() => {
    const byHost = new Map<string, ForwardRule[]>();
    for (const r of forwardStore.rules) {
      const list = byHost.get(r.host) ?? [];
      list.push(r);
      byHost.set(r.host, list);
    }
    return [...byHost.entries()].map(([host, rules]) => ({
      host,
      name: hostLabel(host),
      via: hostStore.items.find((h) => h.key === host)?.proxyJump ?? null,
      rules,
    }));
  });

  function spec(r: ForwardRule): string {
    const bind = r.bindAddress || (r.kind === "R" ? "localhost" : "127.0.0.1");
    if (r.kind === "D") return `SOCKS5 ${bind}:${r.bindPort}`;
    const arrow = `${r.targetHost}:${r.targetPort}`;
    return r.kind === "L" ? `${bind}:${r.bindPort} -> ${arrow}` : `VM ${bind}:${r.bindPort} -> ${arrow}`;
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }

  function localUrl(r: ForwardRule): string {
    const rt = runtimeOf(r.id);
    return `http://localhost:${rt.boundPort ?? r.bindPort}`;
  }

  async function copyUrl(r: ForwardRule): Promise<void> {
    const url = r.kind === "D" ? `socks5://localhost:${runtimeOf(r.id).boundPort ?? r.bindPort}` : localUrl(r);
    try {
      await clipboardWrite(url);
      app.addToast("success", `Copied ${url}`);
    } catch {
      app.addToast("info", url);
    }
  }

  async function openInBrowser(r: ForwardRule): Promise<void> {
    // No opener plugin in this build: copy the URL for the user to paste.
    await copyUrl(r);
  }

  const dotClass: Record<string, string> = {
    running: "bg-emerald-500",
    starting: "bg-amber-500 animate-pulse motion-reduce:animate-none",
    error: "bg-destructive",
    stopped: "bg-muted-foreground/40",
  };
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden" data-testid="ports-view">
  <div class="flex items-center gap-1 border-b border-border px-3 py-2">
    <span class="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Port forwards</span>
    <Button variant="ghost" size="icon-sm" title="Add from ssh command" aria-label="Add from ssh command" onclick={() => openAdd(true)} data-testid="ports-paste">
      <ClipboardPasteIcon />
    </Button>
    <Button variant="ghost" size="icon-sm" title="Forward a port" aria-label="Forward a port" onclick={() => openAdd(false)} data-testid="ports-add">
      <PlusIcon />
    </Button>
  </div>

  <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1">
    {#if groups.length === 0}
      <div class="flex flex-col gap-2 px-3 py-3 text-[12px] text-muted-foreground" data-testid="ports-empty">
        <span>No forwards yet. Add one, or paste a command like</span>
        <code class="rounded bg-muted px-1.5 py-1 font-mono text-[11px] break-all"
          >ssh -L 6443:127.0.0.1:6443 -N my-host</code
        >
        <Button size="sm" variant="secondary" onclick={() => openAdd(false)}>Forward a port…</Button>
      </div>
    {/if}

    {#each groups as g (g.host)}
      <div class="truncate px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground" data-testid="ports-group" data-host={g.host}>
        {g.name}{#if g.via}<span class="ml-1 font-normal">via {g.via}</span>{/if}
      </div>
      <ul class="flex flex-col gap-px px-1">
        {#each g.rules as r (r.id)}
          {@const rt = runtimeOf(r.id)}
          {@const active = rt.status === "running" || rt.status === "starting"}
          <li
            class="group flex flex-col gap-0.5 rounded-sm px-2 py-1 hover:bg-accent"
            data-testid="rule-row"
            data-rule-id={r.id}
            data-status={rt.status}
          >
            <div class="flex items-center gap-1.5">
              <span class={`size-2 shrink-0 rounded-full ${dotClass[rt.status]}`} data-testid="rule-status" data-status={rt.status} title={rt.status}></span>
              <span class="min-w-0 flex-1 truncate text-[13px] text-sidebar-foreground" title={r.label}>{r.label}</span>
              <span class="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">{r.kind}{r.tunnelOnly ? "N" : ""}</span>
              <button
                type="button"
                class="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                title={active ? "Stop" : "Start"}
                aria-label={`${active ? "Stop" : "Start"} ${r.label}`}
                onclick={() => void toggleRule(r.id)}
                data-testid="rule-toggle"
              >
                {#if active}<SquareIcon class="size-3.5" />{:else}<PlayIcon class="size-3.5" />{/if}
              </button>
            </div>
            <div class="truncate pl-3.5 font-mono text-[11px] text-muted-foreground" title={spec(r)}>{spec(r)}</div>
            {#if rt.status === "running"}
              <div class="pl-3.5 text-[11px] break-words text-muted-foreground" data-testid="rule-stats">
                {rt.activeConnections} active / {rt.totalConnections} total · in {fmtBytes(rt.bytesIn)} · out {fmtBytes(rt.bytesOut)}
              </div>
            {/if}
            {#if rt.error}
              <div class="pl-3.5 text-[11px] break-words text-destructive" data-testid="rule-error">{rt.error}</div>
            {/if}
            <div class="flex flex-wrap items-center gap-0.5 pl-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
              {#if r.kind === "L"}
                <button type="button" class="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Open in browser (copies http://localhost:port)" aria-label={`Open ${r.label} in browser`} onclick={() => void openInBrowser(r)} data-testid="rule-open">
                  <ExternalLinkIcon class="size-3.5" />
                </button>
              {/if}
              {#if r.kind !== "R"}
                <button type="button" class="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Copy local address" aria-label={`Copy address of ${r.label}`} onclick={() => void copyUrl(r)}>
                  <CopyIcon class="size-3.5" />
                </button>
              {/if}
              <button type="button" class="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Edit" aria-label={`Edit ${r.label}`} onclick={() => openEdit(r)} data-testid="rule-edit">
                <PencilIcon class="size-3.5" />
              </button>
              <button type="button" class="rounded-sm p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title="Delete" aria-label={`Delete ${r.label}`} onclick={() => void doDelete(r)} data-testid="rule-delete">
                <Trash2Icon class="size-3.5" />
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/each}
  </div>

  <div class="flex flex-col gap-2 border-t border-border px-3 py-2 text-[12px]">
    <label class="flex flex-wrap items-center justify-between gap-x-2 gap-y-1" title="Closing the window keeps running tunnels alive in the system tray">
      <span class="text-muted-foreground">Keep tunnels running in tray</span>
      <Switch size="sm" bind:checked={settings.ports.closeToTray} data-testid="ports-close-to-tray" />
    </label>
    {#if runningCount() > 0}
      <Button size="sm" variant="outline" onclick={() => void stopAll()} data-testid="ports-stop-all">
        Stop all ({runningCount()})
      </Button>
    {/if}
  </div>
</div>

<RuleDialog bind:open={dialogOpen} {editing} {startInPaste} />
