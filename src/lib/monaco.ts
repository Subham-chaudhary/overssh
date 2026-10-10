// Lazy Monaco loader: dynamic-imports `./monaco-core` (kept out of the main
// chunk — see Editor.svelte, the only caller of `loadMonaco()`), wires up
// fully-offline web workers via Vite `?worker` imports (no CDN, matches the
// CSP's `default-src 'self'`), and registers the app themes as Monaco
// themes (with the accent override from settings.appearance folded in). docs/GUIDE.md §11 "Editor".
//
// `monaco-core.ts` is a trimmed stand-in for monaco-editor's own default
// entry point (`import "monaco-editor"`) that skips only its "typescript"
// rich-language-service feature (see that file's header) — everything else
// (every basic-language grammar, json/css/html features, every editor
// contribution) is registered exactly as it would be otherwise. `MonacoApi`
// is the slice of the real `monaco-editor` typings that shape actually
// exports (the full package's `.d.ts` also advertises `css`/`html`/`json`/
// `typescript`/`lsp` re-exports that `monaco-core.ts` deliberately drops or
// never had — we don't use any of those, only `editor`/`languages`/the key
// constant namespaces below).

import type * as Monaco from "monaco-editor";
import { THEMES, monacoThemeName, type ThemeId } from "./themes";
import { monacoThemeFor } from "./appearance";
import { appliedTheme, effectiveEditorTheme } from "./settings.svelte";

export type MonacoApi = Pick<
  typeof Monaco,
  | "editor"
  | "languages"
  | "Uri"
  | "KeyCode"
  | "KeyMod"
  | "Position"
  | "Range"
  | "Selection"
  | "SelectionDirection"
  | "Token"
  | "CancellationTokenSource"
  | "Emitter"
  | "MarkerSeverity"
  | "MarkerTag"
>;

// `?worker` imports resolve to a Worker constructor backed by its own bundled
// chunk (Vite code-splits it separately from the caller); importing the
// constructor here is cheap — it does not start a worker until `new`'d. This
// module itself is only ever reached via `import("./monaco")`, so none of
// this — nor `monaco-editor` itself — is part of the app's initial chunk.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
// NOTE: deliberately no `ts.worker`, and no import of monaco-editor's
// `language/typescript` contribution (the one that would register it and
// pull in the bundled TypeScript compiler, several MB). OverSSH is a remote
// text editor, not a project-aware IDE — there's no tsconfig/node_modules on
// the other end of the SSH connection to type-check against anyway. JS/TS
// files still get full Monarch-grammar syntax highlighting, bracket matching
// and folding from the basic-languages contribution (imported transitively
// by `monaco-editor`'s main entry) — just no TS diagnostics/IntelliSense.
// Skipping this keeps the editor chunk small (and avoided an OOM crash
// bundling `ts.worker` in this environment).

declare global {
  interface Window {
    MonacoEnvironment?: Monaco.Environment;
  }
}

function installEnvironment(): void {
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case "json":
          return new JsonWorker();
        case "css":
        case "scss":
        case "less":
          return new CssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new HtmlWorker();
        default:
          return new EditorWorker();
      }
    },
  };
}

let monacoPromise: Promise<MonacoApi> | null = null;
let monacoLoaded: MonacoApi | null = null;

/** (Re)defines every app theme, folding in `settings.appearance.accent`. */
function defineThemes(monaco: MonacoApi): void {
  for (const id of Object.keys(THEMES) as ThemeId[]) {
    monaco.editor.defineTheme(
      monacoThemeName(id),
      monacoThemeFor(id, appliedTheme.accent) as Monaco.editor.IStandaloneThemeData,
    );
  }
}

/** Re-applies the Monaco themes after the accent / theme settings changed.
 * No-op until Monaco has loaded (loadMonaco() defines them with the then-current
 * accent). App.svelte calls this from an effect. */
export function refreshMonacoThemes(): void {
  if (!monacoLoaded) return;
  defineThemes(monacoLoaded);
  monacoLoaded.editor.setTheme(monacoThemeName(effectiveEditorTheme()));
}

/** Lazily loads and initializes Monaco (workers + themes). Safe to call more
 * than once — the import and theme registration only happen once. */
export function loadMonaco(): Promise<MonacoApi> {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      installEnvironment();
      const monaco: MonacoApi = await import("./monaco-core");
      defineThemes(monaco);
      monacoLoaded = monaco;
      // Unbind (not merely no-op) Monaco's own default bindings for keys
      // App.svelte's global `window` keydown handler also uses, so the
      // keydown isn't preventDefault()/stopPropagation()'d by Monaco's
      // keybinding service and bubbles to `window` instead: F1 and
      // Ctrl+Shift+P both open Monaco's own "Command Palette" quick-input by
      // default, which would otherwise shadow the app's command palette
      // (Ctrl+Shift+P) whenever the editor has focus.
      monaco.editor.addKeybindingRules([
        { keybinding: monaco.KeyCode.F1, command: null },
        {
          keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP,
          command: null,
        },
      ]);
      return monaco;
    })();
  }
  return monacoPromise;
}

// --- filename -> Monaco language id / display name -------------------------

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function extname(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx <= 0 ? "" : name.slice(idx).toLowerCase();
}

/** Filenames/extensions Monaco's bundled languages don't declare themselves,
 * or that we want to special-case (docs/GUIDE.md §11 "Editor"). Checked
 * before falling back to Monaco's own `getLanguages()` extension/filename
 * lookup. Language ids must be registered by monaco-editor's basic-languages
 * bundle (shell, ini, dockerfile are all bundled). */
const FILENAME_OVERRIDES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "plaintext",
  jenkinsfile: "plaintext",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".profile": "shell",
  ".bash_profile": "shell",
  ".env": "ini",
};

const EXTENSION_OVERRIDES: Record<string, string> = {
  ".service": "ini",
  ".timer": "ini",
  ".socket": "ini",
};

/** Resolves a remote filename/path to a Monaco language id, using Monaco's
 * own registered languages (extensions + filenames) first-hand, then a small
 * set of extras for files Monaco doesn't self-register (dotfiles, systemd
 * units, nginx confs, …). Falls back to `"plaintext"`. */
export function languageIdFor(path: string, monaco: MonacoApi): string {
  const name = basename(path).toLowerCase();
  const ext = extname(name);

  if (name in FILENAME_OVERRIDES) return FILENAME_OVERRIDES[name];
  if (ext in EXTENSION_OVERRIDES) return EXTENSION_OVERRIDES[ext];
  // nginx site/conf files: not real ini, but a reasonable highlighting fallback.
  if (name === "nginx.conf" || (name.endsWith(".conf") && name.includes("nginx"))) return "ini";

  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id;
    if (lang.filenamePatterns?.some((p) => new RegExp(`^${p}$`, "i").test(name))) return lang.id;
  }
  for (const lang of monaco.languages.getLanguages()) {
    if (ext && lang.extensions?.some((e) => e.toLowerCase() === ext)) return lang.id;
  }
  return "plaintext";
}

/** Human-readable name for the status bar (StatusBar.svelte reads `tab.language`
 * directly, unchanged). Uses Monaco's own `aliases[0]`, falling back to the id. */
export function languageNameFor(id: string, monaco: MonacoApi): string {
  const lang = monaco.languages.getLanguages().find((l) => l.id === id);
  if (lang?.aliases?.[0]) return lang.aliases[0];
  if (id === "plaintext") return "Plain text";
  return id;
}
