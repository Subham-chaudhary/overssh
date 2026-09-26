// "Compare with Saved on Server" (docs/GUIDE.md §13.4.D): palette command + helper.
// Imported by EditorTabs.svelte, so it is registered whenever the editor UI is.

import { app } from "./stores.svelte";
import { registerCommand } from "./commands.svelte";

export function compareActiveTab(): void {
  const id = app.activeWorkspace?.activeTabId;
  if (!id) {
    app.addToast("info", "Open a file first to compare it with the server.");
    return;
  }
  void app.openCompare(id);
}

registerCommand({
  id: "editor.compareWithServer",
  title: "Compare with Saved on Server",
  category: "Editor",
  run: compareActiveTab,
});
