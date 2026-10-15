<script lang="ts">
  // Root component of the detached terminal window (docs/GUIDE.md §14.4.W):
  // the same TerminalPanel as in the main window, plus its own keyboard handling
  // (Ctrl+W/T/Shift+T, Ctrl+Tab switcher over the terminals) and Toaster.
  import { onMount, untrack } from "svelte";
  import { app } from "../lib/stores.svelte";
  import { isMac, modKey } from "../lib/platform";
  import { settings } from "../lib/settings.svelte";
  import { THEMES } from "../lib/themes";
  import { isAppError } from "../lib/api";
  import { terminalStore } from "../lib/terminal.svelte";
  import { tabSwitcher } from "../lib/tabswitch.svelte";
  import { termLayout } from "./layout.svelte";
  import TerminalPanel from "../components/TerminalPanel.svelte";
  import TabSwitcher from "../components/TabSwitcher.svelte";
  import InputDialog from "../components/InputDialog.svelte";
  import TitleBar from "../components/chrome/TitleBar.svelte";
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import { EV, dockBack, initTerminalWindow, watchWindowGeometry, windowState } from "./bridge.svelte";
  import * as api from "../lib/api";

  onMount(() => {
    document.title = "OverSSH — Terminals";
    void initTerminalWindow();
    const stopGeometry = watchWindowGeometry();
    return stopGeometry;
  });

  // Mirror the tab list to the main window (it keeps a read-only copy for
  // "run in the active terminal" and as a fallback if this window dies).
  $effect(() => {
    if (!windowState.ready) return;
    const st = terminalStore.snapshotState();
    void api.emitEvent(EV.tabs, st);
  });

  // No terminals left (closed the last one, or its session ended): dock back.
  let hadTabs = false;
  $effect(() => {
    if (!windowState.ready) return;
    const n = terminalStore.tabs.length;
    if (n > 0) hadTabs = true;
    else if (hadTabs) untrack(() => void dockBack());
  });

  // Arrived with no terminals (detached an empty panel): open one for the active session.
  let startedEmpty = false;
  $effect(() => {
    if (!windowState.ready || startedEmpty) return;
    startedEmpty = true;
    untrack(() => {
      if (terminalStore.tabs.length > 0) return;
      void newTerminal();
    });
  });

  async function newTerminal(): Promise<void> {
    const sid = terminalStore.defaultSessionId();
    if (!sid) {
      app.addToast("info", "Connect to a host in the main window first");
      return;
    }
    try {
      await terminalStore.openNew(sid, { cwd: terminalStore.cwdFor(sid) });
    } catch (err) {
      app.addToast("error", isAppError(err) ? err.message : String(err));
    }
  }

  // --- keyboard (mirrors App.svelte's terminal-relevant shortcuts) -----------

  function onSwitcherKey(e: KeyboardEvent): void {
    if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Tab") tabSwitcher.move(e.shiftKey ? -1 : 1);
    else if (e.key === "ArrowDown" || e.key === "ArrowRight") tabSwitcher.move(1);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") tabSwitcher.move(-1);
    else if (e.key === "Enter") tabSwitcher.commit();
    else if (e.key === "Escape") tabSwitcher.cancel();
  }

  function onKeydownCapture(e: KeyboardEvent): void {
    const mod = modKey(e);
    const key = e.key.toLowerCase();

    if (tabSwitcher.active) {
      onSwitcherKey(e);
      return;
    }
    // A confirm dialog (e.g. a large paste) owns the keyboard: no shortcuts behind it.
    if (app.dialogRequest) {
      if (e.key === "F5" || (mod && (key === "r" || key === "p"))) e.preventDefault();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && key === "w") {
      e.preventDefault();
      void terminalStore.closeActive();
      return;
    }
    if (mod && !e.altKey && key === "t") {
      e.preventDefault();
      if (e.shiftKey) void terminalStore.reopenClosed();
      else void newTerminal();
      return;
    }
    // macOS: Cmd+Tab is the OS app switcher, so Ctrl+Tab switches terminals there too.
    if ((mod || (isMac && e.ctrlKey)) && key === "tab") {
      e.preventDefault();
      e.stopPropagation();
      tabSwitcher.step(e.shiftKey ? -1 : 1, "terminal");
      return;
    }
    // Split panes (VS Code keys): Ctrl+\ / Ctrl+Shift+5 split right, Ctrl+Shift+\ split down.
    if (mod && !e.altKey && (e.code === "Backslash" || (e.shiftKey && e.code === "Digit5"))) {
      e.preventDefault();
      e.stopPropagation();
      void termLayout.split(e.code === "Backslash" && e.shiftKey ? "col" : "row");
      return;
    }
    // Alt+Arrow moves focus between panes (only while split, so readline's Alt+Left/Right still work otherwise).
    if (e.altKey && !mod && !e.shiftKey && termLayout.isSplit && e.key.startsWith("Arrow")) {
      const dir = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[e.key] as
        | "left"
        | "right"
        | "up"
        | "down";
      e.preventDefault();
      e.stopPropagation();
      termLayout.focusDirection(dir);
      return;
    }
    if (mod && (e.key === "`" || key === "j")) {
      e.preventDefault();
      terminalStore.focusActive();
      return;
    }
    // Browser shortcuts that must not fire in a terminal app.
    if (e.key === "F5" || e.key === "F7") {
      e.preventDefault();
      return;
    }
    if (mod && (key === "r" || key === "u" || key === "o" || key === "s" || key === "h" || key === "g")) {
      e.preventDefault();
      return;
    }
    if (mod && !e.shiftKey && key === "p") {
      e.preventDefault(); // print
      return;
    }
    if (mod && e.shiftKey && (key === "i" || key === "j" || key === "c" || key === "p" || key === "f")) {
      e.preventDefault(); // devtools, palette/search live in the main window
      return;
    }
    if (mod && key === "n" && e.shiftKey) {
      e.preventDefault();
      return;
    }
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
    }
  }

  function onKeyupCapture(e: KeyboardEvent): void {
    if (e.key === "Control" && tabSwitcher.active) tabSwitcher.commit();
  }

  /** Keep the terminal's own right-click menu behaviour; block the webview's. */
  function onContextMenuCapture(e: MouseEvent): void {
    const t = e.target;
    if (t instanceof Element && t.closest(".xterm")) {
      e.preventDefault();
      return;
    }
    if (t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    e.preventDefault();
  }
</script>

<svelte:window
  onkeydowncapture={onKeydownCapture}
  onkeyupcapture={onKeyupCapture}
  onblur={() => tabSwitcher.cancel()}
  oncontextmenucapture={onContextMenuCapture}
/>

<div class="flex h-full w-full flex-col bg-background text-foreground" data-testid="terminal-window">
  <TitleBar compact title="Terminals" />
  <div class="min-h-0 flex-1">
    {#if windowState.ready}
      <TerminalPanel detached />
    {:else}
      <div class="flex h-full items-center justify-center text-xs text-muted-foreground">Starting terminals...</div>
    {/if}
  </div>
</div>

<TabSwitcher />
<InputDialog />
<Toaster position="bottom-right" theme={THEMES[settings.theme]?.isDark ? "dark" : "light"} />
