<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal as XTerm } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import * as api from "../lib/api";
  import { terminalStore } from "../lib/terminal.svelte";
  import { app } from "../lib/stores.svelte";
  import { settings, terminalTheme } from "../lib/settings.svelte";
  import {
    loadHistory,
    record,
    suggest,
    logicalLineRange,
    findLogicalLineEndRow,
    type LineGetter,
    type BufferLineLike,
  } from "../lib/history.svelte";
  import type { IBuffer } from "@xterm/xterm";

  interface Props {
    termId: string;
  }

  let { termId }: Props = $props();

  let container: HTMLDivElement | undefined = $state();
  let term: XTerm | undefined;
  let fitAddon: FitAddon | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  // Flips true once `term` exists (onMount), so the theme/font/cursor
  // `$effect`s below — which close over the plain `term` variable, not a rune
  // — re-run as soon as there's a terminal to apply to, and again on every
  // later settings change.
  let ready = $state(false);

  // Set by terminalStore.onExit's handler (see onMount) when this terminal
  // exited non-zero and was opened with a `command` (docs/GUIDE.md §12 item
  // 2): the PTY is dead, so the next keystroke closes the tab instead of
  // being written to it.
  let awaitingCloseKey = false;

  // --- command capture (docs/GUIDE.md §11.4) --------------------------------
  // Absolute buffer position (row = viewport row + buffer.active.baseY) where
  // the current command started, or null while no command is "in progress"
  // (right after a submit, Ctrl+C/Ctrl+U/Ctrl+D, or before the first input).
  let inputStart: { row: number; col: number } | null = null;

  function currentHostKey(): string | null {
    const tab = terminalStore.tabs.find((t) => t.id === termId);
    if (!tab) return null;
    return terminalStore.hostKey(tab.sessionId);
  }

  /** Adapts a live xterm `IBuffer` to history.svelte.ts's dependency-free
   * `LineGetter`, so the actual extraction logic stays pure and testable
   * without an xterm instance. */
  function makeLineGetter(buffer: IBuffer): LineGetter {
    return (row: number): BufferLineLike | undefined => {
      const line = buffer.getLine(row);
      if (!line) return undefined;
      return { isWrapped: line.isWrapped, text: line.translateToString(false) };
    };
  }

  function resetInputStart(): void {
    inputStart = null;
    hideGhost();
  }

  /** Called once per '\r'/'\n' seen in outgoing data (see `processCapture`):
   * reads the logical (wrap-following) line from `inputStart` to its end and
   * hands it to `history.record`. A no-op if no command was being tracked
   * (e.g. the user submitted via history-recall alone before this ran, or the
   * alternate screen is active). */
  function captureOnSubmit(): void {
    if (!term) return;
    const buf = term.buffer.active;
    const start = inputStart;
    resetInputStart();
    if (buf.type === "alternate" || !start) return;
    const getLine = makeLineGetter(buf);
    const endRow = findLogicalLineEndRow(getLine, start.row);
    const raw = logicalLineRange(getLine, start.row, start.col, endRow, Number.MAX_SAFE_INTEGER);
    const host = currentHostKey();
    if (!host) return;
    // The terminal window forwards to the main window, which owns the history store.
    if (terminalStore.recordHook) terminalStore.recordHook(host, raw);
    else record(host, raw);
  }

  /** Scans outgoing data for the handful of keys §11.4 cares about, without
   * altering what actually gets sent to the PTY (that still happens once,
   * unmodified, right after this). A multi-line paste is *not* special-cased:
   * each embedded '\r'/'\n' just re-triggers `captureOnSubmit` against
   * whatever has echoed back so far (per the task, only the last line of a
   * paste reliably captures correctly — a known, accepted limitation of
   * capturing from the rendered buffer instead of a shell hook). */
  function processCapture(data: string): void {
    if (!term) return;
    for (const ch of data) {
      if (term.buffer.active.type === "alternate") {
        resetInputStart();
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        captureOnSubmit();
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code === 0x03 || code === 0x15 || code === 0x04) {
        // Ctrl+C, Ctrl+U, Ctrl+D: abandon the in-progress command, don't record it.
        resetInputStart();
        continue;
      }
      if (inputStart === null) {
        const buf = term.buffer.active;
        inputStart = { row: buf.baseY + buf.cursorY, col: buf.cursorX };
      }
    }
  }

  // --- ghost hints (§11.4) --------------------------------------------------
  let ghostSuffix = $state<string | null>(null);
  let ghostLeft = $state(0);
  let ghostTop = $state(0);
  let ghostHeight = $state(0);
  let ghostTimer: ReturnType<typeof setTimeout> | undefined;
  let unbindBlur: (() => void) | undefined;

  function hideGhost(): void {
    // Closing a terminal (§12 item 2's auto-close-on-exit, or the "press any
    // key to close" banner) removes this component while its xterm textarea
    // still has focus, which fires a native `blur` synchronously *during*
    // Svelte's DOM teardown (see the `onBlur` listener below) — mutating
    // `$state` at that point is a runtime error ("state_unsafe_mutation").
    // `container` is already detached by then, so bail out.
    if (!container?.isConnected) return;
    ghostSuffix = null;
  }

  function scheduleGhostUpdate(): void {
    if (ghostTimer) clearTimeout(ghostTimer);
    ghostTimer = setTimeout(updateGhost, 30);
  }

  /** Cell size and the `.xterm-screen` layer's offset within `container`,
   * measured from the live DOM rather than any private xterm API — the
   * public typings for @xterm/xterm 6 don't expose cell metrics. */
  function measureGrid(): { cellW: number; cellH: number; offsetLeft: number; offsetTop: number } | null {
    if (!term || !container || term.cols === 0 || term.rows === 0) return null;
    const screen = container.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return null;
    const screenRect = screen.getBoundingClientRect();
    if (screenRect.width === 0 || screenRect.height === 0) return null;
    const containerRect = container.getBoundingClientRect();
    return {
      cellW: screenRect.width / term.cols,
      cellH: screenRect.height / term.rows,
      offsetLeft: screenRect.left - containerRect.left,
      offsetTop: screenRect.top - containerRect.top,
    };
  }

  function updateGhost(): void {
    if (!term || !settings.terminal.historyHints) {
      hideGhost();
      return;
    }
    const buf = term.buffer.active;
    if (buf.type === "alternate" || buf.viewportY !== buf.baseY || !inputStart) {
      hideGhost();
      return;
    }
    const curRow = buf.baseY + buf.cursorY;
    const curCol = buf.cursorX;
    const getLine = makeLineGetter(buf);

    // Only hint at the end of the line (nothing meaningful typed after the
    // cursor — trailing buffer padding doesn't count).
    const rowText = getLine(curRow)?.text ?? "";
    const visibleLen = rowText.replace(/\s+$/, "").length;
    if (curCol < visibleLen) {
      hideGhost();
      return;
    }

    const typed = logicalLineRange(getLine, inputStart.row, inputStart.col, curRow, curCol);
    if (typed.length === 0 || typed.startsWith(" ")) {
      hideGhost();
      return;
    }
    const host = currentHostKey();
    const match = host ? suggest(host, typed) : null;
    const suffix = match && match.length > typed.length ? match.slice(typed.length) : null;
    if (!suffix) {
      hideGhost();
      return;
    }

    const grid = measureGrid();
    if (!grid) {
      hideGhost();
      return;
    }
    ghostSuffix = suffix;
    ghostLeft = grid.offsetLeft + buf.cursorX * grid.cellW;
    ghostTop = grid.offsetTop + buf.cursorY * grid.cellH;
    ghostHeight = grid.cellH;
  }

  /** Fits the terminal to its container and tells the backend the new size.
   * No-ops while the container has no visible size (e.g. panel hidden) —
   * callers should call this again once it becomes visible. */
  export function fit(): void {
    if (!term || !fitAddon || !container) return;
    if (container.clientWidth === 0 || container.clientHeight === 0) return;
    const dims = fitAddon.proposeDimensions();
    // A collapsed / not yet laid out pane proposes 0 or NaN: keep the last size.
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 2 || dims.rows < 1) return;
    fitAddon.fit();
    if (isDead()) return;
    api.termResize(termId, term.cols, term.rows).catch(() => {
      /* the PTY is gone (exited / dropped): nothing to resize */
    });
  }

  /** True once the PTY behind this tab has exited (or its link dropped). */
  function isDead(): boolean {
    return terminalStore.tabs.find((t) => t.id === termId)?.exited ?? true;
  }

  /** Writes to the PTY, ignoring a closed one (keys typed after exit / drop). */
  function send(data: string): void {
    if (isDead()) return;
    api.termWrite(termId, data).catch(() => {
      /* closed PTY: the exit / reconnect banner already tells the user */
    });
  }

  /** Above this many characters a paste asks first (a huge paste floods the shell). */
  const PASTE_CONFIRM_CHARS = 100_000;

  async function pasteFromClipboard(): Promise<void> {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      app.addToast("error", "Clipboard access denied: cannot paste.");
      return;
    }
    if (!text || !term) return;
    if (text.length > PASTE_CONFIRM_CHARS) {
      const lines = text.split("\n").length;
      const ok = await app.ask({
        title: "Paste a lot of text?",
        message: `The clipboard holds ${text.length.toLocaleString()} characters (${lines.toLocaleString()} lines). Paste all of it into the terminal?`,
        confirmLabel: "Paste",
      });
      if (!ok) return;
    }
    // term.paste honours bracketed-paste mode and goes through onData.
    term?.paste(text);
  }

  function scheduleFit(): void {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fit, 50);
  }

  onMount(() => {
    if (!container) return;
    void loadHistory();

    const theme = terminalTheme();
    term = new XTerm({
      cursorBlink: true,
      cursorStyle: settings.terminal.cursorStyle,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      fontSize: settings.terminal.fontSize,
      scrollback: 5000,
      allowProposedApi: true,
      theme,
    });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fit();
    ready = true;

    term.onData((data) => {
      if (awaitingCloseKey) {
        awaitingCloseKey = false;
        void terminalStore.close(termId);
        return;
      }
      processCapture(data);
      send(data);
    });

    term.onWriteParsed(() => scheduleGhostUpdate());
    term.onScroll(() => scheduleGhostUpdate());

    // Deferred (not called inline): closing this terminal (§12 item 2's
    // auto-close-on-exit, or the "press any key to close" banner) removes
    // this component while its xterm textarea still has focus, which fires
    // this listener synchronously *during* Svelte's own DOM teardown —
    // mutating `$state` at that exact point is a runtime error
    // ("state_unsafe_mutation"). Pushing the mutation to a macrotask runs it
    // after that teardown finishes either way (harmless no-op if the
    // component is already gone by then, correct hide-the-ghost behavior
    // for an ordinary blur otherwise).
    const onBlur = () => setTimeout(hideGhost, 0);
    term.textarea?.addEventListener("blur", onBlur);
    unbindBlur = () => term?.textarea?.removeEventListener("blur", onBlur);

    // Copy-on-Ctrl+C-with-selection / paste-on-Ctrl+V, ghost-hint accept on
    // End (with the cursor already at end of line, this is the same as →,
    // just spelled out for clarity), and let App.svelte's global shortcuts
    // (docs/GUIDE.md §12.2: Ctrl+`, Ctrl+J, Ctrl+Tab/Ctrl+Shift+Tab,
    // Ctrl+Shift+P, Ctrl+,, Ctrl+W, Ctrl+B) run instead of xterm swallowing
    // them.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type === "keydown" && ghostSuffix) {
        const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
        if (plain && (e.key === "ArrowRight" || e.key === "End")) {
          const suffix = ghostSuffix;
          hideGhost();
          send(suffix);
          return false;
        }
        hideGhost();
      }

      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return true;
      // §12.2: these are App.svelte's (or the panel's) global shortcuts —
      // let them bubble to the window instead of xterm consuming them.
      const key = e.key.toLowerCase();
      if (key === "`" || key === "j" || key === "w" || key === "t" || key === "b" || key === ",") return false; // Ctrl+W / Ctrl+T / Ctrl+Shift+T (§13.4.K)
      if (key === "tab") return false; // Ctrl+Tab and Ctrl+Shift+Tab
      if (key === "p" && e.shiftKey) return false; // Ctrl+Shift+P
      if (key === "n" && e.shiftKey) return false; // Ctrl+Shift+N new folder (plain Ctrl+N stays readline's)
      if (key === "f" && e.shiftKey) return false; // Ctrl+Shift+F find in files
      if (e.type !== "keydown") return true;
      // Ctrl+Backspace / Ctrl+Delete delete a word, as in VS Code's terminal:
      // ^W (unix-word-rubout) and ESC d (kill-word) for readline, zsh and vim.
      // xterm would otherwise send a bare DEL / CSI 3;5~. `input` goes through
      // onData so ghost-hint tracking sees it like typed keys.
      if (!e.altKey && !e.shiftKey && (e.key === "Backspace" || e.key === "Delete")) {
        e.preventDefault();
        term?.input(e.key === "Backspace" ? "\x17" : "\x1bd");
        return false;
      }
      if (key === "c") {
        const selection = term?.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => app.addToast("error", "Clipboard access denied: cannot copy."));
          return false;
        }
        return true;
      }
      if (key === "v") {
        // preventDefault stops the browser's native paste event too; without it
        // xterm also pastes from that event and the text arrives twice.
        e.preventDefault();
        void pasteFromClipboard();
        return false;
      }
      return true;
    });

    // Replay what this PTY printed before this xterm existed (a window that newly hosts
    // the terminal, or output racing the mount), then go live. Live chunks carry the
    // backend's `seq`; ones already inside the snapshot are dropped. They are held back
    // while the snapshot is in flight so nothing is written out of order.
    let replaying = true;
    let skipUpTo = 0;
    let held: { data: string; seq?: number }[] = [];
    terminalStore.onData(termId, (data, seq) => {
      if (replaying) {
        held.push({ data, seq });
        return;
      }
      if (seq !== undefined && seq <= skipUpTo) return;
      term?.write(data);
    });
    void api
      .termSnapshot(termId)
      .then((snap) => {
        skipUpTo = snap.seq;
        if (snap.data) term?.write(snap.data);
      })
      .catch(() => {})
      .finally(() => {
        replaying = false;
        for (const h of held) if (h.seq === undefined || h.seq > skipUpTo) term?.write(h.data);
        held = [];
        // A reconnect re-numbers the PTY's chunks from 1: stop filtering soon after the replay.
        setTimeout(() => (skipUpTo = 0), 1000);
      });
    terminalStore.onExit(termId, (code, keepOpen) => {
      if (!keepOpen) return; // store is removing this tab; nothing to render
      const suffix = code === null ? "" : ` with code ${code}`;
      term?.write(`\r\n\x1b[90m[exited${suffix}] — press any key to close\x1b[0m\r\n`);
      awaitingCloseKey = true;
      hideGhost();
    });

    // Registers this instance's focus fn and — as its side effect — resolves
    // `openNew()`'s wait for this Terminal to have mounted (docs/GUIDE.md
    // §12.1).
    terminalStore.registerFocus(termId, () => term?.focus());

    resizeObserver = new ResizeObserver(() => scheduleFit());
    resizeObserver.observe(container);
  });

  // Terminal always follows the *app* theme (never the editor's
  // `themeOverride`) — see docs/GUIDE.md §11 "Terminal theming".
  $effect(() => {
    if (!ready || !term) return;
    term.options.theme = terminalTheme();
  });

  $effect(() => {
    if (!ready || !term) return;
    if (term.options.fontSize !== settings.terminal.fontSize) {
      term.options.fontSize = settings.terminal.fontSize;
      fit(); // cell metrics changed — refit so cols/rows (and the PTY) stay correct
    }
  });

  $effect(() => {
    if (!ready || !term) return;
    term.options.cursorStyle = settings.terminal.cursorStyle;
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    if (resizeTimer) clearTimeout(resizeTimer);
    if (ghostTimer) clearTimeout(ghostTimer);
    unbindBlur?.();
    terminalStore.offHandlers(termId);
    term?.dispose();
  });
</script>

<div class="terminal-host" bind:this={container}>
  {#if ghostSuffix}
    <div
      class="ghost-hint"
      style={`left:${ghostLeft}px; top:${ghostTop}px; height:${ghostHeight}px; line-height:${ghostHeight}px; font-size:${settings.terminal.fontSize}px;`}
    >{ghostSuffix}</div>
  {/if}
</div>

<style>
  .terminal-host {
    position: relative;
    width: 100%;
    height: 100%;
    padding: 4px 0 0 6px;
  }

  .terminal-host :global(.xterm) {
    height: 100%;
  }

  .ghost-hint {
    position: absolute;
    margin: 0;
    padding: 0;
    white-space: pre;
    pointer-events: none;
    font-family: 'Cascadia Code', Consolas, monospace;
    color: var(--muted-foreground);
    opacity: 0.7;
    user-select: none;
  }
</style>
