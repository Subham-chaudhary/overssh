<script module lang="ts">
  import type * as Monaco from "monaco-editor";

  interface ModelEntry {
    model: Monaco.editor.ITextModel;
    viewState: Monaco.editor.ICodeEditorViewState | null;
  }

  // Module-scoped (NOT per-component-instance) registry of live Monaco
  // models, keyed by Tab.id. This is what lets undo history / scroll
  // position survive not just a tab switch but also this whole component
  // unmounting and remounting (App.svelte only renders <EditorTabs>, and
  // therefore this component, while the active workspace has >0 tabs — see
  // App.svelte's `{#if tabs.length === 0}`). Models are disposed explicitly
  // (Monaco requires it) only when their owning tab actually closes anywhere
  // — see the sweep effect below — never implicitly on unmount.
  const models = new Map<string, ModelEntry>();

  // docs/GUIDE.md §12.1 contract: the shared Monaco editor instance, tracked
  // module-scoped (there is only ever one <Editor> mounted at a time) so
  // App.svelte's `` Ctrl+` `` handler can focus it without owning a reference.
  let activeEditor: Monaco.editor.IStandaloneCodeEditor | null = null;

  /** Focuses the live Monaco editor instance, if one is mounted. Returns
   * false (no-op) when no tab is open — App.svelte falls back accordingly. */
  export function focusActiveEditor(): boolean {
    if (!activeEditor) return false;
    activeEditor.focus();
    return true;
  }
</script>

