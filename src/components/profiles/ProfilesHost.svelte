<script lang="ts">
  // Mounts the workspace profile overlays once (from App.svelte). Importing the store here
  // also registers the palette commands and loads the saved profiles at startup.
  import "../../lib/profiles/profiles.svelte";
  import ProfilePicker from "./ProfilePicker.svelte";
  import SaveProfileDialog from "./SaveProfileDialog.svelte";
  import ManageProfilesDialog from "./ManageProfilesDialog.svelte";
  import OpenProgress from "./OpenProgress.svelte";
</script>

<ProfilePicker />
<SaveProfileDialog />
<ManageProfilesDialog />
<OpenProgress />
