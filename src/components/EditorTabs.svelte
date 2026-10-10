<script lang="ts">
  import { fade } from "svelte/transition";
  import { fadeParams } from "../lib/motion";
  import { app } from "../lib/stores.svelte";
  import { basename } from "../lib/paths";
  import { onActiveTabLeave } from "../lib/autosave.svelte";
  import "../lib/compare.svelte";
  import Editor from "./Editor.svelte";
  import * as ContextMenu from "$lib/components/ui/context-menu/index.js";
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import FileTypeIcon from "./FileTypeIcon.svelte";
  import XIcon from "@lucide/svelte/icons/x";

  const tabs = $derived(app.activeWorkspace?.tabs ?? []);
  const activeTabId = $derived(app.activeWorkspace?.activeTabId ?? null);

  function isDirty(id: string): boolean {
    const t = tabs.find((x) => x.id === id);
    return !!t && t.doc !== t.savedDoc;
  }

  function activate(tabId: string): void {
    if (tabId === activeTabId) return;
    onActiveTabLeave(activeTabId);
    app.setActiveTab(tabId);
  }

  function closeTab(e: Event, id: string): void {
    e.stopPropagation();
    void app.closeTab(id);
  }

  function onTabAuxClick(e: MouseEvent, id: string): void {
    if (e.button === 1) {
      e.preventDefault();
      void app.closeTab(id);
    }
  }

  function onWheel(e: WheelEvent): void {
    if (e.deltaY === 0) return;
    (e.currentTarget as HTMLElement).scrollLeft += e.deltaY;
    e.preventDefault();
  }

  async function closeOthers(tabId: string): Promise<void> {
    for (const id of tabs.filter((t) => t.id !== tabId).map((t) => t.id)) {
      await app.closeTab(id);
    }
  }

  async function closeAll(): Promise<void> {
    for (const id of tabs.map((t) => t.id)) {
      await app.closeTab(id);
    }
  }

  function copyTabPath(path: string): void {
    void app.copyPath(path);
  }
</script>

<div class="flex h-full min-w-0 flex-col">
  <div
    class="flex flex-none overflow-x-auto border-b border-border bg-sidebar"
    onwheel={onWheel}
    role="tablist"
    aria-label="Open files"
  >
    {#each tabs as tab (tab.id)}
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          <div
            out:fade|global={fadeParams()}
            class={[
              "motion-tab-in group flex h-9 items-center gap-1.5 border-r border-border px-3 text-sm whitespace-nowrap select-none",
              tab.id === activeTabId
                ? "border-t-2 border-t-primary bg-tab-active text-foreground"
                : "border-t-2 border-t-transparent bg-tab-inactive text-muted-foreground hover:text-foreground",
            ]}
            title={tab.missing ? `${tab.path} (deleted)` : tab.path}
            role="tab"
            tabindex="0"
            aria-selected={tab.id === activeTabId}
            onclick={() => activate(tab.id)}
            onauxclick={(e) => onTabAuxClick(e, tab.id)}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") activate(tab.id);
            }}
          >
            <FileTypeIcon name={basename(tab.path)} class="size-4" />
            <span
              class={["max-w-48 overflow-hidden text-ellipsis", tab.missing && "line-through opacity-70"]}
              data-deleted={tab.missing ? "true" : undefined}
              >{basename(tab.path)}{tab.missing ? " (deleted)" : ""}</span
            >
            <span class="relative flex size-4 shrink-0 items-center justify-center">
              {#if isDirty(tab.id)}
                <span
                  class="size-1.5 rounded-full bg-foreground group-hover:hidden"
                  aria-hidden="true"
                ></span>
              {/if}
              <button
                type="button"
                class={[
                  "absolute inset-0 hidden items-center justify-center rounded-sm hover:bg-accent hover:text-accent-foreground group-hover:flex",
                  tab.id === activeTabId && "flex",
                ]}
                aria-label={`Close ${basename(tab.path)}`}
                onclick={(e) => closeTab(e, tab.id)}
              >
                <XIcon class="size-3" />
              </button>
            </span>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Content>
          <ContextMenu.Item onclick={() => void app.closeTab(tab.id)}>Close</ContextMenu.Item>
          <ContextMenu.Item onclick={() => void closeOthers(tab.id)}>Close Others</ContextMenu.Item>
          <ContextMenu.Item onclick={() => void closeAll()}>Close All</ContextMenu.Item>
          <ContextMenu.Separator />
          <ContextMenu.Item onclick={() => copyTabPath(tab.path)}>Copy Path</ContextMenu.Item>
          <ContextMenu.Item onclick={() => void app.openCompare(tab.id)}>Compare with Saved on Server</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Root>
    {/each}
  </div>

  <div class="relative min-h-0 flex-1">
    <Editor />
  </div>
</div>

{#if app.conflict}
  {@const conflict = app.conflict}
  <AlertDialog.Root open={true} onOpenChange={(o) => { if (!o) app.resolveConflictCancel(); }}>
    <AlertDialog.Content>
      <AlertDialog.Header>
        <AlertDialog.Title>File changed on server</AlertDialog.Title>
        <AlertDialog.Description>
          <code class="text-warning break-all">{conflict.path}</code> was modified since you opened
          it.
        </AlertDialog.Description>
      </AlertDialog.Header>
      <AlertDialog.Footer>
        <AlertDialog.Cancel onclick={() => app.resolveConflictCancel()}>Cancel</AlertDialog.Cancel>
        <Button variant="outline" onclick={() => void app.openCompare(conflict.tabId)}>Compare</Button>
        <Button variant="outline" onclick={() => void app.resolveConflictReload()}>Reload</Button>
        <AlertDialog.Action
          class="bg-destructive text-destructive-foreground hover:bg-destructive/80"
          onclick={() => app.resolveConflictOverwrite()}
        >
          Overwrite
        </AlertDialog.Action>
      </AlertDialog.Footer>
    </AlertDialog.Content>
  </AlertDialog.Root>
{/if}
