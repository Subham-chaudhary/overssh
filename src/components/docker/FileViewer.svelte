<script lang="ts">
  // Read-only Monaco viewer for a file read out of a container (not an SFTP path, so it is
  // not an editor tab). Language is picked from the file name.
  import { onDestroy } from "svelte";
  import { loadMonaco, languageIdFor, type MonacoApi } from "$lib/monaco";
  import { monacoThemeName } from "$lib/themes";
  import { effectiveEditorTheme, settings } from "$lib/settings.svelte";

  let { path, content }: { path: string; content: string } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let editor: ReturnType<MonacoApi["editor"]["create"]> | null = null;
  let monaco: MonacoApi | null = null;
  let model: ReturnType<MonacoApi["editor"]["createModel"]> | null = null;

  $effect(() => {
    const el = host;
    const p = path;
    const text = content;
    if (!el) return;
    let live = true;
    void loadMonaco().then((m) => {
      if (!live) return;
      monaco = m;
      if (!editor) {
        editor = m.editor.create(el, {
          value: "",
          readOnly: true,
          automaticLayout: true,
          minimap: { enabled: false },
          fontFamily: settings.editor.fontFamily,
          fontSize: settings.editor.fontSize,
          scrollBeyondLastLine: false,
          wordWrap: settings.editor.wordWrap ? "on" : "off",
          theme: monacoThemeName(effectiveEditorTheme()),
          domReadOnly: true,
        });
      }
      model?.dispose();
      model = m.editor.createModel(text, languageIdFor(p, m));
      editor.setModel(model);
    });
    return () => {
      live = false;
    };
  });

  onDestroy(() => {
    editor?.dispose();
    model?.dispose();
    editor = null;
    model = null;
  });
</script>

<div bind:this={host} class="h-full w-full" data-testid="docker-file-viewer"></div>
