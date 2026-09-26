<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type * as Monaco from "monaco-editor";
  import { app, type CompareState, type Tab } from "../lib/stores.svelte";
  import { settings, effectiveEditorTheme } from "../lib/settings.svelte";
  import { monacoThemeName } from "../lib/themes";
  import { loadMonaco, languageIdFor } from "../lib/monaco";
  import { basename } from "../lib/paths";

  let { tab, state: cmp }: { tab: Tab; state: CompareState } = $props();

  let container: HTMLDivElement | undefined = $state();
  let diff: Monaco.editor.IStandaloneDiffEditor | undefined;
  let original: Monaco.editor.ITextModel | undefined;
  let modified: Monaco.editor.ITextModel | undefined;
  let sideBySide = $state(true);
  let busy = $derived(tab.saving);

  function save(): void {
    if (modified) void app.applyCompare(tab.id, "merged", modified.getValue());
  }

  onMount(() => {
    let cancelled = false;
    void loadMonaco().then((m) => {
      if (cancelled || !container) return;
      const lang = languageIdFor(tab.path, m);
      original = m.editor.createModel(cmp.serverContent, lang);
      modified = m.editor.createModel(tab.doc, lang);
      diff = m.editor.createDiffEditor(container, {
        automaticLayout: true,
        theme: monacoThemeName(effectiveEditorTheme()),
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: false,
        originalEditable: false,
        readOnly: false,
        renderMarginRevertIcon: true,
        ignoreTrimWhitespace: false,
        enableSplitViewResizing: true,
        scrollBeyondLastLine: false,
        fontFamily: settings.editor.fontFamily,
        fontSize: settings.editor.fontSize,
        minimap: { enabled: false },
      });
      diff.setModel({ original, modified });
      diff.getModifiedEditor().addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, save);
      diff.getModifiedEditor().focus();
    });
    return () => {
      cancelled = true;
    };
  });

  onDestroy(() => {
    diff?.setModel(null);
    diff?.dispose();
    original?.dispose();
    modified?.dispose();
  });

  $effect(() => {
    diff?.updateOptions({ renderSideBySide: sideBySide });
  });

  const btn =
    "rounded-md border border-border bg-secondary px-2.5 py-1 text-[12px] text-secondary-foreground hover:opacity-90 disabled:opacity-50";
</script>

<div class="flex h-full w-full flex-col bg-editor" data-testid="diff-view">
  <div class="flex flex-none flex-wrap items-center gap-2 border-b border-border bg-sidebar px-3 py-1.5 text-[12px]">
    <span class="mr-2 text-muted-foreground">
      Compare <code class="text-foreground">{basename(tab.path)}</code>: server (left, read-only) vs your buffer (right)
    </span>
    <button type="button" class={btn} disabled={busy} data-testid="diff-save-merged" onclick={save}>Save merged</button>
    <button type="button" class={btn} disabled={busy} data-testid="diff-keep-mine" onclick={() => void app.applyCompare(tab.id, "mine")}>
      Keep mine (overwrite server)
    </button>
    <button type="button" class={btn} disabled={busy} data-testid="diff-take-server" onclick={() => void app.applyCompare(tab.id, "server")}>
      Take server version
    </button>
    <button type="button" class={btn} data-testid="diff-cancel" onclick={() => app.closeCompare(tab.id)}>Cancel</button>
    <span class="mx-1 h-4 w-px bg-border"></span>
    <button type="button" class={btn} aria-label="Previous change" onclick={() => diff?.goToDiff("previous")}>Prev change</button>
    <button type="button" class={btn} aria-label="Next change" onclick={() => diff?.goToDiff("next")}>Next change</button>
    <button type="button" class={btn} data-testid="diff-toggle-inline" onclick={() => (sideBySide = !sideBySide)}>
      {sideBySide ? "Inline" : "Side by side"}
    </button>
  </div>
  <div class="min-h-0 flex-1" bind:this={container}></div>
</div>
