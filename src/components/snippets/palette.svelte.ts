// Registers "Snippets: Run Snippet…" in the command palette. Imported lazily
// by `history.svelte.ts` (`loadHistory`), which runs at app boot.
import { registerCommand } from "../../lib/commands.svelte";
import { app } from "../../lib/stores.svelte";
import { snippetUi } from "./runner.svelte";

registerCommand({
  id: "snippets.run",
  title: "Snippets: Run Snippet…",
  category: "Snippets",
  run: () => {
    // The picker/form are rendered by CommandHistory.svelte (sidebar view
    // "commands"), so make sure that view is mounted first.
    app.sidebarView = "commands";
    snippetUi.picker = true;
  },
});
registerCommand({
  id: "snippets.new",
  title: "Snippets: New Snippet…",
  category: "Snippets",
  run: () => {
    app.sidebarView = "commands";
    snippetUi.edit = { snippet: null };
  },
});
