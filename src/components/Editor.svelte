<script lang="ts">
  import { onDestroy } from "svelte";
  import { EditorState, Compartment } from "@codemirror/state";
  import { EditorView, keymap } from "@codemirror/view";
  import { basicSetup } from "codemirror";
  import { oneDark } from "@codemirror/theme-one-dark";
  import { app, type Tab } from "../lib/stores.svelte";
  import { languageFor } from "../lib/languages";

  let { tab, active }: { tab: Tab; active: boolean } = $props();

  let container: HTMLDivElement | undefined = $state();
  let view: EditorView | null = null;
  const languageCompartment = new Compartment();

  const showEditor = $derived(
    !tab.loading && !tab.error && (!tab.isBinary || tab.forceOpen),
  );

  function saveCurrent(): boolean {
    void app.saveTab(tab.id);
    return true;
  }

  // Create the EditorView once the tab's content is ready. Runs at most once
  // per tab: after that `view` is kept alive for the component's lifetime so
  // undo history / scroll position survive tab switches.
  $effect(() => {
    if (showEditor && container && !view) {
      view = new EditorView({
        parent: container,
        state: EditorState.create({
          doc: tab.doc,
          extensions: [
            basicSetup,
            oneDark,
            languageCompartment.of([]),
            keymap.of([{ key: "Mod-s", run: saveCurrent, preventDefault: true }]),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                tab.doc = update.state.doc.toString();
              }
              if (update.docChanged || update.selectionSet) {
                const pos = update.state.selection.main.head;
                const line = update.state.doc.lineAt(pos);
                tab.line = line.number;
                tab.col = pos - line.from + 1;
              }
            }),
          ],
        }),
      });
      languageFor(tab.path).then((ext) => {
        if (ext && view) {
          view.dispatch({ effects: languageCompartment.reconfigure(ext) });
        }
      });
    }
  });

  // Push external doc changes (server reload, conflict "Reload") into the
  // live view when they didn't originate from the view itself.
  $effect(() => {
    const text = tab.doc;
    if (view && view.state.doc.toString() !== text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    }
  });

  onDestroy(() => {
    view?.destroy();
  });
</script>

<div class="editor-pane" class:hidden={!active}>
  {#if tab.loading}
    <div class="editor-message">Loading {tab.path}…</div>
  {:else if tab.tooLarge}
    <div class="editor-message">
      <p>{tab.error ?? "File is too large to edit (limit 10 MB)."}</p>
    </div>
  {:else if tab.error}
    <div class="editor-message error">
      <p>{tab.error}</p>
    </div>
  {:else if tab.isBinary && !tab.forceOpen}
    <div class="editor-message">
      <p>This looks like a binary file.</p>
      <button type="button" onclick={() => app.forceOpenBinary(tab.id)}>Open anyway</button>
    </div>
  {/if}
  <div class="editor-host" class:hidden={!showEditor} bind:this={container}></div>
</div>

<style>
  .editor-pane {
    height: 100%;
    width: 100%;
    display: flex;
    flex-direction: column;
  }
  .editor-pane.hidden {
    display: none;
  }
  .editor-host {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .editor-host.hidden {
    display: none;
  }
  .editor-host :global(.cm-editor) {
    height: 100%;
  }
  .editor-host :global(.cm-scroller) {
    font-family: var(--font-mono);
    font-size: 13px;
  }
  .editor-message {
    padding: 24px;
    color: var(--muted);
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-start;
  }
  .editor-message.error {
    color: var(--danger);
  }
</style>
