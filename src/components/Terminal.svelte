<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal as XTerm } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import * as api from "../lib/api";
  import { terminalStore } from "../lib/terminal.svelte";

  // One-dark-ish palette matching src/app.css's CSS custom properties.
  const THEME = {
    background: "#1e2127",
    foreground: "#abb2bf",
    cursor: "#abb2bf",
    cursorAccent: "#1e2127",
    selectionBackground: "#3e4451",
    black: "#1e2127",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#7f848e",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#d7dae0",
  };

  interface Props {
    termId: string;
  }

  let { termId }: Props = $props();

  let container: HTMLDivElement | undefined = $state();
  let term: XTerm | undefined;
  let fitAddon: FitAddon | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  /** Fits the terminal to its container and tells the backend the new size.
   * No-ops while the container has no visible size (e.g. panel hidden) —
   * callers should call this again once it becomes visible. */
  export function fit(): void {
    if (!term || !fitAddon || !container) return;
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    fitAddon.fit();
    void api.termResize(termId, term.cols, term.rows);
  }

  function scheduleFit(): void {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fit, 50);
  }

  onMount(() => {
    if (!container) return;

    term = new XTerm({
      cursorBlink: true,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      scrollback: 5000,
      allowProposedApi: true,
      theme: THEME,
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fit();

    term.onData((data) => {
      void api.termWrite(termId, data);
    });

    // Copy-on-Ctrl+C-with-selection / paste-on-Ctrl+V, and let App.svelte's
    // global Ctrl+` (toggle terminal) / Ctrl+W (close tab) handlers run
    // instead of xterm swallowing them.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return true;
      if (e.key === "`") return false;
      if (e.key.toLowerCase() === "w") return false;
      if (e.type !== "keydown") return true;
      if (e.key.toLowerCase() === "c") {
        const selection = term?.getSelection();
        if (selection) {
          void navigator.clipboard.writeText(selection);
          return false;
        }
        return true;
      }
      if (e.key.toLowerCase() === "v") {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) void api.termWrite(termId, text);
          })
          .catch(() => {});
        return false;
      }
      return true;
    });

    terminalStore.onData(termId, (data) => term?.write(data));
    terminalStore.onExit(termId, (code) => {
      const suffix = code === null ? "" : ` (code ${code})`;
      term?.write(`\r\n\x1b[90m[process exited${suffix}]\x1b[0m\r\n`);
    });

    resizeObserver = new ResizeObserver(() => scheduleFit());
    resizeObserver.observe(container);
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    if (resizeTimer) clearTimeout(resizeTimer);
    terminalStore.offHandlers(termId);
    term?.dispose();
  });
</script>

<div class="terminal-host" bind:this={container}></div>

<style>
  .terminal-host {
    width: 100%;
    height: 100%;
    padding: 4px 0 0 6px;
  }

  .terminal-host :global(.xterm) {
    height: 100%;
  }
</style>
