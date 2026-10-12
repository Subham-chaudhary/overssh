<script lang="ts">
  // One changed file in a Source Control section.
  import { clipboardWrite } from "$lib/clipboard";
  import { gitStore } from "$lib/git/git.svelte";
  import { badgeTitle, type Change } from "$lib/git/status";
  import { basename, dirname } from "$lib/paths";
  import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
  import IconButton from "./IconButton.svelte";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import Undo2Icon from "@lucide/svelte/icons/undo-2";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import MinusIcon from "@lucide/svelte/icons/minus";

  let {
    change,
    kind,
    depth = 0,
    showDir = true,
  }: { change: Change; kind: "merge" | "staged" | "changes"; depth?: number; showDir?: boolean } = $props();

  const name = $derived(basename(change.path));
  const dir = $derived(dirname(change.path));
  const selected = $derived.by(() => {
    const s = gitStore.selection;
    return s?.kind === "change" && s.path === change.path && s.staged === change.staged;
  });
  const deleted = $derived(change.code === "D");

  const badge = $derived(
    change.conflict || change.code === "D"
      ? "text-destructive"
      : change.code === "A"
        ? "text-success"
        : change.code === "?"
          ? "text-secondary"
          : change.code === "R" || change.code === "C"
            ? "text-primary"
            : "text-warning",
  );
  const title = $derived(
    `${change.path}${change.origPath ? ` (from ${change.origPath})` : ""} - ${badgeTitle(change)}${change.submodule ? " (submodule)" : ""}`,
  );

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      gitStore.select(change);
    }
  }
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger class="block">
    <div
      role="button"
      tabindex="0"
      {title}
      data-testid="scm-row"
      data-path={change.path}
      data-kind={kind}
      data-code={change.code}
      aria-pressed={selected}
      class="group flex h-[22px] cursor-default items-center gap-1 pr-1.5 outline-none hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring {selected
        ? 'bg-muted'
        : ''}"
      style:padding-left="{8 + depth * 12}px"
      onclick={() => gitStore.select(change)}
      ondblclick={() => !deleted && gitStore.openFile(change)}
      onkeydown={onKey}
    >
      <span class="min-w-0 truncate {deleted ? 'line-through opacity-70' : ''}">{name}</span>
      {#if showDir && dir !== "." && dir !== "/" && dir !== ""}
        <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{dir}</span>
      {:else}
        <span class="flex-1"></span>
      {/if}
      <span class="hidden items-center gap-0.5 group-focus-within:flex group-hover:flex">
        {#if !deleted}
          <IconButton title="Open File" testid="scm-open-file" onclick={() => gitStore.openFile(change)}><FileTextIcon /></IconButton>
        {/if}
        {#if kind === "changes"}
          <IconButton title={change.untracked ? "Delete File" : "Discard Changes"} testid="scm-discard" onclick={() => void gitStore.discard([change])}>
            <Undo2Icon />
          </IconButton>
        {/if}
        {#if kind === "staged"}
          <IconButton title="Unstage Changes" testid="scm-unstage" onclick={() => void gitStore.unstage([change])}><MinusIcon /></IconButton>
        {:else}
          <IconButton title={kind === "merge" ? "Mark as Resolved (Stage)" : "Stage Changes"} testid="scm-stage" onclick={() => void gitStore.stage([change])}>
            <PlusIcon />
          </IconButton>
        {/if}
      </span>
      <span class="w-3.5 shrink-0 text-center text-[11px] font-semibold {badge}" data-testid="scm-badge">{change.code}</span>
    </div>
  </ContextMenu.Trigger>
  <ContextMenu.Content>
    <ContextMenu.Item onclick={() => gitStore.select(change)}>Open Changes</ContextMenu.Item>
    {#if !deleted}<ContextMenu.Item onclick={() => gitStore.openFile(change)}>Open File</ContextMenu.Item>{/if}
    <ContextMenu.Separator />
    {#if kind === "staged"}
      <ContextMenu.Item onclick={() => void gitStore.unstage([change])}>Unstage Changes</ContextMenu.Item>
    {:else}
      <ContextMenu.Item onclick={() => void gitStore.stage([change])}>{kind === "merge" ? "Mark as Resolved" : "Stage Changes"}</ContextMenu.Item>
      {#if kind === "changes"}
        <ContextMenu.Item onclick={() => void gitStore.discard([change])}>{change.untracked ? "Delete File" : "Discard Changes"}</ContextMenu.Item>
      {/if}
    {/if}
    <ContextMenu.Separator />
    <ContextMenu.Item onclick={() => void clipboardWrite(change.path)}>Copy Relative Path</ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
