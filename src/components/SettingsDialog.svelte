<script lang="ts">
  // Settings dialog (Ctrl+, / gear / palette) — docs/GUIDE.md §11 "Settings".
  // Sections: Appearance / Editor / Files / Terminal, plus a search box that
  // filters rows by label (and switches to showing every matching section).
  // Every control binds straight to `settings` (settings.svelte.ts persists
  // automatically, debounced).
  import { app } from "../lib/stores.svelte";
  import { settings, DEFAULTS, updateSettings } from "../lib/settings.svelte";
  import { THEME_LIST, THEMES } from "../lib/themes";
  import { ACCENT_PRESETS, DENSITIES, RADII, themeSwatches } from "../lib/appearance";
  import { normalizeHex } from "../lib/color";
  import { openThemePicker } from "../lib/themepicker.svelte";
  import * as api from "../lib/api";
  import { terminalStore } from "../lib/terminal.svelte";
  import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { ToggleGroup, ToggleGroupItem } from "$lib/components/ui/toggle-group/index.js";
  import CheckIcon from "@lucide/svelte/icons/check";
  import RotateCcwIcon from "@lucide/svelte/icons/rotate-ccw";
  import PlugIcon from "@lucide/svelte/icons/plug";
  import PaletteIcon from "@lucide/svelte/icons/palette";
  import CodeIcon from "@lucide/svelte/icons/code";
  import FilesIcon from "@lucide/svelte/icons/files";
  import SquareTerminalIcon from "@lucide/svelte/icons/square-terminal";
  import SearchIcon from "@lucide/svelte/icons/search";
  import GitBranchIcon from "@lucide/svelte/icons/git-branch";

  type SectionId = "appearance" | "editor" | "files" | "terminal" | "connection" | "git";

  const SECTIONS: { id: SectionId; label: string; icon: typeof PaletteIcon; rows: string[] }[] = [
    {
      id: "appearance",
      label: "Appearance",
      icon: PaletteIcon,
      rows: ["Color Theme", "Accent Color", "UI Density", "Corner Radius", "Terminal Accent", "Reset Theme Customization"],
    },
    {
      id: "editor",
      label: "Editor",
      icon: CodeIcon,
      rows: [
        "Editor Theme",
        "Font Family",
        "Font Size",
        "Font Ligatures",
        "Minimap",
        "Word Wrap",
        "Sticky Scroll",
        "Bracket Pair Colorization",
        "Render Whitespace",
        "Line Numbers",
        "Tab Size",
        "Insert Spaces",
        "Smooth Scrolling",
        "Cursor Blinking",
        "Tab Switch Order",
      ],
    },
    {
      id: "files",
      label: "Files",
      icon: FilesIcon,
      rows: ["Auto Save", "Auto Save Delay", "Show Hidden Files"],
    },
    {
      id: "terminal",
      label: "Terminal",
      icon: SquareTerminalIcon,
      rows: [
        "Font Size",
        "Cursor Style",
        "Command History Hints",
        "Panel Position",
        "Recording",
        "Record new terminals automatically",
        "Recordings folder",
      ],
    },
    {
      id: "connection",
      label: "Connection",
      icon: PlugIcon,
      rows: ["Auto-Reconnect", "Pause on Drop", "Continue When Network Returns", "Keep Tunnels in Tray"],
    },
    {
      id: "git",
      label: "Git",
      icon: GitBranchIcon,
      rows: [
        "Enable Source Control",
        "Auto Fetch",
        "Prune on Fetch",
        "Confirm Sync",
        "Smart Commit",
        "Confirm Discard",
        "Pull with Rebase",
        "Graph Max Commits",
        "Graph All Branches",
        "Show Remote Branches",
        "Side-by-Side Diff",
        "Ignore Whitespace",
        "Default Branch Name",
      ],
    },
  ];

  // Git section (§14.4.G1): one row per `settings.git` field.
  const GIT_SECTION = SECTIONS.find((s) => s.id === "git")!;
  type GitBool = {
    [K in keyof typeof settings.git]: (typeof settings.git)[K] extends boolean ? K : never;
  }[keyof typeof settings.git];
  const GIT_TOGGLES: { key: GitBool; label: string; hint: string }[] = [
    { key: "enabled", label: "Enable Source Control", hint: "Show the Source Control view and detect repositories on the VM." },
    { key: "pruneOnFetch", label: "Prune on Fetch", hint: "Remove remote-tracking branches that no longer exist on the remote when fetching." },
    { key: "confirmSync", label: "Confirm Sync", hint: "Ask before pull, push and sync." },
    { key: "smartCommit", label: "Smart Commit", hint: "With nothing staged, offer to commit all changes directly." },
    { key: "confirmDiscard", label: "Confirm Discard", hint: "Ask before discarding changes or deleting untracked files." },
    { key: "pullRebase", label: "Pull with Rebase", hint: "Use git pull --rebase instead of merging." },
    { key: "graphAllBranches", label: "Graph All Branches", hint: "Show every branch in the commit graph, not just the current one." },
    { key: "showRemoteBranches", label: "Show Remote Branches", hint: "List remote branches in the Branches pane and the branch picker." },
    { key: "diffSideBySide", label: "Side-by-Side Diff", hint: "Show diffs side by side; off shows them inline." },
    { key: "ignoreWhitespace", label: "Ignore Whitespace", hint: "Ignore whitespace changes in diffs." },
  ];

  let selected = $state<SectionId>("appearance");
  let query = $state("");

  const q = $derived(query.trim().toLowerCase());

  function rowVisible(label: string): boolean {
    return q === "" || label.toLowerCase().includes(q);
  }

  function sectionVisible(section: (typeof SECTIONS)[number]): boolean {
    if (q === "") return selected === section.id;
    return section.rows.some((r) => r.toLowerCase().includes(q));
  }

  let defaultRecDir = $state("");
  void api.recDefaultDir().then((d) => (defaultRecDir = d)).catch(() => {});

  async function pickRecordingsFolder(): Promise<void> {
    const dir = await openFolderDialog({ directory: true, multiple: false });
    if (typeof dir === "string") settings.terminal.recording.directory = dir;
  }

  function showRecordings(): void {
    app.showSettings = false;
    terminalStore.showRecordings = true;
  }

  // Appearance (docs/GUIDE.md §14.4.Z).
  const themeAccent = $derived(THEMES[settings.theme]?.accent ?? "#61afef");
  const accentCustom = $derived(
    settings.appearance.accent !== null && !ACCENT_PRESETS.some((p) => p.color === settings.appearance.accent),
  );
  const appearanceCustomized = $derived(
    JSON.stringify(settings.appearance) !== JSON.stringify(DEFAULTS.appearance),
  );

  function setAccentHex(raw: string): void {
    const hex = normalizeHex(raw);
    if (hex) settings.appearance.accent = hex;
  }

  function browseThemes(): void {
    app.showSettings = false;
    setTimeout(openThemePicker, 50); // after the dialog has released focus
  }

  async function resetToDefaults(): Promise<void> {
    const ok = await app.ask({
      title: "Reset settings",
      message: "Reset every setting to its default value? This can't be undone.",
      confirmLabel: "Reset",
      danger: true,
    });
    if (ok) updateSettings(structuredClone(DEFAULTS));
  }
