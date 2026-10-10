<script lang="ts">
  // Mounts the export / import dialogs once (from SettingsDialog.svelte, which App.svelte
  // always renders) and registers the "Preferences: Export/Import Settings…" commands.
  import { onMount } from "svelte";
  import { registerSyncCommands } from "../../lib/sync/ui.svelte";
  import ExportDialog from "./ExportDialog.svelte";
  import ImportDialog from "./ImportDialog.svelte";

  onMount(registerSyncCommands);
</script>

<ExportDialog />
<ImportDialog />
