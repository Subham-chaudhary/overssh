<script lang="ts">
  // Import settings (docs/GUIDE.md §15.3.Y): choose a file or paste text, preview
  // what would change, resolve conflicts, apply (a backup is taken first), undo.
  import { toast } from "svelte-sonner";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import ChevronRightIcon from "@lucide/svelte/icons/chevron-right";
  import * as api from "../../lib/api";
  import {
    applyImport,
    previewImport,
    syncState,
    undoImport,
    type ImportPreview,
    type ImportSummary,
  } from "../../lib/sync/apply.svelte";
  import { planImport } from "../../lib/sync/merge";
  import { SECTION_IDS, SECTION_META, type Resolution, type SectionId } from "../../lib/sync/types";
  import { syncUi } from "../../lib/sync/ui.svelte";

  type Step = "source" | "preview" | "done";

  let step = $state<Step>("source");
  let text = $state("");
  let error = $state("");
  let busy = $state(false);
  let preview = $state<ImportPreview | null>(null);
  let selected = $state<Partial<Record<SectionId, boolean>>>({});
  let decisions = $state<Record<string, Resolution>>({});
  let expanded = $state<Partial<Record<SectionId, boolean>>>({});
  let summary = $state<ImportSummary | null>(null);

  const chosen = $derived(SECTION_IDS.filter((id) => selected[id] && preview?.available.includes(id)));
  const plan = $derived(preview ? planImport(preview.bundle, chosen, preview.current) : null);

  const RESOLUTIONS: { id: Resolution; label: string }[] = [
    { id: "skip", label: "Skip" },
    { id: "overwrite", label: "Overwrite" },
    { id: "keepBoth", label: "Keep both" },
  ];

  $effect(() => {
    if (!syncUi.importOpen) return;
    step = "source";
    text = "";
    error = "";
    preview = null;
    summary = null;
    decisions = {};
    expanded = {};
  });

  function errMsg(err: unknown): string {
    return api.isAppError(err) ? err.message : String(err);
  }

  async function show(source: string): Promise<void> {
    busy = true;
    error = "";
    try {
      const r = await previewImport(source);
      if (!r.ok) {
        error = r.error;
        return;
      }
      preview = r.preview;
      selected = Object.fromEntries(r.preview.available.map((id) => [id, id !== "history"]));
      decisions = {};
      step = "preview";
    } catch (err) {
      error = errMsg(err);
    } finally {
      busy = false;
    }
  }

  async function chooseFile(): Promise<void> {
    busy = true;
    error = "";
    try {
      const picked = await api.localReadText();
      if (picked) {
        busy = false;
        await show(picked.text);
      }
    } catch (err) {
      error = errMsg(err);
    } finally {
      busy = false;
    }
  }

  async function pasteClipboard(): Promise<void> {
    error = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      error = "Could not read the clipboard. Paste the text into the box instead.";
    }
  }

  function setAll(r: Resolution): void {
    if (!plan) return;
    decisions = Object.fromEntries(plan.conflicts.map((c) => [c.key, r]));
  }

  async function apply(): Promise<void> {
    if (!preview) return;
    busy = true;
    error = "";
    try {
      summary = await applyImport(preview.bundle, chosen, decisions, "skip");
      step = "done";
      toast.success("Settings imported");
    } catch (err) {
      error = errMsg(err);
    } finally {
      busy = false;
    }
  }

  async function undo(): Promise<void> {
    busy = true;
    try {
      const restored = await undoImport();
      toast.success(restored.length ? "Import undone" : "Nothing to undo");
      syncUi.importOpen = false;
    } catch (err) {
      error = errMsg(err);
    } finally {
      busy = false;
    }
  }

  function fmt(v: unknown): string {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s === undefined ? "unset" : s.length > 40 ? s.slice(0, 40) + "…" : s;
  }

  function when(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
  }
</script>

