<script lang="ts">
  // Settings > Sync (docs/GUIDE.md §15.3.Y).
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button/index.js";
  import { syncState, undoImport } from "../../lib/sync/apply.svelte";
  import { SECTION_META } from "../../lib/sync/types";
  import { openExportDialog, openImportDialog } from "../../lib/sync/ui.svelte";

  function when(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  async function undo(): Promise<void> {
    try {
      await undoImport();
      toast.success("Import undone");
    } catch (err) {
      toast.error(String(err));
    }
  }
</script>

<div data-testid="settings-sync">
  <div class="flex items-center justify-between gap-4 py-2.5">
    <div>
      <div class="text-[13px] font-medium">Export Settings</div>
      <div class="text-[11px] text-muted-foreground">
        Save settings, theme, saved hosts, snippets and port forwards to a file. No passwords or keys are included.
      </div>
    </div>
    <Button variant="outline" size="sm" onclick={openExportDialog} data-testid="sync-export-open">Export…</Button>
  </div>
  <div class="flex items-center justify-between gap-4 py-2.5">
    <div>
      <div class="text-[13px] font-medium">Import Settings</div>
      <div class="text-[11px] text-muted-foreground">
        Load a file (or pasted text) from another machine. You see a preview and can undo.
      </div>
    </div>
    <Button variant="outline" size="sm" onclick={openImportDialog} data-testid="sync-import-open">Import…</Button>
  </div>
  <div class="py-2.5 text-[11px] text-muted-foreground" data-testid="sync-last-export">
    {#if syncState.lastExport}
      Last export: {when(syncState.lastExport.at)}
      ({syncState.lastExport.sections.map((s) => SECTION_META[s]?.label ?? s).join(", ")}){syncState.lastExport.path ? `, ${syncState.lastExport.path}` : ", copied as text"}
    {:else}
      Not exported yet on this machine.
    {/if}
  </div>
  {#if syncState.backup}
    <div class="flex items-center justify-between gap-4 py-2.5" data-testid="sync-backup">
      <div>
        <div class="text-[13px] font-medium">Undo Last Import</div>
        <div class="text-[11px] text-muted-foreground">
          A backup was taken {when(syncState.backup.at)} ({syncState.backup.sections.map((s) => SECTION_META[s]?.label ?? s).join(", ")}).
        </div>
      </div>
      <Button variant="outline" size="sm" onclick={undo} data-testid="sync-undo-import">Undo import</Button>
    </div>
  {/if}
</div>
