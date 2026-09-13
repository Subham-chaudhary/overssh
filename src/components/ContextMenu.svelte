<script lang="ts">
  import { save, open } from "@tauri-apps/plugin-dialog";
  import * as api from "../lib/api";
  import { isAppError } from "../lib/api";
  import { app } from "../lib/stores.svelte";
  import type { FileEntry } from "../lib/types";

  let {
    sessionId,
    x,
    y,
    dirPath,
    entry,
    onClose,
  }: {
    sessionId: string;
    x: number;
    y: number;
    dirPath: string;
    entry: FileEntry | null;
    onClose: () => void;
  } = $props();

  function fail(err: unknown): void {
    app.addToast("error", isAppError(err) ? err.message : String(err));
  }

  async function newFile(): Promise<void> {
    onClose();
    await app.createFileIn(sessionId, dirPath);
  }

  async function newFolder(): Promise<void> {
    onClose();
    await app.createFolderIn(sessionId, dirPath);
  }

  async function doRename(): Promise<void> {
    onClose();
    if (!entry) return;
    await app.renameEntry(sessionId, entry, dirPath);
  }

  async function doDelete(): Promise<void> {
    onClose();
    if (!entry) return;
    await app.deleteEntry(sessionId, entry, dirPath);
  }

  function doRefresh(): void {
    onClose();
    void app.refreshDir(sessionId, dirPath);
  }

  async function copyPath(): Promise<void> {
    const path = entry?.path ?? dirPath;
    onClose();
    await app.copyPath(path);
  }

  async function doDownload(): Promise<void> {
    if (!entry || entry.kind !== "file") return;
    onClose();
    let target: string | null;
    try {
      target = await save({ defaultPath: entry.name });
    } catch (err) {
      fail(err);
      return;
    }
    if (!target) return;
    try {
      await api.download(sessionId, entry.path, target);
      app.addToast("success", `Downloaded ${entry.name}`);
    } catch (err) {
      fail(err);
    }
  }

  async function doUpload(): Promise<void> {
    onClose();
    let selection: string | string[] | null;
    try {
      selection = await open({ multiple: true });
    } catch (err) {
      fail(err);
      return;
    }
    if (!selection) return;
    const localPaths = Array.isArray(selection) ? selection : [selection];
    await app.uploadDroppedFiles(sessionId, localPaths, dirPath);
  }
</script>

<svelte:window
  onclick={onClose}
  oncontextmenu={onClose}
  onkeydown={(e) => {
    if (e.key === "Escape") onClose();
  }}
/>

<div class="menu" style={`left:${x}px; top:${y}px;`} role="menu">
  <button type="button" role="menuitem" onclick={newFile}>New file</button>
  <button type="button" role="menuitem" onclick={newFolder}>New folder</button>
  {#if entry}
    <div class="sep"></div>
    <button type="button" role="menuitem" onclick={doRename}>Rename</button>
    <button type="button" role="menuitem" class="danger" onclick={doDelete}>Delete</button>
  {/if}
  <div class="sep"></div>
  <button type="button" role="menuitem" onclick={doRefresh}>Refresh</button>
  <button type="button" role="menuitem" onclick={copyPath}>Copy path</button>
  {#if entry && entry.kind === "file"}
    <button type="button" role="menuitem" onclick={doDownload}>Download…</button>
  {/if}
  <button type="button" role="menuitem" onclick={doUpload}>Upload here…</button>
</div>

<style>
  .menu {
    position: fixed;
    z-index: 300;
    min-width: 160px;
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-radius: 5px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    padding: 4px;
    display: flex;
    flex-direction: column;
  }
  .menu button {
    background: transparent;
    border: none;
    color: var(--fg);
    text-align: left;
    padding: 5px 8px;
    border-radius: 3px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .menu button:hover {
    background: var(--bg-hover);
  }
  .menu button.danger {
    color: var(--danger);
  }
  .sep {
    height: 1px;
    background: var(--border);
    margin: 4px 2px;
  }
</style>