<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { app } from "../lib/stores.svelte";
  import { settings, effectiveEditorTheme } from "../lib/settings.svelte";
  import { monacoThemeName } from "../lib/themes";
  import { loadMonaco, languageIdFor, type MonacoApi } from "../lib/monaco";
  import { scheduleAfterDelay, cancelAutosave, onEditorBlur } from "../lib/autosave.svelte";
  import { searchReveal } from "../lib/search.svelte";
  import Loader from "./Loader.svelte";
  import DiffView from "./DiffView.svelte";

  let container: HTMLDivElement | undefined = $state();
  let monaco: MonacoApi | undefined = $state();
  let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
  let ready = $state(false);
  let currentTabId: string | null = null;

  const tab = $derived(app.activeTab);
  const cmp = $derived(tab ? app.compare[tab.id] : undefined);
  const showEditor = $derived(
    !!tab && !tab.loading && !tab.error && (!tab.isBinary || tab.forceOpen),
  );

  function editorOptionsFromSettings(): Monaco.editor.IStandaloneEditorConstructionOptions {
    return {
      fontFamily: settings.editor.fontFamily,
      fontSize: settings.editor.fontSize,
      fontLigatures: settings.editor.ligatures,
      minimap: { enabled: settings.editor.minimap },
      wordWrap: settings.editor.wordWrap ? "on" : "off",
      stickyScroll: { enabled: settings.editor.stickyScroll },
      bracketPairColorization: { enabled: settings.editor.bracketPairColorization },
      guides: { bracketPairs: settings.editor.bracketPairColorization },
      renderWhitespace: settings.editor.renderWhitespace,
      lineNumbers: settings.editor.lineNumbers ? "on" : "off",
      smoothScrolling: settings.editor.smoothScrolling,
      cursorBlinking: settings.editor.cursorBlinking,
    };
  }

  function getOrCreateModel(t: NonNullable<typeof tab>, m: MonacoApi): Monaco.editor.ITextModel {
    const existing = models.get(t.id);
    if (existing) {
      // Picks up doc changes that happened while this tab wasn't the active
      // one (e.g. the conflict dialog's "Reload" resolving a background tab).
      if (existing.model.getValue() !== t.doc) existing.model.setValue(t.doc);
      return existing.model;
    }
    // `query` = tab id keeps the URI unique per tab: a tab retargeted by a rename
    // keeps its model (undo history), and a new tab for the old path won't collide.
    const uri = m.Uri.from({ scheme: "overssh", authority: t.sessionId, path: t.path, query: t.id });
    const languageId = languageIdFor(t.path, m);
    const model = m.editor.createModel(t.doc, languageId, uri);
    model.updateOptions({
      tabSize: settings.editor.tabSize,
      insertSpaces: settings.editor.insertSpaces,
    });
    model.onDidChangeContent(() => {
      const value = model.getValue();
      if (value !== t.doc) t.doc = value;
      scheduleAfterDelay(t);
    });
    models.set(t.id, { model, viewState: null });
    return model;
  }

  function disposeModel(tabId: string): void {
    const entry = models.get(tabId);
    if (entry) {
      entry.model.dispose();
      models.delete(tabId);
    }
    cancelAutosave(tabId);
  }

  /** Swaps the shared editor's model to match the active tab, saving/restoring
   * per-model view state (scroll position, selection, folds) across the swap. */
  function syncModel(): void {
    if (!editor || !monaco) return;
    if (currentTabId && currentTabId !== tab?.id) {
      const prevEntry = models.get(currentTabId);
      if (prevEntry) prevEntry.viewState = editor.saveViewState() ?? null;
    }
    if (!tab || !showEditor) {
      editor.setModel(null);
      currentTabId = null;
      return;
    }
    const model = getOrCreateModel(tab, monaco);
    if (editor.getModel() !== model) {
      editor.setModel(model);
      const entry = models.get(tab.id);
      if (entry?.viewState) editor.restoreViewState(entry.viewState);
      editor.focus();
    }
    currentTabId = tab.id;
    const pos = editor.getPosition();
    if (pos) {
      tab.line = pos.lineNumber;
      tab.col = pos.column;
    }
  }

  onMount(() => {
    let cancelled = false;
    void loadMonaco().then((m) => {
      if (cancelled || !container) return;
      monaco = m;
      editor = m.editor.create(container, {
        automaticLayout: true,
        scrollBeyondLastLine: false,
        theme: monacoThemeName(effectiveEditorTheme()),
        padding: { top: 8 },
        cursorSmoothCaretAnimation: "on",
        ...editorOptionsFromSettings(),
      });

      // Global shortcuts (App.svelte's `window` keydown listener) must win
      // over Monaco's own defaults for the same combos: Ctrl+S saves through
      // the app's conflict-aware path, and F1 / Ctrl+Shift+P are explicitly
      // unbound (`command: null`) so the keydown isn't swallowed by Monaco's
      // keybinding service and bubbles to `window` for the app's command
      // palette instead. All other App.svelte shortcuts (Ctrl+W, Ctrl+`,
      // Ctrl+,, F5) aren't bound by Monaco at all, so they already bubble.
      editor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => {
        const activeId = app.activeWorkspace?.activeTabId;
        if (activeId) void app.saveTab(activeId);
      });

      editor.onDidBlurEditorText(() => onEditorBlur(currentTabId));
      editor.onDidChangeCursorPosition((e) => {
        if (tab) {
          tab.line = e.position.lineNumber;
          tab.col = e.position.column;
        }
      });

      activeEditor = editor;
      ready = true;
      syncModel();
    });
    return () => {
      cancelled = true;
    };
  });

  onDestroy(() => {
    // The editor widget is torn down, but models are module-scoped and
    // intentionally left alive — see the comment on `models` above.
    editor?.dispose();
    if (activeEditor === editor) activeEditor = null;
    editor = undefined;
    ready = false;
  });

  // Swap models whenever the active tab (or its show/hide state) changes.
  // `syncModel` itself reads `tab` and `showEditor` synchronously, so calling
  // it here (rather than duplicating those reads) is enough for Svelte to
  // track both as this effect's dependencies.
  $effect(() => {
    if (ready) syncModel();
  });

  // Closing a diff view may have changed tab.doc (take server / save merged):
  // re-sync the model text and relayout the editor that was hidden.
  $effect(() => {
    if (ready && !cmp) {
      syncModel();
      editor?.layout();
    }
  });

  // Search reveal hook (§13.4.R): runs after the sync effect above set the model.
  $effect(() => {
    const p = searchReveal.pending;
    if (!p || !ready || !editor || !tab || !showEditor || cmp) return;
    if (p.sessionId !== tab.sessionId || p.path !== tab.path) return;
    const model = models.get(tab.id)?.model;
    if (!model || editor.getModel() !== model) return;
    const line = Math.min(Math.max(1, p.line), model.getLineCount());
    const col = Math.min(Math.max(1, p.col), model.getLineMaxColumn(line));
    editor.setPosition({ lineNumber: line, column: col });
    editor.revealPositionInCenter({ lineNumber: line, column: col });
    editor.focus();
    searchReveal.pending = null;
  });

  // Live-apply editor.* settings.
  $effect(() => {
    const opts = editorOptionsFromSettings();
    if (editor) editor.updateOptions(opts);
  });

  // tabSize/insertSpaces are per-model options, applied to every open model.
  $effect(() => {
    const tabSize = settings.editor.tabSize;
    const insertSpaces = settings.editor.insertSpaces;
    for (const { model } of models.values()) {
      model.updateOptions({ tabSize, insertSpaces });
    }
  });

  // Theme follows the app theme unless overridden (settings.svelte.ts).
  $effect(() => {
    if (!monaco) return;
    monaco.editor.setTheme(monacoThemeName(effectiveEditorTheme()));
  });

  // A tab retargeted by rename/move keeps its model; refresh the language mode
  // when the new extension maps to a different one.
  $effect(() => {
    const m = monaco;
    if (!m) return;
    for (const ws of Object.values(app.workspaces)) {
      for (const t of ws.tabs) {
        const entry = models.get(t.id);
        if (!entry) continue;
        const languageId = languageIdFor(t.path, m);
        if (entry.model.getLanguageId() !== languageId) {
          m.editor.setModelLanguage(entry.model, languageId);
        }
      }
    }
  });

  // Dispose models whose tab closed in any workspace (including whole
  // workspaces dropped on disconnect) — never leaks a Monaco model.
  $effect(() => {
    const liveIds = new Set<string>();
    for (const ws of Object.values(app.workspaces)) {
      for (const t of ws.tabs) liveIds.add(t.id);
    }
    for (const id of [...models.keys()]) {
      if (!liveIds.has(id)) disposeModel(id);
    }
  });
