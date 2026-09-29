<script lang="ts">
  // File / folder Properties dialog (docs/GUIDE.md §14.4.X). One path: full
  // details from `api.fileInfo` (SFTP lstat + exec stat). Several paths: a
  // summary built from `api.stat`. Folder sizes are calculated on demand
  // (`api.dirSize`, du over exec) because walking a big tree can be slow.
  import { onMount } from "svelte";
  import * as api from "../lib/api";
  import { app } from "../lib/stores.svelte";
  import { languageName } from "../lib/languages";
  import {
    formatTime,
    humanSize,
    modeOctal,
    modeString,
    ownerLabel,
    sizeWithBytes,
  } from "../lib/fileinfo";
  import type { DirSize, FileEntry, FileInfo } from "../lib/types";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import FileTypeIcon from "./FileTypeIcon.svelte";
  import CopyIcon from "@lucide/svelte/icons/copy";

  let {
    sessionId,
    paths,
    onClose,
  }: { sessionId: string; paths: string[]; onClose: () => void } = $props();

  const MAX_MULTI = 500;

  // Snapshot: the parent clears its state when the dialog closes.
  // svelte-ignore state_referenced_locally
  const targets = paths.slice(0, MAX_MULTI);
  const multi = targets.length > 1;

  let info = $state<FileInfo | null>(null);
  let entries = $state<FileEntry[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let sizing = $state(false);
  let sizeError = $state<string | null>(null);
  let single = $state<DirSize | null>(null);
  let multiSize = $state<DirSize | null>(null);

  onMount(async () => {
    try {
      if (multi) {
        const results = await Promise.allSettled(targets.map((p) => api.stat(sessionId, p)));
        entries = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
        if (entries.length === 0) error = "Could not read any of the selected items.";
      } else {
        info = await api.fileInfo(sessionId, targets[0]);
      }
    } catch (err) {
      error = api.isAppError(err) ? err.message : String(err);
    } finally {
      loading = false;
    }
  });

  const isDir = $derived(
    info !== null &&
      (info.kind === "dir" || (info.kind === "symlink" && info.linkTargetKind === "dir")),
  );
  const dirEntries = $derived(
    entries.filter((e) => e.kind === "dir" || (e.kind === "symlink" && e.linkTargetIsDir === true)),
  );
  const fileEntries = $derived(entries.filter((e) => !dirEntries.includes(e)));
  const filesTotal = $derived(fileEntries.reduce((n, e) => n + e.size, 0));

  const typeLabel = $derived.by(() => {
    if (!info) return "";
    switch (info.kind) {
      case "dir":
        return "Folder";
      case "file":
        return "File";
      case "symlink":
        return info.linkTargetKind === "dir"
          ? "Symbolic link to a folder"
          : info.linkTargetKind
            ? "Symbolic link to a file"
            : "Symbolic link (broken)";
      default:
        return "Special file";
    }
  });

  function errText(err: unknown): string {
    return api.isAppError(err) ? err.message : String(err);
  }

  async function calcSingle(): Promise<void> {
    if (!info || sizing) return;
    sizing = true;
    sizeError = null;
    try {
      single = await api.dirSize(sessionId, info.path);
    } catch (err) {
      sizeError = errText(err);
    } finally {
      sizing = false;
    }
  }

  async function calcMulti(): Promise<void> {
    if (sizing) return;
    sizing = true;
    sizeError = null;
    try {
      const total: DirSize = { bytes: 0, files: 0, dirs: 0, partial: false };
      for (const d of dirEntries) {
        const s = await api.dirSize(sessionId, d.path);
        total.bytes += s.bytes;
        total.files += s.files;
        total.dirs += s.dirs + 1;
        total.partial ||= s.partial;
      }
      multiSize = total;
    } catch (err) {
      sizeError = errText(err);
    } finally {
      sizing = false;
    }
  }

  function copy(text: string): void {
    void app.copyPath(text);
  }

  function onOpenChange(open: boolean): void {
    if (!open) onClose();
  }
</script>

{#snippet row(label: string, value: string, testid: string, mono = false)}
  <div class="contents">
    <dt class="text-muted-foreground">{label}</dt>
    <dd class={`min-w-0 break-all ${mono ? "font-mono" : ""}`} data-testid={testid}>{value}</dd>
  </div>
{/snippet}

<Dialog.Root open={true} {onOpenChange}>
  <Dialog.Content class="sm:max-w-lg" data-testid="file-info-dialog">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        {#if info}
          <FileTypeIcon name={info.name} isDir={isDir} isOpen={false} class="size-5" />
          <span class="min-w-0 truncate" data-testid="info-title">{info.name}</span>
        {:else if multi}
          <span data-testid="info-title">{targets.length} items</span>
        {:else}
          <span>Properties</span>
        {/if}
      </Dialog.Title>
      <Dialog.Description class="sr-only">Properties of the selected item</Dialog.Description>
    </Dialog.Header>

    {#if loading}
      <p class="text-[13px] text-muted-foreground">Loading…</p>
    {:else if error}
      <p class="text-[13px] text-destructive" data-testid="info-error">{error}</p>
    {:else if info}
      <dl class="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1.5 text-[13px]">
        <dt class="text-muted-foreground">Path</dt>
        <dd class="flex min-w-0 items-start gap-1">
          <span class="min-w-0 break-all font-mono text-[12px]" data-testid="info-path">{info.path}</span>
          <button
            type="button"
            class="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Copy path"
            data-testid="info-copy-path"
            onclick={() => copy(info!.path)}
          >
            <CopyIcon class="size-3.5" />
          </button>
        </dd>
        {@render row("Type", typeLabel, "info-type")}
        {#if info.linkTarget !== null}
          {@render row("Link target", info.linkTarget, "info-link-target", true)}
        {/if}
        {#if info.mime}{@render row("MIME type", info.mime, "info-mime", true)}{/if}
        {#if info.kind === "file" || (info.kind === "symlink" && info.linkTargetKind === "file")}
          {@render row("Language", languageName(info.name), "info-language")}
        {/if}

        <dt class="text-muted-foreground">Size</dt>
        <dd class="min-w-0" data-testid="info-size">
          {#if isDir}
            {#if single}
              {sizeWithBytes(single.bytes)}{single.partial ? " or more (some items unreadable)" : ""}
              <div class="text-[12px] text-muted-foreground" data-testid="info-counts">
                {single.files.toLocaleString("en-US")} files, {single.dirs.toLocaleString("en-US")} folders
              </div>
            {:else}
              <Button
                variant="outline"
                size="sm"
                class="h-6 px-2 text-[12px]"
                disabled={sizing}
                data-testid="info-calc-size"
                onclick={() => void calcSingle()}
              >
                {sizing ? "Calculating…" : "Calculate size"}
              </Button>
              {#if sizeError}<span class="ml-2 text-[12px] text-destructive">{sizeError}</span>{/if}
            {/if}
          {:else}
            {sizeWithBytes(info.size)}
          {/if}
        </dd>
        {#if info.lines !== null}{@render row("Lines", info.lines.toLocaleString("en-US"), "info-lines")}{/if}

        {#if info.mode !== null}
          {@render row("Permissions", `${modeString(info.mode)}  (${modeOctal(info.mode)})`, "info-permissions", true)}
        {/if}
        {@render row("Owner", ownerLabel(info.user, info.uid), "info-owner")}
        {@render row("Group", ownerLabel(info.group, info.gid), "info-group")}
        {#if info.hardLinks !== null}{@render row("Hard links", String(info.hardLinks), "info-links")}{/if}

        {@render row("Modified", formatTime(info.mtime), "info-mtime")}
        {@render row("Accessed", formatTime(info.atime), "info-atime")}
        {#if info.ctime !== null}{@render row("Changed", formatTime(info.ctime), "info-ctime")}{/if}
        {#if info.btime !== null}{@render row("Created", formatTime(info.btime), "info-btime")}{/if}
      </dl>
    {:else if multi}
      <dl class="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1.5 text-[13px]">
        {@render row("Selected", `${entries.length} items (${fileEntries.length} files, ${dirEntries.length} folders)`, "info-multi-count")}
        <dt class="text-muted-foreground">Size</dt>
        <dd class="min-w-0" data-testid="info-multi-size">
          {sizeWithBytes(filesTotal + (multiSize?.bytes ?? 0))}
          {#if dirEntries.length > 0}
            {#if multiSize}
              <div class="text-[12px] text-muted-foreground">
                including folders{multiSize.partial ? " (some items unreadable)" : ""}
              </div>
            {:else}
              <div class="mt-1">
                <Button
                  variant="outline"
                  size="sm"
                  class="h-6 px-2 text-[12px]"
                  disabled={sizing}
                  data-testid="info-calc-size"
                  onclick={() => void calcMulti()}
                >
                  {sizing ? "Calculating…" : "Calculate folder sizes"}
                </Button>
                <span class="ml-2 text-[12px] text-muted-foreground">
                  files only: {humanSize(filesTotal)}
                </span>
                {#if sizeError}<span class="ml-2 text-[12px] text-destructive">{sizeError}</span>{/if}
              </div>
            {/if}
          {/if}
        </dd>
        {#if multiSize}
          {@render row("Contains", `${multiSize.files.toLocaleString("en-US")} files in ${multiSize.dirs.toLocaleString("en-US")} folders`, "info-multi-counts")}
        {/if}
      </dl>
      {#if paths.length > MAX_MULTI}
        <p class="text-[12px] text-muted-foreground">Showing the first {MAX_MULTI} items.</p>
      {/if}
    {/if}

    <Dialog.Footer>
      <Button variant="outline" onclick={onClose} data-testid="info-close">Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
