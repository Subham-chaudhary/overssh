<script lang="ts">
  // Export settings (docs/GUIDE.md §15.3.Y): pick sections, then save a file
  // (native dialog) or copy the same text to the clipboard.
  import { toast } from "svelte-sonner";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import { isAppError } from "../../lib/api";
  import { buildExport, exportToClipboard, exportToFile } from "../../lib/sync/apply.svelte";
  import { countSection } from "../../lib/sync/format";
  import { SECTION_IDS, SECTION_META, type SectionId } from "../../lib/sync/types";
  import { syncUi } from "../../lib/sync/ui.svelte";

  let selected = $state<Record<SectionId, boolean>>(initial());
  let counts = $state<Partial<Record<SectionId, number>>>({});
  let busy = $state(false);
  let error = $state("");

  function initial(): Record<SectionId, boolean> {
    return Object.fromEntries(SECTION_IDS.map((id) => [id, SECTION_META[id].defaultOn])) as Record<SectionId, boolean>;
  }

  const chosen = $derived(SECTION_IDS.filter((id) => selected[id]));

  $effect(() => {
    if (!syncUi.exportOpen) return;
    selected = initial();
    error = "";
    void buildExport(SECTION_IDS)
      .then((b) => {
        const c: Partial<Record<SectionId, number>> = {};
        for (const id of SECTION_IDS) c[id] = countSection(id, b.sections);
        counts = c;
      })
      .catch(() => (counts = {}));
  });

  async function run(action: () => Promise<string | null | void>, done: (r: string | null | void) => string | null): Promise<void> {
    busy = true;
    error = "";
    try {
      const r = await action();
      const msg = done(r);
      if (msg) {
        toast.success(msg);
        syncUi.exportOpen = false;
      }
    } catch (err) {
      error = isAppError(err) ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  const saveFile = () => run(() => exportToFile(chosen), (p) => (p ? `Settings exported to ${p}` : null));
  const copyText = () => run(() => exportToClipboard(chosen), () => "Settings copied to the clipboard");
</script>

<Dialog.Root bind:open={syncUi.exportOpen}>
  <Dialog.Content class="sm:max-w-lg" data-testid="sync-export-dialog">
    <Dialog.Header>
      <Dialog.Title>Export settings</Dialog.Title>
      <Dialog.Description>
        Choose what goes into the file. Passwords, passphrases, private keys and trusted host keys are never exported.
      </Dialog.Description>
    </Dialog.Header>

    <div class="flex flex-col gap-1">
      {#each SECTION_IDS as id (id)}
        {@const meta = SECTION_META[id]}
        <label class="flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 hover:bg-accent/50">
          <Checkbox class="mt-0.5" bind:checked={selected[id]} data-testid={`sync-export-${id}`} />
          <span class="min-w-0 flex-1">
            <span class="flex items-baseline gap-2 text-[13px] font-medium">
              {meta.label}
              {#if counts[id] !== undefined}
                <span class="text-[11px] font-normal text-muted-foreground" data-testid={`sync-export-count-${id}`}>{counts[id]}</span>
              {/if}
            </span>
            <span class="block text-[11px] text-muted-foreground">{meta.description}</span>
            {#if meta.warning && selected[id]}
              <span class="mt-1 flex items-start gap-1.5 text-[11px] text-amber-500" data-testid="sync-history-warning">
                <TriangleAlertIcon class="mt-px size-3 flex-none" />
                {meta.warning}
              </span>
            {/if}
          </span>
        </label>
      {/each}
    </div>

    {#if error}<p class="text-[12px] text-destructive" data-testid="sync-export-error">{error}</p>{/if}

    <Dialog.Footer>
      <Button variant="ghost" size="sm" onclick={() => (syncUi.exportOpen = false)}>Cancel</Button>
      <Button variant="outline" size="sm" disabled={busy || chosen.length === 0} onclick={copyText} data-testid="sync-export-copy">
        Copy as text
      </Button>
      <Button size="sm" disabled={busy || chosen.length === 0} onclick={saveFile} data-testid="sync-export-save">Export to file…</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