</script>

<div class="relative flex h-full w-full flex-col bg-editor">
  {#if tab?.loading}
    <div class="flex h-full items-center justify-center p-6">
      <Loader label={tab.path} />
    </div>
  {:else if tab?.tooLarge}
    <div class="flex flex-col items-start gap-3 p-6 text-muted-foreground">
      <p>{tab.error ?? "File is too large to edit (limit 10 MB)."}</p>
    </div>
  {:else if tab?.error}
    <div class="flex flex-col items-start gap-3 p-6 text-destructive">
      <p>{tab.error}</p>
    </div>
  {:else if tab?.isBinary && !tab.forceOpen}
    <div class="flex flex-col items-start gap-3 p-6 text-muted-foreground">
      <p>This looks like a binary file.</p>
      <button
        type="button"
        class="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm text-secondary-foreground hover:opacity-90"
        onclick={() => tab && app.forceOpenBinary(tab.id)}
      >
        Open anyway
      </button>
    </div>
  {/if}
  {#if tab?.missing}
    <div
      class="flex flex-none items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[12px] text-warning"
      data-testid="missing-file-banner"
    >
      This file no longer exists on the server. Saving will recreate it.
    </div>
  {/if}
  {#if tab && cmp}
    {#key cmp.serverMtime + ":" + cmp.serverContent.length}
      <div class="min-h-0 flex-1"><DiffView {tab} state={cmp} /></div>
    {/key}
  {/if}
  <div class="min-h-0 flex-1" class:hidden={!showEditor || !!cmp} bind:this={container}></div>
</div>
