<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import { app } from "./lib/stores.svelte";
  import { onSessionClosed } from "./lib/api";
  import { settings, DEFAULTS } from "./lib/settings.svelte";
  import { refreshMonacoThemes } from "./lib/monaco";
  import { openThemePicker, themePicker } from "./lib/themepicker.svelte";
  import { THEMES } from "./lib/themes";
  import { registerCommand } from "./lib/commands.svelte";
  import { terminalStore } from "./lib/terminal.svelte";
  import { focusActiveEditor } from "./components/Editor.svelte";
  import { tabSwitcher } from "./lib/tabswitch.svelte";
  import TabSwitcher from "./components/TabSwitcher.svelte";
  import ThemePicker from "./components/ThemePicker.svelte";
  import HostList from "./components/HostList.svelte";
  import Explorer from "./components/Explorer.svelte";
  import CommandHistory from "./components/CommandHistory.svelte";
  import EditorTabs from "./components/EditorTabs.svelte";
  import PromptDialog from "./components/PromptDialog.svelte";
  import SettingsDialog from "./components/SettingsDialog.svelte";
  import RecordingsDialog from "./components/recordings/RecordingsDialog.svelte";
  import CommandPalette from "./components/CommandPalette.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import TransfersHost from "./components/transfers/TransfersHost.svelte";
  import TerminalPanel from "./components/TerminalPanel.svelte";
  import DetachedBar from "./terminal-window/DetachedBar.svelte";
  import WorkspaceSwitcher from "./components/WorkspaceSwitcher.svelte";
  import Logo from "./components/Logo.svelte";
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import { Kbd } from "$lib/components/ui/kbd/index.js";
  import ServerIcon from "@lucide/svelte/icons/server";
  import FolderTreeIcon from "@lucide/svelte/icons/folder-tree";
  import SquareTerminalIcon from "@lucide/svelte/icons/square-terminal";
  import SettingsIcon from "@lucide/svelte/icons/settings";
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import ScrollTextIcon from "@lucide/svelte/icons/scroll-text";
  import CableIcon from "@lucide/svelte/icons/cable";
  import SearchIcon from "@lucide/svelte/icons/search";
  import SearchView from "./components/search/SearchView.svelte";
  import GitBranchIcon from "@lucide/svelte/icons/git-branch";
  import ScmView from "./components/git/ScmView.svelte";
  import GitView from "./components/git/GitView.svelte";
  import { registerGitCommands, showSourceControl } from "./lib/git/commands";
  import { searchStore } from "$lib/search.svelte";
  import MonitorSidebar from "./components/monitor/MonitorSidebar.svelte";
  import MonitorView from "./components/monitor/MonitorView.svelte";
  import LogSidebar from "./components/logs/LogSidebar.svelte";
  import LogView from "./components/logs/LogView.svelte";
  import PortsView from "./components/ports/PortsView.svelte";
  import type { SidebarView } from "./lib/stores.svelte";

  let unlisten: UnlistenFn | undefined;

  // The sidebar view to restore when Ctrl+B / the activity bar re-shows it
  // after being hidden (docs/GUIDE.md §12 item 17: `sidebarView: … | null`,
  // null = hidden). Tracks whatever the view was last set to, regardless of
  // which code path set it (activity bar, palette commands, connect flow…).
  let lastSidebarView = $state<SidebarView>("hosts");
  $effect(() => {
    if (app.sidebarView !== null) lastSidebarView = app.sidebarView;
  });

  /** Activity bar click: clicking the icon of the currently visible view
   * hides the sidebar; clicking another view shows it with that view. */
  function toggleSidebarView(view: SidebarView): void {
    app.sidebarView = app.sidebarView === view ? null : view;
  }

  // "Search: Find in Files" (palette) bumps focusRequest; show the view.
  $effect(() => {
    if (searchStore.focusRequest) app.sidebarView = "search";
  });

  /** Activity bar entries, top to bottom. */
  const VIEWS: { id: SidebarView; label: string; icon: typeof ServerIcon }[] = [
    { id: "hosts", label: "Hosts", icon: ServerIcon },
    { id: "explorer", label: "Explorer", icon: FolderTreeIcon },
    { id: "search", label: "Search", icon: SearchIcon },
    { id: "scm", label: "Source Control", icon: GitBranchIcon },
    { id: "commands", label: "Commands", icon: SquareTerminalIcon },
    { id: "monitor", label: "Dashboard", icon: ActivityIcon },
    { id: "logs", label: "Logs", icon: ScrollTextIcon },
    { id: "ports", label: "Ports", icon: CableIcon },
  ];

  /** The main area shows the Dashboard / Logs page while that view is the
   * visible sidebar view (or the last one, when the sidebar is hidden). */
  const mainPage = $derived.by((): "editor" | "monitor" | "logs" | "git" => {
    const v = app.sidebarView ?? lastSidebarView;
    if (v === "scm") return "git";
    return v === "monitor" || v === "logs" ? v : "editor";
  });

  /** Ctrl+B / "View: Toggle Sidebar". */
  function toggleSidebar(): void {
    app.sidebarView = app.sidebarView === null ? lastSidebarView : null;
  }

  onMount(() => {
    void onSessionClosed((payload) => app.handleSessionClosed(payload)).then((fn) => {
      unlisten = fn;
    });

    // Core command-palette entries. src/lib/commands.svelte.ts's registry lets
    // other modules (editor, terminal) add more later without touching this file.
    const unregisterFns = [
      registerCommand({
        id: "view.hosts",
        title: "View: Hosts",
        category: "View",
        run: () => (app.sidebarView = "hosts"),
      }),
      registerCommand({
        id: "view.explorer",
        title: "View: Explorer",
        category: "View",
        run: () => (app.sidebarView = "explorer"),
      }),
      registerCommand({
        id: "view.commands",
        title: "View: Commands",
        category: "View",
        run: () => (app.sidebarView = "commands"),
      }),
      registerCommand({
        id: "view.toggleSidebar",
        title: "View: Toggle Sidebar",
        category: "View",
        keybinding: "Ctrl+B",
        run: toggleSidebar,
      }),
      registerCommand({
        id: "view.toggleTerminal",
        title: "Toggle Terminal Panel",
        category: "View",
        keybinding: "Ctrl+J",
        run: () => (app.showTerminal = !app.showTerminal),
      }),
      registerCommand({
        id: "terminal.moveToBottom",
        title: "Terminal: Move Panel to Bottom",
        category: "View",
        run: () => (settings.terminal.position = "bottom"),
      }),
      registerCommand({
        id: "terminal.moveToRight",
        title: "Terminal: Move Panel to Right",
        category: "View",
        run: () => (settings.terminal.position = "right"),
      }),
      registerCommand({
        id: "terminal.togglePosition",
        title: "Terminal: Toggle Panel Position",
        category: "View",
        run: () => {
          settings.terminal.position = settings.terminal.position === "bottom" ? "right" : "bottom";
        },
      }),
      registerCommand({
        id: "preferences.openSettings",
        title: "Open Settings",
        category: "Preferences",
        keybinding: "Ctrl+,",
        run: () => (app.showSettings = true),
      }),
      registerCommand({
        id: "preferences.colorTheme",
        title: "Preferences: Color Theme",
        category: "Preferences",
        keybinding: "Ctrl+Alt+T",
        run: openThemePicker,
      }),
      registerCommand({
        id: "preferences.resetAppearance",
        title: "Preferences: Reset Theme Customization",
        category: "Preferences",
        run: () => Object.assign(settings.appearance, DEFAULTS.appearance),
      }),
      registerCommand({
        id: "editor.toggleMinimap",
        title: "Toggle Minimap",
        category: "Editor",
        run: () => (settings.editor.minimap = !settings.editor.minimap),
      }),
      registerCommand({
        id: "editor.toggleWordWrap",
        title: "Toggle Word Wrap",
        category: "Editor",
        run: () => (settings.editor.wordWrap = !settings.editor.wordWrap),
      }),
      registerCommand({
        id: "files.toggleAutoSave",
        title: "Files: Toggle Auto Save",
        category: "Files",
        run: () => {
          settings.files.autoSave = settings.files.autoSave === "off" ? "afterDelay" : "off";
        },
      }),
      registerCommand({
        id: "files.toggleHidden",
        title: "Files: Toggle Hidden Files",
        category: "Files",
        run: () => {
          if (app.activeSessionId) app.toggleHidden(app.activeSessionId);
          else settings.files.showHidden = !settings.files.showHidden;
        },
      }),
      registerCommand({
        id: "connection.new",
        title: "Connection: New Connection",
        category: "Connection",
        run: () => {
          app.sidebarView = "hosts";
          app.showQuickConnect = true;
        },
      }),
      registerCommand({
        id: "connection.disconnectCurrent",
        title: "Connection: Disconnect Current",
        category: "Connection",
        run: () => {
          if (app.activeSessionId) void app.disconnectSession(app.activeSessionId);
        },
      }),
      registerCommand({
        id: "file.save",
        title: "File: Save",
        category: "File",
        keybinding: "Ctrl+S",
        run: () => {
          const tabId = app.activeWorkspace?.activeTabId;
          if (tabId) void app.saveTab(tabId);
        },
      }),
      registerCommand({
        id: "file.closeTab",
        title: "File: Close Tab",
        category: "File",
        keybinding: "Ctrl+W",
        run: () => {
          const tabId = app.activeWorkspace?.activeTabId;
          if (tabId) void app.closeTab(tabId);
        },
      }),
      registerCommand({
        id: "file.reopenClosedTab",
        title: "View: Reopen Closed Tab",
        category: "View",
        keybinding: "Ctrl+Shift+T",
        run: () => void app.reopenClosedTab(),
      }),
      registerCommand({
        id: "terminal.new",
        title: "Terminal: New Terminal",
        category: "Terminal",
        keybinding: "Ctrl+T",
        run: () => void newTerminal(),
      }),
      registerCommand({
        id: "terminal.reopenClosed",
        title: "Terminal: Reopen Closed Terminal",
        category: "Terminal",
        keybinding: "Ctrl+Shift+T",
        run: () => void terminalStore.reopenClosed(),
      }),
      registerCommand({
        id: "explorer.newFile",
        title: "Explorer: New File",
        category: "File",
        keybinding: "Ctrl+N",
        run: () => newEntry("file"),
      }),
      registerCommand({
        id: "explorer.newFolder",
        title: "Explorer: New Folder",
        category: "File",
        keybinding: "Ctrl+Shift+N",
        run: () => newEntry("folder"),
      }),
      registerCommand({
        id: "explorer.refresh",
        title: "Refresh Explorer",
        category: "View",
        keybinding: "F5",
        run: () => {
          if (app.activeSessionId) void app.refreshExplorer(app.activeSessionId);
        },
      }),
    ];

    const offGit = registerGitCommands(); // §14.4.G1: Git palette commands + repo detection

    return () => {
      for (const off of unregisterFns) off();
      offGit();
    };
  });

  onDestroy(() => {
    unlisten?.();
  });

  // Accent colour changes re-define the Monaco themes (no-op until Monaco loaded).
  $effect(() => {
    void settings.appearance.accent;
    void settings.theme;
    void settings.editor.themeOverride;
    refreshMonacoThemes();
  });

  // --- responsive layout (docs/GUIDE.md §14.4.U) -----------------------------
  // The middle section (editor / Dashboard / Logs / Git) must keep at least
  // MIN_MAIN_W x MIN_MAIN_H, so the sidebar and the terminal panel are clamped
  // to what is left. The clamps are derived from the live window / <main>
  // size, so they re-apply on window resize without touching the stored sizes.
  const ACTIVITY_W = 44; // activity bar (w-11)
  const RESIZER = 4; // w-1 / h-1 drag handle
  const MIN_MAIN_W = 280;
  const MIN_MAIN_H = 120;
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 520;
  const PANEL_MIN_W = 160;
  const PANEL_MIN_H = 80;

  let panelHeight = $state(260);
  let panelWidth = $state(480);
  let mainEl: HTMLElement | undefined = $state();
  let resizingPanel = false;
  let resizingPanelRight = false;

  let winW = $state(typeof window !== "undefined" ? window.innerWidth : 1280);
  let mainW = $state(0);
  let mainH = $state(0);

  const rightPanelVisible = $derived(settings.terminal.position === "right" && app.showTerminal);

  /** Widest the sidebar may be: leaves MIN_MAIN_W for the middle section (and
   * PANEL_MIN_W for a visible right-docked terminal). */
  function sidebarMax(): number {
    const reserved = ACTIVITY_W + RESIZER + MIN_MAIN_W + (rightPanelVisible ? RESIZER + PANEL_MIN_W : 0);
    return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, winW - reserved));
  }
  function clampSidebar(w: number): number {
    return Math.min(sidebarMax(), Math.max(SIDEBAR_MIN, w));
  }
  /** Widest the right-docked terminal may be (0 = unknown yet: no clamp). */
  function panelMaxW(): number {
    return mainW > 0 ? Math.max(PANEL_MIN_W, mainW - RESIZER - MIN_MAIN_W) : Infinity;
  }
  function panelMaxH(): number {
    return mainH > 0 ? Math.max(PANEL_MIN_H, mainH - RESIZER - MIN_MAIN_H) : Infinity;
  }
  const sidebarPx = $derived(clampSidebar(app.sidebarWidth));
  const panelWPx = $derived(Math.min(panelMaxW(), Math.max(PANEL_MIN_W, panelWidth)));
  const panelHPx = $derived(Math.min(panelMaxH(), Math.max(PANEL_MIN_H, panelHeight)));

  let dragging = false;

  function startDrag(e: PointerEvent): void {
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onDrag(e: PointerEvent): void {
    if (!dragging) return;
    app.sidebarWidth = clampSidebar(e.clientX - ACTIVITY_W);
  }

  function stopDrag(): void {
    dragging = false;
  }

  // Terminal panel size (local to this component — the panel itself is
  // always mounted so its terminals survive being hidden *and* survive a
  // bottom/right position switch (§12 item 11): only layout — flex direction,
  // which edge the resizer sits on, height vs width — changes; the
  // <TerminalPanel> instance below is never re-created.

  function startPanelDrag(e: PointerEvent): void {
    resizingPanel = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPanelDrag(e: PointerEvent): void {
    if (!resizingPanel || !mainEl) return;
    const bottom = mainEl.getBoundingClientRect().bottom;
    panelHeight = Math.min(panelMaxH(), Math.max(PANEL_MIN_H, bottom - e.clientY));
  }

  function stopPanelDrag(): void {
    resizingPanel = false;
  }

  function startPanelDragRight(e: PointerEvent): void {
    resizingPanelRight = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPanelDragRight(e: PointerEvent): void {
    if (!resizingPanelRight || !mainEl) return;
    const rect = mainEl.getBoundingClientRect();
    panelWidth = Math.min(panelMaxW(), Math.max(PANEL_MIN_W, rect.right - e.clientX));
  }

  function stopPanelDragRight(): void {
    resizingPanelRight = false;
  }

  // --- keyboard (docs/GUIDE.md §12.2, capture phase) ------------------------

  function isInsideMonaco(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest(".monaco-editor") !== null;
  }

  function isInsideXterm(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest(".xterm") !== null;
  }

  /** `` Ctrl+` ``: panel hidden -> show + focus a terminal (opening one if the
   * active session has none); panel shown + terminal focused -> focus the
   * editor; panel shown + terminal not focused -> focus the terminal. */
  async function toggleTerminalFocus(): Promise<void> {
    if (terminalStore.detached) {
      terminalStore.focusWindow(); // the panel lives in the terminal window (§14.4.W)
      return;
    }
    if (!app.showTerminal) {
      app.showTerminal = true;
      if (!terminalStore.focusActive() && app.activeSessionId) {
        await terminalStore.openNew(app.activeSessionId, { cwd: app.activeExplorer?.cwd });
      }
    } else if (terminalStore.hasFocus()) {
      focusActiveEditor();
    } else {
      terminalStore.focusActive();
    }
  }

  /** Ctrl+T in a terminal / "Terminal: New Terminal": new terminal for the
   * active session, in the explorer's current directory. */
  async function newTerminal(): Promise<void> {
    const sid = app.activeSessionId;
    if (!sid) {
      app.addToast("info", "Connect to a host first");
      return;
    }
    await terminalStore.openNew(sid, { cwd: app.activeExplorer?.cwd });
  }

  /** Keys while the Ctrl+Tab switcher is open: Tab/arrows move, Enter commits,
   * Esc cancels; everything else is swallowed so it can't leak into the editor. */
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

  /** Releasing Ctrl commits the highlighted tab. */
  function onWindowKeyupCapture(e: KeyboardEvent): void {
    if (e.key === "Control" && tabSwitcher.active) tabSwitcher.commit();
  }

  /** New file/folder in the explorer's selected directory (or the selected
   * file's parent, or the explorer root) of the active session. */
  function newEntry(kind: "file" | "folder"): void {
    const sid = app.activeSessionId;
    const dir = sid ? app.newEntryDir(sid) : null;
    if (!sid || !dir) {
      app.addToast("info", "Connect to a host first");
      return;
    }
    if (kind === "file") void app.createFileIn(sid, dir);
    else void app.createFolderIn(sid, dir);
  }

  /** Single capture-phase `window` keydown handler: app shortcuts (which must
   * win over Monaco/xterm consuming the same combo) first, then the browser
   * default-shortcut blocklist. Capture phase per §12.2. */
  function onWindowKeydownCapture(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (tabSwitcher.active) {
      onSwitcherKey(e);
      return;
    }
    if (themePicker.open) return; // ThemePicker.svelte owns the keyboard while open

    // --- app shortcuts ---
    // Ctrl+W / Ctrl+T / Ctrl+Shift+T: terminal tabs when focus is in an xterm,
    // editor tabs otherwise (§13.4.K).
    if (mod && !e.shiftKey && !e.altKey && key === "w") {
      e.preventDefault();
      if (isInsideXterm(e.target)) {
        void terminalStore.closeActive();
      } else {
        const tabId = app.activeWorkspace?.activeTabId;
        if (tabId) void app.closeTab(tabId);
      }
      return;
    }
    if (mod && !e.altKey && key === "t") {
      e.preventDefault();
      if (app.dialogRequest) return;
      if (isInsideXterm(e.target)) {
        if (e.shiftKey) void terminalStore.reopenClosed();
        else void newTerminal();
      } else if (e.shiftKey) {
        void app.reopenClosedTab();
      } else {
        newEntry("file");
      }
      return;
    }
    if (mod && e.key === "`") {
      e.preventDefault();
      void toggleTerminalFocus();
      return;
    }
    if (mod && !e.shiftKey && key === "j") {
      e.preventDefault();
      app.showTerminal = !app.showTerminal;
      return;
    }
    if (mod && !e.shiftKey && key === "b") {
      e.preventDefault();
      toggleSidebar();
      return;
    }
    if (mod && e.altKey && !e.shiftKey && key === "t") {
      e.preventDefault();
      e.stopPropagation(); // not Monaco / xterm
      openThemePicker();
      return;
    }
    if (mod && key === ",") {
      e.preventDefault();
      app.showSettings = true;
      return;
    }
    if (mod && e.shiftKey && key === "p") {
      e.preventDefault();
      app.showPalette = true;
      return;
    }
    if (mod && e.shiftKey && !e.altKey && key === "g") {
      e.preventDefault(); // Ctrl+Shift+G: Source Control (Ctrl+G stays "go to line" / find)
      showSourceControl();
      return;
    }
    if (mod && key === "tab") {
      e.preventDefault();
      e.stopPropagation(); // Monaco must not see it
      tabSwitcher.step(e.shiftKey ? -1 : 1, isInsideXterm(e.target) ? "terminal" : "file");
      return;
    }
    // Ctrl+N / Ctrl+Shift+N: new file / folder. Ctrl+N inside a terminal
    // stays readline's "next history" (the browser default is still blocked
    // below); neither fires while a prompt dialog is already open.
    if (mod && !e.altKey && key === "n" && !app.dialogRequest && !(isInsideXterm(e.target) && !e.shiftKey)) {
      e.preventDefault();
      newEntry(e.shiftKey ? "folder" : "file");
      return;
    }
    if (e.key === "F5") {
      // Always block the browser's own reload; additionally refresh the
      // explorer through the app handler when a session is active.
      e.preventDefault();
      if (app.activeSessionId) void app.refreshExplorer(app.activeSessionId);
      return;
    }

    // --- browser default shortcuts we never want (§12.2 "Browser keys") ---
    if (mod && key === "r") {
      e.preventDefault(); // reload / hard reload (Ctrl+R, Ctrl+Shift+R)
      return;
    }
    if (mod && e.key === "F5") {
      e.preventDefault(); // Ctrl+F5 hard reload
      return;
    }
    if (mod && !e.shiftKey && key === "p") {
      e.preventDefault(); // browser print (Ctrl+Shift+P is the palette, above)
      return;
    }
    if (mod && key === "u") {
      e.preventDefault(); // view source
      return;
    }
    if (mod && key === "o") {
      e.preventDefault(); // open file
      return;
    }
    if (mod && key === "s" && !isInsideMonaco(e.target)) {
      e.preventDefault(); // save page (inside Monaco, its own Ctrl+S command handles it)
      return;
    }
    if (mod && e.shiftKey && !e.altKey && key === "f") {
      e.preventDefault();
      e.stopPropagation();
      searchStore.focusRequest += 1;
      return;
    }
    if ((mod && key === "f") || e.key === "F3" || (mod && key === "g")) {
      if (!isInsideMonaco(e.target) && !isInsideXterm(e.target)) e.preventDefault();
      return;
    }
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault(); // browser back/forward history nav
      return;
    }
    if (e.key === "F7") {
      e.preventDefault(); // caret browsing prompt
      return;
    }
    if (mod && e.shiftKey && (key === "i" || key === "j" || key === "c")) {
      e.preventDefault(); // devtools
      return;
    }
    if (mod && (key === "n" || (!e.shiftKey && key === "h"))) {
      e.preventDefault(); // new window / InPrivate window / history (Ctrl+T/Ctrl+Shift+T are app shortcuts)
      return;
    }
  }

  /** WebView2's native context menu is disabled everywhere except plain form
   * fields (so cut/copy/paste still works there) that aren't part of Monaco
   * or xterm — both render their own context menu and must keep working. */
  function onContextMenuCapture(e: MouseEvent): void {
    const target = e.target;
    const isFormField =
      target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
    const insideEditorOrTerminal = isInsideMonaco(target) || isInsideXterm(target);
    if (isFormField && !insideEditorOrTerminal) return;
    // shadcn/bits-ui context menus (editor tabs) ignore events that are already
    // default-prevented, and they call preventDefault themselves.
    if (target instanceof HTMLElement && target.closest('[data-slot="context-menu-trigger"]')) return;
    e.preventDefault();
  }
</script>

<svelte:window bind:innerWidth={winW} onkeydowncapture={onWindowKeydownCapture} onkeyupcapture={onWindowKeyupCapture} onblur={() => tabSwitcher.cancel()} oncontextmenucapture={onContextMenuCapture} />

<Tooltip.Provider>
  <div class="flex h-full flex-col">
    <div class="flex min-h-0 flex-1">
      <nav class="flex w-11 flex-none flex-col gap-0.5 border-r border-border bg-sidebar py-1.5" aria-label="Views">
        {#each VIEWS as v (v.id)}
          <div class="relative flex justify-center">
            <span
              class={`absolute left-0 top-1 bottom-1 w-0.5 rounded-r bg-primary transition-opacity ${app.sidebarView === v.id ? "opacity-100" : "opacity-0"}`}
              aria-hidden="true"
            ></span>
            <Tooltip.Root>
              <Tooltip.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    class={`flex size-8 items-center justify-center rounded-md hover:bg-accent hover:text-foreground ${app.sidebarView === v.id ? "bg-accent text-primary" : "text-muted-foreground"}`}
                    aria-label={v.label}
                    onclick={() => toggleSidebarView(v.id)}
                  >
                    <v.icon size={19} />
                  </button>
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content side="right">{v.label}</Tooltip.Content>
            </Tooltip.Root>
          </div>
        {/each}

        <div class="flex-1"></div>

        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Settings"
                onclick={() => (app.showSettings = true)}
              >
                <SettingsIcon size={19} />
              </button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content side="right">Settings (Ctrl+,)</Tooltip.Content>
        </Tooltip.Root>
      </nav>

      {#if app.sidebarView !== null}
        <aside class="@container/side flex min-w-0 flex-none flex-col overflow-hidden border-r border-border bg-sidebar text-sidebar-foreground" style={`width:${sidebarPx}px`}>
          <div class="flex min-h-0 flex-1 flex-col">
            {#if app.sidebarView === "hosts"}
              <HostList />
            {:else if app.sidebarView === "explorer"}
              <Explorer />
            {:else if app.sidebarView === "commands"}
              <CommandHistory />
            {:else if app.sidebarView === "monitor"}
              <MonitorSidebar />
            {:else if app.sidebarView === "logs"}
              <LogSidebar />
            {:else if app.sidebarView === "ports"}
              <PortsView />
            {:else if app.sidebarView === "scm"}
              <ScmView />
            {:else if app.sidebarView === "search"}
              <SearchView />
            {/if}
          </div>
        </aside>

        <div
          class="w-1 flex-none cursor-col-resize bg-transparent hover:bg-primary active:bg-primary"
          role="separator"
          aria-orientation="vertical"
          onpointerdown={startDrag}
          onpointermove={onDrag}
          onpointerup={stopDrag}
        ></div>
      {/if}

      <main
        class={`flex min-w-0 min-h-0 flex-1 ${settings.terminal.position === "right" ? "flex-row" : "flex-col"}`}
        bind:this={mainEl}
        bind:clientWidth={mainW}
        bind:clientHeight={mainH}
      >
        <!-- Middle section: named container "main" (§14.4.U). Pages inside adapt
             with Tailwind container variants, e.g. @sm/main:, @2xl/main:. -->
        <div class="@container/main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="middle-section">
          <WorkspaceSwitcher />
          {#if terminalStore.detached}
            <DetachedBar />
          {/if}

          <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
            <!-- Main-area page (docs/GUIDE.md §13.1): the Dashboard and Logs
                 views take over the editor area while their view is the
                 current/last sidebar view; every other view shows the editor. -->
            {#if mainPage === "monitor"}
              <MonitorView />
            {:else if mainPage === "git"}
              <GitView />
            {:else if mainPage === "logs"}
              <LogView />
            {:else if (app.activeWorkspace?.tabs.length ?? 0) === 0}
              <div class="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
                <Logo size={96} />
                <p class="text-base font-medium text-foreground">OverSSH</p>
                <ul class="flex flex-col gap-1.5 text-[12px]">
                  <li><Kbd>Ctrl</Kbd> + <Kbd>S</Kbd> save</li>
                  <li><Kbd>Ctrl</Kbd> + <Kbd>W</Kbd> close tab</li>
                  <li><Kbd>Ctrl</Kbd> + <Kbd>T</Kbd> new file / terminal</li>
                  <li><Kbd>Ctrl</Kbd> + <Kbd>Shift</Kbd> + <Kbd>T</Kbd> reopen closed tab</li>
                  <li><Kbd>Ctrl</Kbd> + <Kbd>F</Kbd> find in file</li>
                  <li><Kbd>Ctrl</Kbd> + <Kbd>`</Kbd> focus terminal / editor</li>
                  <li><Kbd>Ctrl</Kbd> + <Kbd>J</Kbd> toggle terminal panel</li>
                  <li><Kbd>Ctrl</Kbd> + <Kbd>B</Kbd> toggle sidebar</li>
                  <li><Kbd>Ctrl</Kbd> + <Kbd>Tab</Kbd> switch tabs (hold Ctrl)</li>
                  <li><Kbd>Ctrl</Kbd> + <Kbd>,</Kbd> settings</li>
                  <li><Kbd>Ctrl</Kbd> + <Kbd>Shift</Kbd> + <Kbd>P</Kbd> command palette</li>
                  <li><Kbd>Ctrl</Kbd> + <Kbd>N</Kbd> new file</li>
                  <li><Kbd>Ctrl</Kbd> + <Kbd>Shift</Kbd> + <Kbd>N</Kbd> new folder</li>
                  <li><Kbd>F2</Kbd> rename · <Kbd>Del</Kbd> delete</li>
                  <li><Kbd>F5</Kbd> refresh explorer</li>
                </ul>
              </div>
            {:else}
              <EditorTabs />
            {/if}
          </div>
        </div>

        {#if settings.terminal.position === "right"}
          <div
            class={`w-1 flex-none cursor-col-resize bg-transparent hover:bg-primary active:bg-primary ${app.showTerminal ? "" : "hidden"}`}
            role="separator"
            aria-orientation="vertical"
            onpointerdown={startPanelDragRight}
            onpointermove={onPanelDragRight}
            onpointerup={stopPanelDragRight}
          ></div>
        {:else}
          <div
            class={`h-1 flex-none cursor-row-resize bg-transparent hover:bg-primary active:bg-primary ${app.showTerminal ? "" : "hidden"}`}
            role="separator"
            aria-orientation="horizontal"
            onpointerdown={startPanelDrag}
            onpointermove={onPanelDrag}
            onpointerup={stopPanelDrag}
          ></div>
        {/if}

        <!-- Always mounted (never {#if}'d away) so terminals survive the panel
             being hidden and survive a bottom/right position switch — only
             this wrapper's layout (height vs width, which border) changes. -->
        <div
          class={`flex-none overflow-hidden bg-sidebar ${app.showTerminal ? "" : "hidden"} ${settings.terminal.position === "right" ? "border-l border-border" : "border-t border-border"}`}
          style={settings.terminal.position === "right" ? `width:${panelWPx}px` : `height:${panelHPx}px`}
        >
          {#if !terminalStore.detached}
            <TerminalPanel />
          {/if}
        </div>
      </main>
    </div>

    <StatusBar />
  </div>

  <TransfersHost />

  <PromptDialog />
  <SettingsDialog />
  <RecordingsDialog />
  <CommandPalette />
  <TabSwitcher />
  <ThemePicker />
</Tooltip.Provider>
<Toaster position="bottom-right" theme={THEMES[settings.theme]?.isDark ? "dark" : "light"} />
