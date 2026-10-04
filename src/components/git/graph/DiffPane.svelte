<script lang="ts">
  // Read-only Monaco diff editor (docs/GUIDE.md §14.4.G2). Models are recreated when the
  // texts or the path change; layout / options follow the props.
  import { onDestroy, onMount } from "svelte";
  import type * as Monaco from "monaco-editor";
  import { settings, effectiveEditorTheme } from "../../../lib/settings.svelte";
  import { monacoThemeName } from "../../../lib/themes";
  import { loadMonaco, languageIdFor, type MonacoApi } from "../../../lib/monaco";

  let {
    original,
    modified,
    path,
    sideBySide,
    ignoreWhitespace,
  }: { original: string; modified: string; path: string; sideBySide: boolean; ignoreWhitespace: boolean } = $props();

  let container: HTMLDivElement | undefined = $state();
  let monaco: MonacoApi | undefined = $state.raw();
  let editor: Monaco.editor.IStandaloneDiffEditor | undefined = $state.raw();
  let diffCount = $state(0);

  export function goToDiff(direction: "next" | "previous"): void {
    editor?.goToDiff(direction);
  }

  onMount(() => {
    let cancelled = false;
    void loadMonaco().then((m) => {
      if (cancelled || !container) return;
      const ed = m.editor.createDiffEditor(container, {
        automaticLayout: true,
        theme: monacoThemeName(effectiveEditorTheme()),
        renderSideBySide: sideBySide,
        useInlineViewWhenSpaceIsLimited: false,
        originalEditable: false,
        readOnly: true,
        ignoreTrimWhitespace: ignoreWhitespace,
        renderOverviewRuler: true,
        enableSplitViewResizing: true,
        scrollBeyondLastLine: false,
        fontFamily: settings.editor.fontFamily,
        fontSize: settings.editor.fontSize,
        minimap: { enabled: false },
      });
      ed.onDidUpdateDiff(() => {
        diffCount = ed.getLineChanges()?.length ?? 0;
      });
      editor = ed;
      monaco = m;
    });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const m = monaco;
    const ed = editor;
    if (!m || !ed) return;
    const lang = languageIdFor(path, m);
    const o = m.editor.createModel(original, lang);
    const md = m.editor.createModel(modified, lang);
    ed.setModel({ original: o, modified: md });
    return () => {
      try {
        ed.setModel(null);
      } catch {
        /* editor already disposed */
      }
      o.dispose();
      md.dispose();
    };
  });

  $effect(() => {
    if (!monaco) return;
    editor?.updateOptions({ renderSideBySide: sideBySide, ignoreTrimWhitespace: ignoreWhitespace });
  });

  onDestroy(() => {
    try {
      editor?.dispose();
    } catch {
      /* ignore */
    }
  });
</script>

<div
  class="h-full min-h-0 w-full"
  bind:this={container}
  data-testid="git-diff-editor"
  data-ready={monaco ? "true" : "false"}
  data-side-by-side={sideBySide}
  data-changes={diffCount}
></div>