<Dialog.Root bind:open={syncUi.importOpen}>
  <Dialog.Content class="flex max-h-[85vh] flex-col sm:max-w-2xl" data-testid="sync-import-dialog">
    <Dialog.Header>
      <Dialog.Title>Import settings</Dialog.Title>
      <Dialog.Description>
        {#if step === "source"}
          Pick a settings file exported from OverSSH, or paste its text. You see a preview before anything changes.
        {:else if step === "preview" && preview}
          From {preview.bundle.app ? `OverSSH ${preview.bundle.app}` : "OverSSH"}{preview.bundle.exportedAt ? `, exported ${when(preview.bundle.exportedAt)}` : ""}. A backup of the current state is taken first.
        {:else}
          Done. You can undo this import.
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if step === "source"}
        <div class="flex flex-col gap-3">
          <Button variant="outline" size="sm" class="self-start" disabled={busy} onclick={chooseFile} data-testid="sync-import-file">
            Choose file…
          </Button>
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between">
              <span class="text-[12px] text-muted-foreground">Or paste exported text</span>
              <Button variant="ghost" size="sm" onclick={pasteClipboard} data-testid="sync-import-clipboard">Paste from clipboard</Button>
            </div>
            <Textarea
              class="h-40 font-mono text-[11px]"
              placeholder={'{ "format": "overssh-settings", … }'}
              spellcheck="false"
              bind:value={text}
              data-testid="sync-import-text"
            />
          </div>
        </div>
      {:else if step === "preview" && preview && plan}
        {#if preview.warnings.length > 0}
          <ul class="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-500" data-testid="sync-import-warnings">
            {#each preview.warnings as w (w)}<li>{w}</li>{/each}
          </ul>
        {/if}

        <div class="flex flex-col" data-testid="sync-import-sections">
          {#each preview.available as id (id)}
            {@const meta = SECTION_META[id]}
            {@const p = plan.previews.find((x) => x.id === id)}
            <div class="border-b border-border/60 py-1.5" data-testid={`sync-import-section-${id}`}>
              <div class="flex items-start gap-3 px-1">
                <Checkbox class="mt-0.5" bind:checked={selected[id]} data-testid={`sync-import-check-${id}`} />
                <div class="min-w-0 flex-1">
                  <div class="text-[13px] font-medium">{meta.label}</div>
                  {#if p}
                    <div class="text-[11px] text-muted-foreground" data-testid={`sync-import-summary-${id}`}>
                      {#if id === "settings" || id === "appearance" || id === "prefs"}
                        {p.changes.length} changed value{p.changes.length === 1 ? "" : "s"}{p.same > 0 ? `, ${p.same} unchanged` : ""}
                      {:else}
                        {p.add} new{p.same > 0 ? `, ${p.same} unchanged` : ""}{p.conflicts > 0 ? `, ${p.conflicts} conflict${p.conflicts === 1 ? "" : "s"}` : ""}
                      {/if}
                    </div>
                    {#if p.note}<div class="text-[11px] text-muted-foreground">{p.note}</div>{/if}
                    {#if id === "history" && selected[id]}
                      <div class="mt-0.5 flex items-start gap-1.5 text-[11px] text-amber-500">
                        <TriangleAlertIcon class="mt-px size-3 flex-none" />{meta.warning}
                      </div>
                    {/if}
                    {#if p.changes.length > 0}
                      <button
                        type="button"
                        class="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                        onclick={() => (expanded[id] = !expanded[id])}
                      >
                        <ChevronRightIcon class={`size-3 transition-transform ${expanded[id] ? "rotate-90" : ""}`} />
                        {expanded[id] ? "Hide" : "Show"} changes
                      </button>
                      {#if expanded[id]}
                        <ul class="mt-1 max-h-32 overflow-y-auto font-mono text-[11px]">
                          {#each p.changes.slice(0, 100) as d (d.path)}
                            <li><span class="text-muted-foreground">{d.path}:</span> {fmt(d.from)} → {fmt(d.to)}</li>
                          {/each}
                        </ul>
                      {/if}
                    {/if}
                  {/if}
                </div>
              </div>
            </div>
          {/each}
        </div>

        {#if plan.conflicts.length > 0}
          <div class="mt-4" data-testid="sync-import-conflicts">
            <div class="flex items-center justify-between pb-1">
              <h4 class="text-[12px] font-medium">{plan.conflicts.length} conflict{plan.conflicts.length === 1 ? "" : "s"}</h4>
              <div class="flex items-center gap-1 text-[11px] text-muted-foreground">
                All:
                {#each RESOLUTIONS as r (r.id)}
                  <Button variant="ghost" size="sm" class="h-6 px-2 text-[11px]" onclick={() => setAll(r.id)} data-testid={`sync-conflict-all-${r.id}`}>
                    {r.label}
                  </Button>
                {/each}
              </div>
            </div>
            {#each plan.conflicts as c (c.key)}
              <div class="flex items-center gap-3 border-t border-border/60 py-1.5" data-testid="sync-conflict" data-key={c.key}>
                <div class="min-w-0 flex-1 text-[12px]">
                  <div class="truncate">
                    <span class="text-muted-foreground">{SECTION_META[c.section === "logs" ? "logs" : c.section].label}:</span>
                    {c.incoming}
                  </div>
                  <div class="truncate text-[11px] text-muted-foreground">
                    {c.reason === "id" ? "Same item exists" : c.reason === "name" ? "Same name exists" : "Same tunnel exists"}: {c.existing}
                  </div>
                </div>
                <div class="flex flex-none gap-0.5" role="group" aria-label="Resolution">
                  {#each RESOLUTIONS as r (r.id)}
                    <Button
                      variant={(decisions[c.key] ?? "skip") === r.id ? "secondary" : "ghost"}
                      size="sm"
                      class="h-6 px-2 text-[11px]"
                      aria-pressed={(decisions[c.key] ?? "skip") === r.id}
                      onclick={() => (decisions[c.key] = r.id)}
                      data-testid={`sync-conflict-${r.id}`}
                    >
                      {r.label}
                    </Button>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {:else if step === "done" && summary}
        <ul class="text-[13px]" data-testid="sync-import-result">
          {#each Object.entries(summary.applied) as [id, n] (id)}
            <li>{SECTION_META[id as SectionId].label}: {n} {n === 1 ? "change" : "changes"} applied</li>
          {/each}
        </ul>
      {/if}
    </div>

    {#if error}<p class="text-[12px] text-destructive" data-testid="sync-import-error">{error}</p>{/if}

    <Dialog.Footer>
      {#if step === "source"}
        <Button variant="ghost" size="sm" onclick={() => (syncUi.importOpen = false)}>Cancel</Button>
        <Button size="sm" disabled={busy || text.trim() === ""} onclick={() => show(text)} data-testid="sync-import-preview">Preview</Button>
      {:else if step === "preview"}
        <Button variant="ghost" size="sm" onclick={() => (step = "source")}>Back</Button>
        <Button size="sm" disabled={busy || chosen.length === 0} onclick={apply} data-testid="sync-import-apply">Import</Button>
      {:else}
        <Button variant="outline" size="sm" disabled={busy || !syncState.backup} onclick={undo} data-testid="sync-import-undo">Undo import</Button>
        <Button size="sm" onclick={() => (syncUi.importOpen = false)} data-testid="sync-import-close">Close</Button>
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
