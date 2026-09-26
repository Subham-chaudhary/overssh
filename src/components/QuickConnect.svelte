<script lang="ts">
  // "New connection" entry (docs/GUIDE.md §11 "Host profiles" — QuickConnect
  // is the empty-prefill case of the shared connect form). A successful
  // connect upserts a profile automatically (stores.svelte.ts).
  import { app } from "../lib/stores.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import ConnectDialog from "./ConnectDialog.svelte";
  import PlusIcon from "@lucide/svelte/icons/plus";
</script>

<Button
  variant="ghost"
  size="sm"
  class="mx-2 my-1.5 h-7 justify-start gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
  onclick={() => (app.showQuickConnect = true)}
>
  <PlusIcon />
  New connection…
</Button>

<ConnectDialog bind:open={app.showQuickConnect} title="New connection" />
