// Settings sync: dialog state and palette commands (docs/GUIDE.md §15.3.Y).
import { app } from "../stores.svelte";
import { registerCommand } from "../commands.svelte";

export const syncUi = $state({ exportOpen: false, importOpen: false });

export function openExportDialog(): void {
  app.showSettings = false;
  syncUi.importOpen = false;
  syncUi.exportOpen = true;
}

export function openImportDialog(): void {
  app.showSettings = false;
  syncUi.exportOpen = false;
  syncUi.importOpen = true;
}

let registered = false;
/** Idempotent; called when `SyncDialogs.svelte` mounts. */
export function registerSyncCommands(): void {
  if (registered) return;
  registered = true;
  registerCommand({
    id: "preferences.exportSettings",
    title: "Preferences: Export Settings…",
    category: "Preferences",
    run: openExportDialog,
  });
  registerCommand({
    id: "preferences.importSettings",
    title: "Preferences: Import Settings…",
    category: "Preferences",
    run: openImportDialog,
  });
}