</script>

<Dialog.Root bind:open={app.showSettings}>
  <Dialog.Content class="flex h-[560px] max-h-[85vh] w-full !max-w-3xl flex-col overflow-hidden p-0">
    <Dialog.Header class="border-b border-border px-4 pt-4 pb-3">
      <Dialog.Title>Settings</Dialog.Title>
      <div class="relative mt-1">
        <SearchIcon class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input class="h-7 pl-7 text-[13px]" placeholder="Search settings…" bind:value={query} spellcheck="false" />
      </div>
    </Dialog.Header>

    <div class="flex min-h-0 flex-1">
      <nav class="w-40 flex-none overflow-y-auto border-r border-border p-1.5">
        {#each SECTIONS as section (section.id)}
          <button
            type="button"
            class={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] ${selected === section.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
            onclick={() => (selected = section.id)}
          >
            <section.icon class="size-3.5" />
            {section.label}
          </button>
        {/each}
      </nav>

      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        <!-- Appearance ---------------------------------------------------- -->
        {#if sectionVisible(SECTIONS[0])}
          <section class="pb-4">
            {#if q === ""}<h3 class="pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Appearance</h3>{/if}
            {#if rowVisible("Color Theme")}
              <div class="py-2">
                <div class="flex flex-wrap items-end justify-between gap-2 pb-2">
                  <div>
                    <div class="text-[13px] font-medium">Color Theme</div>
                    <div class="text-[11px] text-muted-foreground">The app's overall color theme.</div>
                  </div>
                  <Button variant="outline" size="sm" class="h-7 text-[12px]" onclick={browseThemes} data-testid="settings-browse-themes">
                    <PaletteIcon class="size-3.5" /> Browse themes
                    <span class="text-[10px] text-muted-foreground">Ctrl+Alt+T</span>
                  </Button>
                </div>
                <div class="grid gap-2" style="grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));">
                  {#each THEME_LIST as theme (theme.id)}
                    {@const x = theme.xterm}
                    <button
                      type="button"
                      data-testid="settings-theme-card"
                      data-theme-id={theme.id}
                      class={`flex flex-col gap-1.5 rounded-md border p-1.5 text-left ${settings.theme === theme.id ? "border-primary ring-1 ring-primary" : "border-border hover:border-muted-foreground"}`}
                      onclick={() => (settings.theme = theme.id)}
                    >
                      <div
                        class="flex h-14 overflow-hidden rounded-sm border border-border/60"
                        style={`background:${theme.monaco.colors["editor.background"]}`}
                      >
                        <div class="w-4 flex-none" style={`background:${theme.monaco.colors["editorGutter.background"]}`}></div>
                        <div class="flex min-w-0 flex-1 flex-col justify-center gap-1 px-1.5">
                          <span class="h-1 w-2/3 rounded-full" style={`background:${x.magenta}`}></span>
                          <span class="ml-2 h-1 w-1/2 rounded-full" style={`background:${x.green}`}></span>
                          <span class="ml-2 h-1 w-3/4 rounded-full" style={`background:${x.blue}`}></span>
                          <span class="h-1 w-2/5 rounded-full" style={`background:${x.yellow}`}></span>
                        </div>
                        <span class="m-1 size-1.5 flex-none rounded-full" style={`background:${theme.accent}`}></span>
                      </div>
                      <div class="flex items-center gap-1">
                        <span class="truncate text-[11px]">{theme.label}</span>
                        <span class="ml-auto flex flex-none overflow-hidden rounded-[2px]" aria-hidden="true">
                          {#each themeSwatches(theme).slice(3, 7) as color, k (k)}
                            <span class="h-1.5 w-1.5" style={`background:${color}`}></span>
                          {/each}
                        </span>
                      </div>
                    </button>
                  {/each}
                </div>
              </div>
            {/if}

            {#if rowVisible("Accent Color")}
              <div class="border-t border-border/60 py-2.5" data-testid="accent-row">
                <div class="flex flex-wrap items-center justify-between gap-2 pb-2">
                  <div>
                    <div class="text-[13px] font-medium">Accent Color</div>
                    <div class="text-[11px] text-muted-foreground">
                      Buttons, focus rings, selection, the active view marker and the editor cursor.
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-7 text-[12px]"
                    disabled={settings.appearance.accent === null}
                    onclick={() => (settings.appearance.accent = null)}
                    data-testid="accent-default"
                  >
                    Use theme default
                  </Button>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    title={`Theme default (${themeAccent})`}
                    aria-label="Theme default accent"
                    aria-pressed={settings.appearance.accent === null}
                    class={`flex size-6 items-center justify-center rounded-full border-2 ${settings.appearance.accent === null ? "border-foreground" : "border-transparent hover:border-muted-foreground"}`}
                    style={`background:${themeAccent}`}
                    onclick={() => (settings.appearance.accent = null)}
                  >
                    {#if settings.appearance.accent === null}<CheckIcon class="size-3.5 text-black/70" />{/if}
                  </button>
                  {#each ACCENT_PRESETS as preset (preset.color)}
                    <button
                      type="button"
                      title={preset.label}
                      aria-label={`${preset.label} accent`}
                      aria-pressed={settings.appearance.accent === preset.color}
                      data-testid="accent-swatch"
                      data-color={preset.color}
                      class={`flex size-6 items-center justify-center rounded-full border-2 ${settings.appearance.accent === preset.color ? "border-foreground" : "border-transparent hover:border-muted-foreground"}`}
                      style={`background:${preset.color}`}
                      onclick={() => (settings.appearance.accent = preset.color)}
                    >
                      {#if settings.appearance.accent === preset.color}<CheckIcon class="size-3.5 text-black/70" />{/if}
                    </button>
                  {/each}
                  <label
                    class={`relative flex size-6 cursor-pointer items-center justify-center overflow-hidden rounded-full border-2 ${accentCustom ? "border-foreground" : "border-border hover:border-muted-foreground"}`}
                    title="Custom color"
                    style={accentCustom ? `background:${settings.appearance.accent}` : "background:conic-gradient(red, yellow, lime, aqua, blue, magenta, red)"}
                  >
                    <input
                      type="color"
                      class="absolute inset-0 size-full cursor-pointer opacity-0"
                      aria-label="Custom accent color"
                      value={settings.appearance.accent ?? themeAccent}
                      oninput={(e) => setAccentHex(e.currentTarget.value)}
                    />
                  </label>
                  <Input
                    class="h-7 w-24 font-mono text-[12px]"
                    placeholder={themeAccent}
                    maxlength={7}
                    spellcheck="false"
                    aria-label="Accent color hex"
                    data-testid="accent-hex"
                    value={settings.appearance.accent ?? ""}
                    onchange={(e) => {
                      const v = e.currentTarget.value.trim();
                      if (v === "") settings.appearance.accent = null;
                      else setAccentHex(v);
                      e.currentTarget.value = settings.appearance.accent ?? "";
                    }}
                  />
                </div>
              </div>
            {/if}

            {#if rowVisible("UI Density")}
              <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">UI Density</div>
                  <div class="text-[11px] text-muted-foreground">Scales text and spacing across the app.</div>
                </div>
                <ToggleGroup
                  type="single"
                  size="sm"
                  value={settings.appearance.density}
                  onValueChange={(v) => v && (settings.appearance.density = v as typeof settings.appearance.density)}
                >
                  {#each DENSITIES as d (d.id)}
                    <ToggleGroupItem value={d.id} class="px-2.5 text-[11px]">{d.label}</ToggleGroupItem>
                  {/each}
                </ToggleGroup>
              </div>
            {/if}

            {#if rowVisible("Corner Radius")}
              <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Corner Radius</div>
                  <div class="text-[11px] text-muted-foreground">Roundness of buttons, inputs and popups.</div>
                </div>
                <ToggleGroup
                  type="single"
                  size="sm"
                  value={settings.appearance.radius}
                  onValueChange={(v) => v && (settings.appearance.radius = v as typeof settings.appearance.radius)}
                >
                  {#each RADII as r (r.id)}
                    <ToggleGroupItem value={r.id} class="px-2.5 text-[11px]">{r.label}</ToggleGroupItem>
                  {/each}
                </ToggleGroup>
              </div>
            {/if}

            {#if rowVisible("Terminal Accent")}
              <div class="flex items-center justify-between gap-4 border-t border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Terminal Accent</div>
                  <div class="text-[11px] text-muted-foreground">Use the accent color for the terminal cursor and selection.</div>
                </div>
                <Switch bind:checked={settings.appearance.terminalAccent} />
              </div>
            {/if}

            {#if rowVisible("Reset Theme Customization")}
              <div class="flex items-center justify-between gap-4 border-t border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Reset Theme Customization</div>
                  <div class="text-[11px] text-muted-foreground">Back to the theme's own accent, density and radius.</div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  class="h-7 text-[12px]"
                  disabled={!appearanceCustomized}
                  onclick={() => Object.assign(settings.appearance, DEFAULTS.appearance)}
                  data-testid="appearance-reset"
                >
                  <RotateCcwIcon class="size-3.5" /> Reset
                </Button>
              </div>
            {/if}
          </section>
        {/if}

        <!-- Editor ---------------------------------------------------------- -->
        {#if sectionVisible(SECTIONS[1])}
          <section class="pb-4">
            {#if q === ""}<h3 class="pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Editor</h3>{/if}

            {#if rowVisible("Editor Theme")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Editor Theme</div>
                  <div class="text-[11px] text-muted-foreground">Overrides the app theme in Monaco only.</div>
                </div>
                <Select.Root
                  type="single"
                  value={settings.editor.themeOverride ?? "__follow"}
                  onValueChange={(v) => (settings.editor.themeOverride = v === "__follow" ? null : (v as typeof settings.editor.themeOverride))}
                >
                  <Select.Trigger class="h-7 w-44 text-[12px]">
                    {settings.editor.themeOverride
                      ? (THEME_LIST.find((t) => t.id === settings.editor.themeOverride)?.label ?? "Follow app theme")
                      : "Follow app theme"}
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="__follow" label="Follow app theme">Follow app theme</Select.Item>
                    {#each THEME_LIST as theme (theme.id)}
                      <Select.Item value={theme.id} label={theme.label}>{theme.label}</Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
              </div>
            {/if}

            {#if rowVisible("Font Family")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Font Family</div>
                  <div class="text-[11px] text-muted-foreground">Controls the font of the editor.</div>
                </div>
                <Input class="h-7 w-52 text-[12px]" bind:value={settings.editor.fontFamily} spellcheck="false" />
              </div>
            {/if}

            {#if rowVisible("Font Size")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Font Size</div>
                  <div class="text-[11px] text-muted-foreground">Controls the font size in pixels (10–24).</div>
                </div>
                <Input
                  type="number"
                  min="10"
                  max="24"
                  class="h-7 w-20 text-[12px]"
                  value={settings.editor.fontSize}
                  oninput={(e) => {
                    const n = Number((e.currentTarget as HTMLInputElement).value);
                    if (Number.isFinite(n)) settings.editor.fontSize = Math.min(24, Math.max(10, n));
                  }}
                />
              </div>
            {/if}

            {#if rowVisible("Font Ligatures")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Font Ligatures</div>
                  <div class="text-[11px] text-muted-foreground">Enables/disables font ligatures.</div>
                </div>
                <Switch bind:checked={settings.editor.ligatures} />
              </div>
            {/if}

            {#if rowVisible("Minimap")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Minimap</div>
                  <div class="text-[11px] text-muted-foreground">Controls whether the minimap is shown.</div>
                </div>
                <Switch bind:checked={settings.editor.minimap} />
              </div>
            {/if}

            {#if rowVisible("Word Wrap")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Word Wrap</div>
                  <div class="text-[11px] text-muted-foreground">Wraps lines at the viewport width.</div>
                </div>
                <Switch bind:checked={settings.editor.wordWrap} />
              </div>
            {/if}

            {#if rowVisible("Sticky Scroll")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Sticky Scroll</div>
                  <div class="text-[11px] text-muted-foreground">Shows the current nesting scope at the top.</div>
                </div>
                <Switch bind:checked={settings.editor.stickyScroll} />
              </div>
            {/if}

            {#if rowVisible("Bracket Pair Colorization")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Bracket Pair Colorization</div>
                  <div class="text-[11px] text-muted-foreground">Colorizes matching brackets.</div>
                </div>
                <Switch bind:checked={settings.editor.bracketPairColorization} />
              </div>
            {/if}

            {#if rowVisible("Render Whitespace")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Render Whitespace</div>
                  <div class="text-[11px] text-muted-foreground">Controls how whitespace is rendered.</div>
                </div>
                <Select.Root type="single" value={settings.editor.renderWhitespace} onValueChange={(v) => v && (settings.editor.renderWhitespace = v as typeof settings.editor.renderWhitespace)}>
                  <Select.Trigger class="h-7 w-32 text-[12px] capitalize">{settings.editor.renderWhitespace}</Select.Trigger>
                  <Select.Content>
                    <Select.Item value="none" label="None">None</Select.Item>
                    <Select.Item value="boundary" label="Boundary">Boundary</Select.Item>
                    <Select.Item value="all" label="All">All</Select.Item>
                  </Select.Content>
                </Select.Root>
              </div>
            {/if}

            {#if rowVisible("Line Numbers")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Line Numbers</div>
                  <div class="text-[11px] text-muted-foreground">Controls the display of line numbers.</div>
                </div>
                <Switch bind:checked={settings.editor.lineNumbers} />
              </div>
            {/if}

            {#if rowVisible("Tab Size")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Tab Size</div>
                  <div class="text-[11px] text-muted-foreground">The number of spaces a tab is equal to.</div>
                </div>
                <Select.Root type="single" value={String(settings.editor.tabSize)} onValueChange={(v) => v && (settings.editor.tabSize = Number(v))}>
                  <Select.Trigger class="h-7 w-20 text-[12px]">{settings.editor.tabSize}</Select.Trigger>
                  <Select.Content>
                    <Select.Item value="2" label="2">2</Select.Item>
                    <Select.Item value="4" label="4">4</Select.Item>
                    <Select.Item value="8" label="8">8</Select.Item>
                  </Select.Content>
                </Select.Root>
              </div>
            {/if}

            {#if rowVisible("Insert Spaces")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Insert Spaces</div>
                  <div class="text-[11px] text-muted-foreground">Insert spaces when pressing Tab.</div>
                </div>
                <Switch bind:checked={settings.editor.insertSpaces} />
              </div>
            {/if}

            {#if rowVisible("Smooth Scrolling")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Smooth Scrolling</div>
                  <div class="text-[11px] text-muted-foreground">Animates scrolling in the editor.</div>
                </div>
                <Switch bind:checked={settings.editor.smoothScrolling} />
              </div>
            {/if}

            {#if rowVisible("Cursor Blinking")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Cursor Blinking</div>
                  <div class="text-[11px] text-muted-foreground">The cursor animation style.</div>
                </div>
                <Select.Root type="single" value={settings.editor.cursorBlinking} onValueChange={(v) => v && (settings.editor.cursorBlinking = v as typeof settings.editor.cursorBlinking)}>
                  <Select.Trigger class="h-7 w-28 text-[12px] capitalize">{settings.editor.cursorBlinking}</Select.Trigger>
                  <Select.Content>
                    {#each ["blink", "smooth", "phase", "expand", "solid"] as v (v)}
                      <Select.Item value={v} label={v} class="capitalize">{v}</Select.Item>
                    {/each}
                  </Select.Content>
                </Select.Root>
              </div>
            {/if}

            {#if rowVisible("Tab Switch Order")}
              <div class="flex items-center justify-between gap-4 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Tab Switch Order</div>
                  <div class="text-[11px] text-muted-foreground">
                    Ctrl+Tab goes to the most recently used tab, or round-robin in tab-strip order.
                  </div>
                </div>
                <Select.Root type="single" value={settings.editor.tabSwitchOrder} onValueChange={(v) => v && (settings.editor.tabSwitchOrder = v as typeof settings.editor.tabSwitchOrder)}>
                  <Select.Trigger class="h-7 w-40 text-[12px]">
                    {settings.editor.tabSwitchOrder === "mru" ? "Most Recently Used" : "Round Robin"}
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="mru" label="Most Recently Used">Most Recently Used</Select.Item>
                    <Select.Item value="roundRobin" label="Round Robin">Round Robin</Select.Item>
                  </Select.Content>
                </Select.Root>
              </div>
            {/if}
          </section>
        {/if}

        <!-- Files------------------------------------------------------------ -->
        {#if sectionVisible(SECTIONS[2])}
          <section class="pb-4">
            {#if q === ""}<h3 class="pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Files</h3>{/if}

            {#if rowVisible("Auto Save")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Auto Save</div>
                  <div class="text-[11px] text-muted-foreground">
                    Controls auto save of dirty files. Never triggers the sudo prompt.
                  </div>
                </div>
                <Select.Root type="single" value={settings.files.autoSave} onValueChange={(v) => v && (settings.files.autoSave = v as typeof settings.files.autoSave)}>
                  <Select.Trigger class="h-7 w-40 text-[12px]">
                    {#if settings.files.autoSave === "off"}Off
                    {:else if settings.files.autoSave === "afterDelay"}After Delay
                    {:else if settings.files.autoSave === "onFocusChange"}On Focus Change
                    {:else}On Window Change{/if}
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="off" label="Off">Off</Select.Item>
                    <Select.Item value="afterDelay" label="After Delay">After Delay</Select.Item>
                    <Select.Item value="onFocusChange" label="On Focus Change">On Focus Change</Select.Item>
                    <Select.Item value="onWindowChange" label="On Window Change">On Window Change</Select.Item>
                  </Select.Content>
                </Select.Root>
              </div>
            {/if}

            {#if settings.files.autoSave === "afterDelay" && rowVisible("Auto Save Delay")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Auto Save Delay</div>
                  <div class="text-[11px] text-muted-foreground">Delay in milliseconds before saving.</div>
                </div>
                <Input
                  type="number"
                  min="100"
                  step="100"
                  class="h-7 w-24 text-[12px]"
                  value={settings.files.autoSaveDelay}
                  oninput={(e) => {
                    const n = Number((e.currentTarget as HTMLInputElement).value);
                    if (Number.isFinite(n) && n >= 0) settings.files.autoSaveDelay = n;
                  }}
                />
              </div>
            {/if}

            {#if rowVisible("Show Hidden Files")}
              <div class="flex items-center justify-between gap-4 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Show Hidden Files</div>
                  <div class="text-[11px] text-muted-foreground">Default for newly opened connections.</div>
                </div>
                <Switch bind:checked={settings.files.showHidden} />
              </div>
            {/if}
          </section>
        {/if}

        <!-- Terminal ----------------------------------------------------- -->
        {#if sectionVisible(SECTIONS[3])}
          <section class="pb-4">
            {#if q === ""}<h3 class="pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Terminal</h3>{/if}

            {#if rowVisible("Font Size")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Font Size</div>
                  <div class="text-[11px] text-muted-foreground">Controls the terminal's font size.</div>
                </div>
                <Input
                  type="number"
                  min="8"
                  max="32"
                  class="h-7 w-20 text-[12px]"
                  value={settings.terminal.fontSize}
                  oninput={(e) => {
                    const n = Number((e.currentTarget as HTMLInputElement).value);
                    if (Number.isFinite(n)) settings.terminal.fontSize = Math.min(32, Math.max(8, n));
                  }}
                />
              </div>
            {/if}

            {#if rowVisible("Cursor Style")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Cursor Style</div>
                  <div class="text-[11px] text-muted-foreground">Controls the terminal cursor style.</div>
                </div>
                <Select.Root type="single" value={settings.terminal.cursorStyle} onValueChange={(v) => v && (settings.terminal.cursorStyle = v as typeof settings.terminal.cursorStyle)}>
                  <Select.Trigger class="h-7 w-28 text-[12px] capitalize">{settings.terminal.cursorStyle}</Select.Trigger>
                  <Select.Content>
                    <Select.Item value="block" label="Block">Block</Select.Item>
                    <Select.Item value="bar" label="Bar">Bar</Select.Item>
                    <Select.Item value="underline" label="Underline">Underline</Select.Item>
                  </Select.Content>
                </Select.Root>
              </div>
            {/if}

            {#if rowVisible("Command History Hints")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Command History Hints</div>
                  <div class="text-[11px] text-muted-foreground">Shows inline ghost-text history suggestions.</div>
                </div>
                <Switch bind:checked={settings.terminal.historyHints} />
              </div>
            {/if}

            {#if rowVisible("Panel Position")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Panel Position</div>
                  <div class="text-[11px] text-muted-foreground">Where the terminal panel docks.</div>
                </div>
                <Select.Root type="single" value={settings.terminal.position} onValueChange={(v) => v && (settings.terminal.position = v as typeof settings.terminal.position)}>
                  <Select.Trigger class="h-7 w-28 text-[12px] capitalize">{settings.terminal.position}</Select.Trigger>
                  <Select.Content>
                    <Select.Item value="bottom" label="Bottom">Bottom</Select.Item>
                    <Select.Item value="right" label="Right">Right</Select.Item>
                  </Select.Content>
                </Select.Root>
              </div>
            {/if}

            {#if rowVisible("Recording") || rowVisible("Record new terminals automatically") || rowVisible("Recordings folder")}
              <h3 class="pt-4 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Recording</h3>
            {/if}

            {#if rowVisible("Recording")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Recording</div>
                  <div class="text-[11px] text-muted-foreground">
                    Lets you record terminal sessions to asciinema .cast files, per terminal. Input (typed text, passwords) is never recorded.
                  </div>
                </div>
                <Switch bind:checked={settings.terminal.recording.enabled} data-testid="setting-recording-enabled" />
              </div>
            {/if}

            {#if settings.terminal.recording.enabled && rowVisible("Record new terminals automatically")}
              <div class="flex items-center justify-between gap-4 border-b border-border/60 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Record new terminals automatically</div>
                  <div class="text-[11px] text-muted-foreground">Starts recording as soon as a terminal opens. You can still stop it per terminal.</div>
                </div>
                <Switch bind:checked={settings.terminal.recording.autoRecordNew} />
              </div>
            {/if}

            {#if rowVisible("Recordings folder")}
              <div class="flex items-center justify-between gap-4 py-2.5">
                <div class="min-w-0">
                  <div class="text-[13px] font-medium">Recordings folder</div>
                  <div class="truncate text-[11px] text-muted-foreground" title={settings.terminal.recording.directory ?? defaultRecDir}>
                    {settings.terminal.recording.directory ?? (defaultRecDir ? `${defaultRecDir} (default)` : "Default (app data)")}
                  </div>
                </div>
                <div class="flex flex-none gap-1.5">
                  <Button variant="outline" size="sm" onclick={pickRecordingsFolder}>Choose...</Button>
                  {#if settings.terminal.recording.directory}
                    <Button variant="ghost" size="sm" onclick={() => (settings.terminal.recording.directory = null)}>Default</Button>
                  {/if}
                  <Button variant="outline" size="sm" data-testid="open-recordings" onclick={showRecordings}>Open recordings</Button>
                </div>
              </div>
            {/if}
          </section>
        {/if}

        <!-- Connection --------------------------------------------------- -->
        {#if sectionVisible(SECTIONS[4])}
          <section class="pb-4">
            {#if q === ""}<h3 class="pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Connection</h3>{/if}
            {#if rowVisible("Auto-Reconnect")}
              <div class="flex items-center justify-between gap-4 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Auto-Reconnect</div>
                  <div class="text-[11px] text-muted-foreground">Reconnect after a network drop or sleep, keeping tabs, terminals and tunnels.</div>
                </div>
                <Switch bind:checked={settings.connection.autoReconnect} />
              </div>
            {/if}
            {#if rowVisible("Pause on Drop")}
              <div class="flex items-center justify-between gap-4 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Pause on Drop</div>
                  <div class="text-[11px] text-muted-foreground">On a drop, keep the workspace but wait for you to press Continue.</div>
                </div>
                <Switch bind:checked={settings.connection.pauseOnDrop} />
              </div>
            {/if}
            {#if settings.connection.pauseOnDrop}
            {#if rowVisible("Continue When Network Returns")}
              <div class="flex items-center justify-between gap-4 py-2.5 pl-4">
                <div>
                  <div class="text-[13px] font-medium">Continue When Network Returns</div>
                  <div class="text-[11px] text-muted-foreground">With Pause on Drop: continue automatically when the network comes back.</div>
                </div>
                <Switch bind:checked={settings.connection.resumeOnRestore} />
              </div>
            {/if}
            {/if}
            {#if rowVisible("Keep Tunnels in Tray")}
              <div class="flex items-center justify-between gap-4 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Keep Tunnels in Tray</div>
                  <div class="text-[11px] text-muted-foreground">Closing the window while port forwards run hides OverSSH to the tray.</div>
                </div>
                <Switch bind:checked={settings.ports.closeToTray} />
              </div>
            {/if}
          </section>
        {/if}

        {#if sectionVisible(GIT_SECTION)}
          <section class="pb-4" data-testid="settings-git">
            {#if q === ""}<h3 class="pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Git</h3>{/if}
            {#each GIT_TOGGLES.slice(0, 1) as row (row.key)}
              {#if rowVisible(row.label)}
                <div class="flex items-center justify-between gap-4 py-2.5">
                  <div>
                    <div class="text-[13px] font-medium">{row.label}</div>
                    <div class="text-[11px] text-muted-foreground">{row.hint}</div>
                  </div>
                  <Switch bind:checked={settings.git[row.key]} />
                </div>
              {/if}
            {/each}
            {#if rowVisible("Auto Fetch")}
              <div class="flex items-center justify-between gap-4 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Auto Fetch</div>
                  <div class="text-[11px] text-muted-foreground">Minutes between background fetches. 0 turns it off.</div>
                </div>
                <Input
                  type="number"
                  min="0"
                  step="1"
                  class="h-7 w-24 text-[12px]"
                  value={settings.git.autoFetchMinutes}
                  data-testid="settings-git-autofetch"
                  oninput={(e) => {
                    const n = Number((e.currentTarget as HTMLInputElement).value);
                    if (Number.isFinite(n) && n >= 0) settings.git.autoFetchMinutes = Math.floor(n);
                  }}
                />
              </div>
            {/if}
            {#each GIT_TOGGLES.slice(1, 7) as row (row.key)}
              {#if rowVisible(row.label)}
                <div class="flex items-center justify-between gap-4 py-2.5">
                  <div>
                    <div class="text-[13px] font-medium">{row.label}</div>
                    <div class="text-[11px] text-muted-foreground">{row.hint}</div>
                  </div>
                  <Switch bind:checked={settings.git[row.key]} />
                </div>
              {/if}
            {/each}
            {#if rowVisible("Graph Max Commits")}
              <div class="flex items-center justify-between gap-4 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Graph Max Commits</div>
                  <div class="text-[11px] text-muted-foreground">How many commits the graph loads at most.</div>
                </div>
                <Input
                  type="number"
                  min="10"
                  step="50"
                  class="h-7 w-24 text-[12px]"
                  value={settings.git.graphMaxCommits}
                  oninput={(e) => {
                    const n = Number((e.currentTarget as HTMLInputElement).value);
                    if (Number.isFinite(n) && n >= 10) settings.git.graphMaxCommits = Math.floor(n);
                  }}
                />
              </div>
            {/if}
            {#each GIT_TOGGLES.slice(7) as row (row.key)}
              {#if rowVisible(row.label)}
                <div class="flex items-center justify-between gap-4 py-2.5">
                  <div>
                    <div class="text-[13px] font-medium">{row.label}</div>
                    <div class="text-[11px] text-muted-foreground">{row.hint}</div>
                  </div>
                  <Switch bind:checked={settings.git[row.key]} />
                </div>
              {/if}
            {/each}
            {#if rowVisible("Default Branch Name")}
              <div class="flex items-center justify-between gap-4 py-2.5">
                <div>
                  <div class="text-[13px] font-medium">Default Branch Name</div>
                  <div class="text-[11px] text-muted-foreground">Name of the first branch when you initialize a repository.</div>
                </div>
                <Input class="h-7 w-32 text-[12px]" bind:value={settings.git.defaultBranchName} spellcheck="false" data-testid="settings-git-branch" />
              </div>
            {/if}
          </section>
        {/if}

      </div>
    </div>

    <Dialog.Footer class="border-t border-border">
      <Button variant="outline" size="sm" onclick={resetToDefaults}>Reset to defaults</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
