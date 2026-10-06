# OverSSH — Build Guide

A lightweight Windows desktop app (cross-platform capable) for working on remote VMs
over plain SSH: browse the remote filesystem, edit files with syntax highlighting,
run a terminal — **with nothing installed on the VM** (only `sshd` + the SFTP subsystem,
which every stock Linux server already has).

This document is the single source of truth for every agent (Opus / Sonnet / Haiku)
working on the repo. Read it fully before touching code. If you change a contract in
§5, update this file in the same change.

---

## 1. Why this stack (research summary)

| Option | Binary size | RAM idle | Code editor / terminal ecosystem | Verdict |
|---|---|---|---|---|
| **Tauri v2** (Rust + system WebView2) | ~5–12 MB | ~40–80 MB | Full web ecosystem (CodeMirror 6, xterm.js) | **Chosen** |
| Electron | 120–200 MB | 150–300 MB | Same web ecosystem | Too heavy |
| Wails (Go + WebView2) | ~10 MB | similar to Tauri | Same | Fine, but Rust SSH libs are pure-Rust & no CGO pain; user already has rustup |
| Neutralino | ~3 MB | low | Same, but no real native backend for SSH | Would need a sidecar |
| egui / iced / Slint (pure native) | small | small | No mature code editor or terminal widget | Too much to build |

Key facts that drove the choice:
- WebView2 ships with Windows 11 → Tauri adds almost nothing to the install.
- **`russh` + `russh-sftp`** are pure Rust. No libssh2, no OpenSSL, no C toolchain
  beyond MSVC. One TCP connection per host, multiplexed channels (SFTP + PTYs).
- Why this beats "VS Code Remote": VS Code installs a ~100 MB Node server on the VM.
  We only speak SFTP/SSH, which the VM already speaks.

## 2. Tech decisions (do not change without Opus sign-off)

| Area | Choice |
|---|---|
| Shell | Tauri **v2** |
| Frontend | **Svelte 5** (runes) + **TypeScript** + **Vite** + **Tailwind v4** + **shadcn-svelte** (bits-ui). See §11. |
| Editor | **Monaco** (`monaco-editor`, bundled locally, workers via Vite `?worker`). CodeMirror is removed in Phase 3. See §11. |
| Terminal | **xterm.js** (`@xterm/xterm`, `@xterm/addon-fit`) |
| SSH | `russh` (client) + `russh-sftp` (client), `tokio` |
| SSH config | Hand-written parser in `src-tauri/src/ssh_config.rs` (small, unit-tested) |
| Errors | `thiserror` in Rust, serialized to the UI as `{ kind, message }` |
| Packaging | `npm run tauri build` → `overssh.exe` + NSIS installer |

## 3. Features (scope)

**MVP (Phase 1–2)**
1. **Hosts sidebar** — parsed from `~/.ssh/config` (all concrete `Host` aliases; wildcard
   patterns like `Host *` are applied as defaults, not listed). Plus "Quick connect"
   (`user@host:port` + optional key path). Search/filter box.
2. **Connect flow** — auth order: config `IdentityFile`(s) → Windows OpenSSH agent
   (`\\.\pipe\openssh-ssh-agent`) → default keys (`id_ed25519`, `id_ecdsa`, `id_rsa`) →
   password prompt. Encrypted key → passphrase prompt. Known-hosts check with
   trust-on-first-use prompt (fingerprint shown), appended to `~/.ssh/known_hosts`.
   If `IdentityFile` ends in `.pub`, also try the same path without `.pub`
   (the user's real config has this mistake).
3. **File explorer** — lazy tree, starts at the remote home dir (`realpath(".")`),
   path bar you can type into, dirs first then files, alpha. Toggle hidden files.
   Context menu: New file, New folder, Rename, Delete (confirm), Refresh,
   Copy path, Download…, Upload here…. Drag-and-drop files from Windows Explorer
   onto a folder = upload.
4. **Editor** — tabs, one per open remote file, dirty dot, `Ctrl+S` save,
   `Ctrl+W` close (confirm if dirty), language by extension/filename, line numbers,
   search (`Ctrl+F`), bracket matching, fold. Refuse > 10 MB, warn for binary
   (NUL byte in first 8 KB). Before save, re-stat: if remote mtime changed since
   open → "File changed on server. Overwrite / Reload / Cancel".
5. **Status bar** — connection state, host, current file path, language, cursor pos.

**Phase 3**
6. **Terminal panel** — xterm.js, PTY over the same SSH connection, resizable bottom
   panel, multiple terminals, `Ctrl+`` toggle. Opens in the explorer's current dir.
7. Multiple simultaneous connections (session tabs / host switcher).
8. Save-as-root: if write fails with permission denied, offer "Save with sudo"
   (upload to `/tmp`, then `sudo -S cp` via exec channel, password prompt).

**Out of scope for now:** git UI, extensions, `ProxyCommand`. (Port forwarding and ProxyJump were added in Phase 5, §13.4.P.)

## 4. Repo layout

```
overssh/
├─ docs/GUIDE.md              ← this file
├─ CLAUDE.md                  ← short agent entrypoint (commands + pointer here)
├─ components.json            ← shadcn-svelte CLI config (aliases, base color, css path)
├─ package.json, vite.config.ts, svelte.config.js, tsconfig.json, index.html
├─ src/                       ← frontend
│  ├─ main.ts, App.svelte, app.css
│  ├─ styles/themes.css       ← shadcn + app tokens per [data-theme="…"], one block per ThemeId
│  ├─ lib/
│  │  ├─ api.ts               ← ONLY place that calls invoke()/listen(); typed wrappers of §5/§11.1
│  │  ├─ types.ts             ← TS mirrors of §5 types + §11.2 schemas (Settings/Profile/HistoryEntry)
│  │  ├─ stores.svelte.ts     ← app state (runes): sessions, per-session workspaces (tabs/explorer)
│  │  ├─ settings.svelte.ts   ← `settings` state, load/save (debounced)/deep-merge, applyTheme()
│  │  ├─ themes.ts            ← ThemeId/THEMES: label, isDark, Monaco theme, xterm theme
│  │  ├─ utils.ts             ← shadcn-svelte's `cn()` + WithElementRef/WithoutChild(ren) helpers
│  │  ├─ languages.ts         ← filename → CodeMirror LanguageSupport loader (removed in Phase 3)
│  │  └─ paths.ts             ← posix path helpers (join, dirname, basename)
│  └─ components/
│     ├─ Loader.svelte        ← delayed (150 ms) spinner, used for file/dir/connect loading states
│     ├─ HostList.svelte, QuickConnect.svelte, PromptDialog.svelte, InputDialog.svelte
│     ├─ Explorer.svelte, TreeNode.svelte, ContextMenu.svelte
│     ├─ EditorTabs.svelte, Editor.svelte
│     ├─ Terminal.svelte, TerminalPanel.svelte
│     ├─ CommandHistory.svelte, CommandPalette.svelte, SettingsDialog.svelte ← Phase 3 (P4/P5 own the real UI)
│     ├─ lib/components/ui/*  ← shadcn-svelte generated components (button, dialog, command, …)
│     └─ StatusBar.svelte
└─ src-tauri/
   ├─ Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json, icons/
   └─ src/
      ├─ main.rs              ← calls overssh_lib::run()
      ├─ lib.rs               ← builder, plugin init, command registration
      ├─ error.rs             ← AppError (thiserror + Serialize)
      ├─ ssh_config.rs        ← parser + resolve(alias) → HostConfig
      ├─ session.rs           ← SessionManager, connect/auth/known_hosts, russh Handler
      ├─ sftp.rs              ← file commands
      ├─ terminal.rs          ← PTY commands + events
      ├─ store.rs             ← §11.1 load_store/save_store (settings/profiles/history JSON)
      └─ commands.rs          ← #[tauri::command] thin wrappers
```

## 5. Contracts (frontend ⇄ backend)

All commands are `async`, return `Result<T, AppError>`. Arg names are camelCase on the
JS side (Tauri converts to snake_case in Rust automatically).

### 5.1 Types

```ts
// src/lib/types.ts
export interface HostEntry {           // one concrete Host alias from ~/.ssh/config
  alias: string;
  hostname: string;                     // resolved HostName (or alias if none)
  user: string | null;
  port: number;                         // default 22
  identityFiles: string[];              // expanded (~ → home), as written
  proxyJump: string | null;
}

export interface ConnectRequest {
  alias?: string;                       // either alias …
  hostname?: string;                    // … or explicit quick-connect fields
  user?: string;
  port?: number;
  identityFile?: string;
  password?: string;                    // filled after a NeedPassword error
  passphrase?: string;                  // filled after a NeedPassphrase error
  acceptHostKey?: boolean;              // filled after a HostKeyUnknown error
  proxyJump?: string;                   // -J override "a,b,user@c:2222"; "none" = direct (§13.4.P)
  jumpAuth?: Record<string, { password?: string; passphrase?: string; acceptHostKey?: boolean }>; // per jump hop
}

export interface SessionInfo {
  id: string;                           // uuid
  label: string;                        // alias or user@host
  user: string;
  hostname: string;
  home: string;                         // remote realpath(".")
}

export interface FileEntry {
  name: string;
  path: string;                         // absolute posix path
  kind: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mtime: number;                        // unix seconds
  permissions: number;                  // mode bits, e.g. 0o100644
  isHidden: boolean;
  linkTargetIsDir?: boolean;            // for symlinks, resolved via stat
}

export interface FileContent {
  path: string;
  content: string;                      // utf-8 (lossy)
  mtime: number;
  size: number;
  isBinary: boolean;
}

export type ErrorKind =
  | 'NeedPassword' | 'NeedPassphrase' | 'HostKeyUnknown' | 'HostKeyChanged'
  | 'AuthFailed' | 'Connection' | 'NotFound' | 'PermissionDenied'
  | 'Conflict' | 'TooLarge' | 'Config' | 'Io' | 'Other';

export interface AppError { kind: ErrorKind; message: string; fingerprint?: string; keyPath?: string; hop?: string; }
```

### 5.2 Commands

| Command | Args | Returns | Notes |
|---|---|---|---|
| `list_hosts` | – | `HostEntry[]` | Re-reads `~/.ssh/config` every call (supports `Include`). |
| `connect` | `req: ConnectRequest` | `SessionInfo` | May fail with `NeedPassword`, `NeedPassphrase` (+`keyPath`), `HostKeyUnknown` (+`fingerprint`), `HostKeyChanged` (hard stop, never auto-accept). UI then re-calls with the extra field. |
| `disconnect` | `sessionId` | `void` | |
| `list_dir` | `sessionId, path` | `FileEntry[]` | Sorted: dirs first, then case-insensitive name. Excludes `.`/`..`. |
| `stat` | `sessionId, path` | `FileEntry` | |
| `read_file` | `sessionId, path` | `FileContent` | `TooLarge` if > 10 MB. |
| `write_file` | `sessionId, path, content, expectedMtime?: number` | `number` (new mtime) | If `expectedMtime` given and remote differs → `Conflict`. Preserves existing permissions. |
| `create_file` | `sessionId, path` | `void` | Fails if exists. |
| `create_dir` | `sessionId, path` | `void` | |
| `rename` | `sessionId, from, to` | `void` | Move/rename. Fails with `Conflict` if `to` exists (never overwrites) or `to` is inside `from`. |
| `copy_path` | `sessionId, from, to` | `void` | Recursive copy. Fails with `Conflict` if `to` exists or is inside `from`. Server-side `cp -a -- 'from' 'to'` on an exec channel; SFTP read/write walk fallback if exec is unavailable (fallback skips symlinks, no owner/mtime). |
| `remove` | `sessionId, path, recursive: bool` | `void` | Recursive delete walks the tree over SFTP. |
| `download` | `sessionId, remotePath, localPath` | `void` | Single file to the exact `localPath`; runs as a transfer job (§13.4.S) and resolves when done. |
| `upload` | `sessionId, localPath, remoteDir` | `string` (remote path) | File or folder; runs as a transfer job (§13.4.S), overwrites, resolves when done. |
| `term_open` | `sessionId, cols, rows, cwd?: string` | `string` termId | Starts PTY `xterm-256color` + shell; if cwd, sends `cd '<cwd>'` first (single-quote-escape!). |
| `term_write` | `termId, data: string` | `void` | |
| `term_resize` | `termId, cols, rows` | `void` | |
| `term_close` | `termId` | `void` | |

### 5.3 Events (backend → frontend)

| Event | Payload |
|---|---|
| `term://data` | `{ termId: string, data: string }` (utf-8, lossy) |
| `term://exit` | `{ termId: string, code: number \| null }` |
| `session://closed` | `{ sessionId: string, reason: string }` |

## 6. Backend implementation notes (Rust)

- **State:** `SessionManager` in Tauri managed state:
  `tokio::sync::RwLock<HashMap<String, Arc<Session>>>`. `Session` holds the
  `russh::client::Handle<ClientHandler>`, an `russh_sftp::client::SftpSession`
  (behind `Arc`; its methods take `&self`), and terminal channel writers.
- **One connection per session**, SFTP opened once as a subsystem channel; each
  terminal is its own channel on the same connection.
- **Crypto backend: `ring`, not the default `aws-lc-rs`.** `aws-lc-sys` needs NASM on
  Windows, which we don't want as a build prerequisite. Use
  `russh = { version = "0.63", default-features = false, features = ["flate2", "ring", "rsa"] }`.
  Don't add crates that pull `aws-lc-rs` back in (check with `cargo tree -i aws-lc-rs`).
- **Host keys:** use russh's known_hosts helpers (`russh::keys::check_known_hosts_path`,
  `learn_known_hosts_path` or their current equivalents). In `check_server_key`,
  unknown key + `!accept_host_key` → store the fingerprint (SHA256) and return
  `false`; `connect` maps that to `HostKeyUnknown{fingerprint}`. Changed key →
  `HostKeyChanged`.
- **Keys:** load with `russh::keys::load_secret_key(path, passphrase)`. Detect an
  "encrypted, no passphrase" error → `NeedPassphrase{keyPath}`. For RSA keys use
  `rsa-sha2-256/512` (russh's `PrivateKeyWithHashAlg` with the server's best hash).
- **Agent:** on Windows, connect to named pipe `\\.\pipe\openssh-ssh-agent`; if absent,
  skip silently.
- **Timeouts:** TCP connect 10 s; keepalive 30 s (`russh::client::Config`
  `keepalive_interval`).
- **Reading files:** stream with SFTP read in 64 KB chunks; binary check on first 8 KB.
- **Writing files:** open with write|create|truncate, write all, then `setstat` to the
  original permissions if the file existed. Return new mtime from a fresh `stat`.
- **Never log** passwords, passphrases, or key material. No `println!` in release —
  use `log`/`eprintln!` only in debug.
- **Paths:** remote paths are POSIX strings; never use `std::path` on them.
- `ssh_config.rs` rules: keywords are case-insensitive; `Key value` or `Key=value`;
  first obtained value wins (OpenSSH semantics) except `IdentityFile` accumulates;
  `Host` patterns support `*`, `?`, `!negation`; `Include` supports relative paths
  (relative to `~/.ssh`) and globs; `~` expands to the Windows home dir; quoted
  values allowed. `Match` blocks: skip them (treat as non-matching). Unit tests required.

## 7. Frontend implementation notes

- **Layout:** VS Code-like. Left activity: hosts / explorer (resizable, 260 px default).
  Center: editor tabs. Bottom: terminal panel (hidden until opened). Bottom-most:
  status bar. Dark theme by default, matching One Dark.
- **All backend calls go through `src/lib/api.ts`.** Components never import
  `@tauri-apps/api` directly. `api.ts` normalises errors into `AppError`.
- **State:** `src/lib/stores.svelte.ts` exports a single `app` object built with
  `$state` runes: `sessions`, `activeSessionId`, `tabs[] {id, sessionId, path,
  doc, savedDoc, mtime, language}`, `activeTabId`.
- **Editor:** one `EditorView` per tab kept alive (swap the DOM node when switching
  tabs) so undo history survives. Language extension loaded lazily via dynamic
  `import()` in `languages.ts` so the initial bundle stays small.
- **Connect prompts:** `PromptDialog.svelte` handles password / passphrase /
  host-key confirm, driven by the `AppError.kind` from `connect`, then retries.
- **Keyboard:** `Ctrl+S` save, `Ctrl+W` close tab, `Ctrl+P` quick open (Phase 3,
  optional), `` Ctrl+` `` toggle terminal, `F5` refresh explorer, `F2` rename, `Del` delete.
- **Styling:** CSS vars in `app.css` (`--bg`, `--bg-alt`, `--fg`, `--muted`,
  `--accent`, `--border`, `--danger`), system font `Segoe UI`, mono `Cascadia Code, Consolas`.
- No icon library: use small inline SVG / unicode for folder/file glyphs.

## 8. Commands

Rust is at `%USERPROFILE%\.cargo\bin` — prepend it to `PATH` in each shell if `cargo` isn't found:
PowerShell: `$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"`.

| Task | Command |
|---|---|
| Install JS deps | `npm install` |
| Frontend typecheck | `npm run check` |
| Rust check (fast) | `cargo check --manifest-path src-tauri/Cargo.toml` |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Dev app | `npm run tauri dev` |
| **Release .exe** | `npm run tauri build` → `src-tauri/target/release/overssh.exe` and `src-tauri/target/release/bundle/nsis/*.exe` |

## 9. Agent roles & workflow

- **Opus (lead):** owns this guide, contracts (§5), task breakdown, reviews and
  integration. Does not write large features itself.
- **Sonnet:** feature work that spans several files or needs judgement (SSH/auth,
  SFTP, explorer, editor, terminal).
- **Haiku:** narrow, well-specified tasks (ssh_config parser + tests, language map,
  path helpers, styling passes, small fixes with a clear repro).

Every agent task must:
1. Read this guide first.
2. Only touch the files listed in its task card (§10), unless blocked — then say so.
3. Leave the tree compiling: `cargo check` and `npm run check` must pass for the parts it touched.
4. Report: files changed, what was verified (commands + result), and anything left undone.
   Don't claim something works if it wasn't run.

## 10. Task cards

| # | Phase | Agent | Task | Files |
|---|---|---|---|---|
| T0 | 0 | Opus | Scaffold Tauri v2 + Svelte 5 + TS, verify `cargo check` & `npm run build` | scaffold |
| T1 | 1 | Haiku | `ssh_config.rs` parser + `resolve()` + `list_concrete_hosts()` + unit tests | `src-tauri/src/ssh_config.rs` |
| T2 | 1 | Sonnet | Backend core: `error.rs`, `session.rs` (connect/auth/known_hosts/agent), `sftp.rs`, `commands.rs`, `lib.rs` wiring for all §5.2 file commands | `src-tauri/src/*` except `ssh_config.rs`, `terminal.rs` |
| T3 | 1 | Sonnet | Frontend: `types.ts`, `api.ts`, `stores.svelte.ts`, `paths.ts`, `languages.ts`, all components except terminal; layout + theme | `src/**` except Terminal* |
| T4 | 2 | Sonnet | Terminal: `terminal.rs` + `Terminal.svelte`, `TerminalPanel.svelte` | listed |
| T5 | 2 | Sonnet | Upload/download + drag-drop, save-conflict dialog, sudo save | listed in its prompt |
| T6 | 3 | Opus | Integration review, release build, smoke test against a real host | – |

---

## 11. Phase 3 — VS Code-style UX

User decisions (final):

| Topic | Decision |
|---|---|
| UI kit | **shadcn-svelte** (Tailwind v4 + bits-ui). Components live in `src/lib/components/ui/*` (generated by the shadcn-svelte CLI). Aliases: `$lib` → `src/lib` in both `vite.config.ts` and `tsconfig.json`. |
| Editor | **Monaco**, fully offline. Minimap and other editor features are toggles in Settings ("plugins" = Monaco feature toggles, not VS Code extensions). |
| Themes | 10 app themes: dark `one-dark`, `dracula`, `tokyo-night`, `catppuccin-mocha`, `nord`, `rose-pine`, `gruvbox-dark`, `kanagawa`, `github-dark`; light `github-light`. Each theme sets the shadcn CSS tokens, a Monaco theme, an xterm theme and a default `accent`. The editor theme follows the app theme unless `editor.themeOverride` is set. Accent, UI density and corner radius are customizable on top of any theme (§14.4.Z). |
| Autosave | VS Code modes: `off` (default) / `afterDelay` (default 1000 ms) / `onFocusChange` / `onWindowChange`. Autosave uses the same save path as Ctrl+S, so the conflict check always runs. Autosave never triggers the sudo prompt: on `PermissionDenied`, it shows a toast only. |
| Workspaces | One workspace per connected session: its own tabs, active tab, and explorer state. When you switch the active session, the editor shows only that workspace's tabs. Session-only: nothing persists across restarts. |
| Host profiles | App-only. The app never writes `~/.ssh/config`. A click on a host opens an editable form (prefilled from config) for hostname, user, port, and identity file. **(Revised, §12 hosts redesign):** connecting never creates or edits a saved host — "Save as new host" is the only way a saved host is created, and it's app-only (pin/rename/delete/edit). See `src/lib/hosts.svelte.ts`. |
| Command history | Per host (`user@hostname`). Commands with a leading space are not recorded. Inline ghost-text hints in the terminal, accepted with → at end of line. A **Commands** sidebar view: search, filter by current host or all hosts, copy, run in the active terminal, pin as a snippet. Stored locally only. |
| Loader | Show a spinner (delay 150 ms to avoid flicker) while `read_file` / `list_dir` / `connect` is in flight: in the editor area for file opens and inline on tree nodes for directory loads. |
| Settings | Settings dialog (Ctrl+,) with sections Appearance / Editor / Files / Terminal. Also a command palette (Ctrl+Shift+P) built on the shadcn `Command` component. |

### 11.1 Persistence contract (Rust `src-tauri/src/store.rs`)

| Command | Args | Returns | Notes |
|---|---|---|---|
| `load_store` | `name: "settings" \| "profiles" \| "history"` | `unknown \| null` (JSON) | Reads `<app_data_dir>/<name>.json`. Missing or corrupt file → `null` (corrupt file is renamed to `<name>.json.bak`). |
| `save_store` | `name, value: unknown` | `void` | Atomic write: write `<name>.json.tmp`, then rename. Any other name → `Config` error. |

The frontend debounces saves (500 ms) and keeps all logic in TS. Rust only stores JSON.

### 11.2 Schemas (`src/lib/types.ts`)

```ts
export type ThemeId = 'one-dark' | 'dracula' | 'tokyo-night' | 'catppuccin-mocha' | 'github-light' | 'github-dark'
  | 'nord' | 'rose-pine' | 'gruvbox-dark' | 'kanagawa';

export interface Settings {
  theme: ThemeId;
  appearance: { accent: string | null; density: 'compact' | 'normal' | 'comfortable'; radius: 'sharp' | 'default' | 'round'; terminalAccent: boolean };  // §14.4.Z
  editor: {
    themeOverride: ThemeId | null;
    fontFamily: string;            // default "Cascadia Code, Consolas, monospace"
    fontSize: number;              // 13
    ligatures: boolean;            // false
    minimap: boolean;              // true
    wordWrap: boolean;             // false
    stickyScroll: boolean;         // true
    bracketPairColorization: boolean; // true
    renderWhitespace: 'none' | 'boundary' | 'all'; // 'none'
    lineNumbers: boolean;          // true
    tabSize: number;               // 4
    insertSpaces: boolean;         // true
    smoothScrolling: boolean;      // true
    cursorBlinking: 'blink' | 'smooth' | 'phase' | 'expand' | 'solid'; // 'smooth'
  };
  files: {
    autoSave: 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange'; // 'off'
    autoSaveDelay: number;         // 1000
    showHidden: boolean;           // false
  };
  terminal: {
    fontSize: number;              // 13
    cursorStyle: 'block' | 'bar' | 'underline'; // 'bar'
    historyHints: boolean;         // true
  };
}

export interface Profile {
  id: string;                      // uuid
  name: string;                    // display name, default "user@hostname"
  alias: string | null;            // ~/.ssh/config alias it came from, if any
  hostname: string;
  user: string;
  port: number;
  identityFile: string | null;
  pinned: boolean;
  lastUsed: number;                // unix ms
}

export interface HistoryEntry {
  cmd: string;
  host: string;                    // "user@hostname"
  count: number;
  lastUsed: number;                // unix ms
  pinned: boolean;                 // pinned = snippet
}
```

Settings are loaded at startup. Missing keys are filled from defaults with a deep merge, so new settings stay backward compatible.

### 11.3 Connect overrides

`ConnectRequest` is unchanged. When `alias` is set, the explicit `hostname` / `user` / `port` / `identityFile` fields **override** the resolved config values (today `hostname` is ignored when `alias` is set, and this must change).

### 11.4 Command capture (no shell hook)

On the first input keystroke after a submitted line, record the xterm cursor position `(row, col)` as the start of the command. On Enter (`\r` in `onData`), read the text from that position to the end of the logical line in `term.buffer.active` (follow wrapped rows with `isWrapped`) and trim it. This way Tab completion and ↑-history recall are captured as displayed. Skip empty lines, lines that start with a space, and anything typed while the alternate screen is active (vim, less, top): check `term.buffer.active.type === 'alternate'`. Record per host with de-dup: bump `count` and `lastUsed`. Cap: 2000 entries per host, and evict the least recently used entries that aren't pinned.

Ghost hint: the best prefix match (pinned first, then count × recency) for the current typed text. Render it as a dim overlay positioned at the cursor cell. → or End at end of line accepts it by writing the remaining suffix to the PTY. Hide it on any other key, and when the alternate screen is active.

### 11.5 Task cards (Phase 3)

| # | Stage | Agent | Task | Owns |
|---|---|---|---|---|
| P1 | A | Haiku | Theme data: `src/lib/themes.ts` (for each ThemeId: label, isDark, Monaco `IStandaloneThemeData`, xterm `ITheme`) + `src/styles/themes.css` (shadcn token blocks per `[data-theme="…"]`) | those 2 files |
| P2 | A | Sonnet | Foundation: Tailwind v4 + shadcn-svelte init and aliases, `store.rs` + commands, `settings.svelte.ts` (load/save/defaults/merge, applies `data-theme` + `dark` class), per-workspace refactor of `stores.svelte.ts`, `Loader.svelte`, sidebar view registry incl. a stub `CommandHistory.svelte`, session/workspace switcher | listed |
| P3 | B | Sonnet | Monaco migration + editor settings + autosave + remove CodeMirror | `Editor.svelte`, `EditorTabs.svelte`, `src/lib/monaco.ts`, `src/lib/autosave.svelte.ts`, remove `languages.ts` |
| P4 | B | Sonnet | shadcn restyle of all non-editor/non-terminal UI, profiles (UI + store + `session.rs` override), Settings dialog, command palette | components listed in its prompt, `stores.svelte.ts`, `profiles.svelte.ts`, `session.rs` |
| P5 | B | Sonnet | Command history: capture, ghost hints, Commands panel, terminal theming + restyle | `Terminal*.svelte`, `terminal.svelte.ts`, `history.svelte.ts`, `CommandHistory.svelte` |

---

## 12. Phase 4 — UX fixes and workbench features

### 12.1 Shared contracts

```ts
// src/lib/terminal.svelte.ts (owner: T)
terminalStore.openNew(sessionId: string, opts?: { cwd?: string; command?: string; title?: string }): Promise<string>;
//   Shows the panel, creates and activates a new tab, focuses it. `command` is written as `command + "\r"` once the shell is ready.
terminalStore.focusActive(): boolean;   // focus the active xterm; false if there is none
terminalStore.hasFocus(): boolean;      // true if document.activeElement is inside any .xterm

// src/components/Editor.svelte <script module> (owner: S)
export function focusActiveEditor(): boolean;

// src/components/Logo.svelte (owner: I): props { size?: number; class?: string }. Uses theme tokens only.
// src/lib/appIcon.ts (owner: I): applyWindowIcon(themeId: ThemeId): Promise<void>. Renders the logo in theme colors to a canvas and calls getCurrentWindow().setIcon().

// Settings (owner: S): terminal.position: 'bottom' | 'right' (default 'bottom').
```

### 12.2 Keyboard (owner: S, in App.svelte, capture phase)

| Key | Action |
|---|---|
| `` Ctrl+` `` | Panel hidden → show it and focus the terminal (open one if the active session has none). Panel shown and terminal focused → focus the editor. Panel shown and terminal not focused → focus the terminal. |
| `Ctrl+J` | Toggle terminal panel visibility. |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Tab switcher popup (§13.4.K): hold Ctrl, Tab/Shift+Tab/arrows move, release Ctrl or Enter commits, Esc cancels. MRU or round-robin per `editor.tabSwitchOrder`. Focus in xterm = terminal tabs, else editor tabs. |
| `Ctrl+W` / `Ctrl+T` / `Ctrl+Shift+T` | Close / new / reopen-closed. Focus in xterm = terminals; else editor tabs (`Ctrl+T` = new file, same flow as `Ctrl+N`). |
| `Ctrl+N` / `Ctrl+Shift+N` | New file / new folder in the explorer: inside the selected directory, next to the selected file, else in the explorer root. Prompts for the name, then reveals and selects it; a new file also opens in the editor. Plain `Ctrl+N` inside a terminal is left to readline. Also in the explorer toolbar, the context menu and the palette. |
| Browser keys | Blocked: F5 reload (F5 still refreshes the explorer), Ctrl+R, Ctrl+Shift+R, Ctrl+F5, Ctrl+P, Ctrl+U, Ctrl+O, Ctrl+S outside the editor, Ctrl+F / F3 / Ctrl+G outside Monaco and xterm, Alt+←/→, F7, Ctrl+Shift+I/J/C, Ctrl+N/Ctrl+Shift+N/H. |

Terminal.svelte (owner: T) must let these keys through to the window instead of consuming them: `` Ctrl+` ``, Ctrl+J, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Shift+P, Ctrl+Shift+N, Ctrl+,, Ctrl+W, Ctrl+T, Ctrl+Shift+T.

### 12.3 Ownership (Phase 4)

| Agent | Items | Owns |
|---|---|---|
| H (Sonnet) | Hosts panel state bugs, filter reset, save-as-new-host, `..` row, pause/resume, UI test harness | HostList, ConnectDialog, QuickConnect, hosts.svelte.ts, stores.svelte.ts, Explorer, TreeNode, WorkspaceSwitcher, store.rs, tests/ui/**, package.json devDeps, Editor.svelte (missing-file banner only) |
| S (Sonnet) | Palette Esc bug, focus toggle, terminal position, `!` command mode, Ctrl+Tab, sidebar toggle, welcome branding, browser menu/keys | App.svelte, CommandPalette, commands.svelte.ts, settings.svelte.ts, types.ts, SettingsDialog, Editor.svelte (focusActiveEditor export only) |
| T (Sonnet) | Close on exit, commands open new terminals, "Open terminal here", terminal API | Terminal.svelte, TerminalPanel.svelte, terminal.svelte.ts, CommandHistory.svelte, ContextMenu.svelte |
| I (Haiku) | New `^` icon, themed window/taskbar icon | app-icon.svg, icons/*, Logo.svelte, appIcon.ts, capabilities/default.json |
| L (Haiku) | Pac-Man loader, highlight contrast | Loader.svelte, styles/themes.css |

## 13. Phase 5 — Dashboard, ports, logs, ProxyJump, tab UX, file ops

This supersedes the "out of scope" line in §3 for port forwarding and ProxyJump.

### 13.1 Layout (done by the lead)

- The activity bar is a list (`VIEWS` in `App.svelte`). `SidebarView` (exported from
  `stores.svelte.ts`) is `"hosts" | "explorer" | "commands" | "monitor" | "logs" | "ports"`.
- The **main area** shows `monitor/MonitorView.svelte` or `logs/LogView.svelte` while
  that view is the visible (or, if the sidebar is hidden, the last) sidebar view.
  Every other view shows the editor.
- Sidebar components: `monitor/MonitorSidebar.svelte`, `logs/LogSidebar.svelte`,
  `ports/PortsView.svelte`.
- `store.rs` whitelist also allows `"forwards"` and `"logs"` (opaque JSON, owned by
  the ports and logs features).

### 13.2 Rules for parallel agents

- Several agents work in the same tree at once. Touch only the files you own (§13.3).
- In shared files (`lib.rs`, `api.ts`, `types.ts`, `GUIDE.md`, `tests/ui/mockBackend.ts`)
  use small `Edit`s only. Never rewrite a shared file with `Write`. Re-read before editing.
- New Rust features go in their own module with their own `#[tauri::command]` fns,
  registered in `lib.rs`. Exec channels: `session.open_channel()` then `channel.exec(...)`.
- If `cargo check` or `npm run check` fails in a file you don't own, it is
  another agent's work in progress: wait a little and retry, don't fix it.
- Add a UI scenario in `tests/ui/scenarios/` (number 2x, unique per agent, see §13.3) and
  mock your new commands in `tests/ui/mockBackend.ts`.
- Document your contract in your §13.4 subsection.

### 13.3 Ownership

| Agent | Feature | Owns | Scenario numbers |
|---|---|---|---|
| M | htop-style dashboard per connected VM | `monitor.rs`, `components/monitor/**`, `lib/monitor.svelte.ts` | 20–21 |
| P | Port forwarding (-L/-R, -N/-fN tunnel-only connections) + ProxyJump (-J) | `session.rs`, `forward.rs`, `ssh_config.rs`, `components/ports/**`, `lib/forwards.svelte.ts`, `ConnectDialog.svelte`, `hosts.svelte.ts`, `HostList.svelte` | 22–23 |
| L | Log reader | `logs.rs`, `components/logs/**`, `lib/logs.svelte.ts` | 24–25 |
| K | Tab keys (Ctrl+W/T/Shift+T), Ctrl+Tab switcher (MRU + round robin) | `App.svelte`, `TabSwitcher.svelte`, `terminal.svelte.ts`, `Terminal.svelte`, `TerminalPanel.svelte`, `settings.svelte.ts`, `SettingsDialog.svelte`, `commands.svelte.ts`; in `stores.svelte.ts` only tab open/close/activate + MRU/closed-stack code | 26–27 |
| F | VS Code-like file ops (rename/move/delete keep tabs in sync, copy/cut/paste, drag-move) | `sftp.rs`, `commands.rs`, `Explorer.svelte`, `TreeNode.svelte`, `ContextMenu.svelte`, `EditorTabs.svelte`, `Editor.svelte`; in `stores.svelte.ts` only explorer/file-op code and tab retargeting | 28–29 |

Wave 2 (started while wave 1 runs, new files only; the lead wires them into `App.svelte` after agent K finishes):

| Agent | Feature | Owns | Scenario numbers |
|---|---|---|---|
| R | Remote search (grep across files on the VM) | `search.rs`, `components/search/**`, `lib/search.svelte.ts` | 30–31 |
| N | Snippets with `{{variables}}` | `CommandHistory.svelte`, `history.svelte.ts`, `components/snippets/**` | 32–33 |

Agent P also owns `-D` (SOCKS) and close-to-tray (`Cargo.toml` tray feature, tray code in `lib.rs`).

### 13.4 Contracts

(Each agent adds its subsection here.)

### 14.4.H htop tab (Dashboard)

- **Where**: `MonitorView` tab `htop` (`monitor.tab`, palette "Dashboard: htop (process manager)"). Overview no longer lists processes. `MonitorView` root is `@container/mon`; all Dashboard pages use container variants (`@2xl/mon:` ...) instead of viewport breakpoints.
- **Backend** (`monitor.rs`): the `sh -s` loop also reads `/proc/[pid]/statm` (SHR; via `grep -H .`) and, only when `threads` is requested, `/proc/[pid]/task/[tid]/stat`. `ProcInfo` gained `shr` (bytes), `start` (unix s), `tgid`, `thread`. Thread rows have `thread: true`, `ppid = tgid`, share owner's user/args/mem. `monitor_start(sessionId, intervalMs, threads?)` restarts the stream when `threads` changes. Args are clipped to 1 KiB. `tasks.total` counts processes only.
- **`proc_details`** returns `ProcDetails {pid, exists, cmdline, exe, cwd, envCount, fdCount, fds[<=15], threads, ppid, uid, vmPeak, vmSwap, ctxVoluntary, ctxNonvoluntary, ioRead, ioWrite, children[]}`. Unreadable (permission denied) fields are `-1` / empty, never an error; `exists: false` when the pid is gone. Environment values are never read, only counted.
- **Store**: `monitor.showThreads` (set by HtopView while mounted, reset on unmount), `monitor.killMany`, `monitor.details`, `INTERVALS` now starts at 500 ms.
- **Files**: `htop.ts` (pure: columns, sort, `buildRows` filter/tree/fold, `descendants`), `htopPrefs.svelte.ts` (persisted in `localStorage["overssh.htop.v1"]`: columns, sort, tree, hide kernel, threads, meters), `HtopView`, `HtopMeters`, `ProcDetails`.
- **Table**: PID PPID USER PRI NI VIRT RES SHR S CPU% MEM% TIME+ THR START Command (PPID, THR, START off by default; column picker). Header click sorts (asc/desc). Rows are windowed (20 px). Columns hide by table width (see `hideBelow` in `htop.ts`); Command, PID, S, CPU%, RES never hide. New processes flash for one refresh.
- **Keys** (focus is on the htop root): arrows, PgUp/PgDn, Home/End; Left/Right/`+`/`-`/`*` fold the tree; F9/Del/`k` signal dialog (12 signals, then a confirm); F7 or `]` nice -, F8 or `[` nice +; `/` F3 F4 filter (`a|b` = OR); F5/`t` tree; F6 cycle sort, `P M T N` sort CPU/MEM/TIME/PID, `I` invert; `K` hide kernel; `H` threads; `F` follow (keeps the selected pid scrolled into view); Space tags and moves down, `c` tags children, `U` untags, Ctrl+click tags; Enter/`i` details drawer; Esc closes drawer, then clears tags, then filter; `p` pause. Kill/nice act on tagged processes if any, else the selection.
- **Tests**: Rust (statm, task lines, details, collector with threads/shr/start); UI scenarios 54 (layout, columns, threads, kernel, user filter, tree fold, responsive) and 55 (keys, tag + multi kill, nice, follow, details incl. permission denied, pause). Scenarios 20-21 now click the htop tab. Mock: `window.__harness.monitorRunning()` (with `threads`), `kills()`, `reniceCalls()`, `detailCalls()`.
- **Gaps**: no per-process disk I/O column or `strace`/`lsof` view; "follow" keeps the pid in view but selection is always by pid (htop's index-based cursor is not emulated); IRQ/softirq are merged into "system".

### 13.4.M Dashboard

Backend `src-tauri/src/monitor.rs` (registered in `lib.rs`; managed state `Arc<MonitorManager>`).
Nothing is installed on the VM (Linux only; a missing source degrades to empty/zero).

| Command | Args | Notes |
|---|---|---|
| `monitor_start` | `sessionId, intervalMs, threads?` | Starts (or restarts with a new interval) ONE exec channel `sh -s`; a POSIX sh loop reads `/proc/stat`, `/proc/loadavg`, `/proc/uptime`, `/proc/meminfo`, `/proc/net/dev`, `/proc/[pid]/stat`, `ps -eo pid,user,args`, `df -Pkl` (every 10th round). Interval clamped 250 ms to 60 s. |
| `monitor_stop` | `sessionId` | Closes the channel (remote loop dies on SIGPIPE/EOF). |
| `proc_kill` | `sessionId, pid, signal` | `kill -s SIG pid`; signal whitelist TERM KILL HUP INT QUIT USR1 USR2 STOP CONT ALRM PIPE TSTP. |
| `proc_renice` | `sessionId, pid, nice` | `renice -n N -p pid`, N in -20..19 (htop F7/F8). |
| `proc_kill_many` | `sessionId, pids[], signal` | One `kill -s SIG p1 p2 ...` (1..500 pids, same whitelist). |
| `proc_details` | `sessionId, pid` | `ProcDetails` read from `/proc/<pid>` (see 14.4.H). |

Events: `monitor://snapshot {sessionId, snapshot}` (`MonitorSnapshot` in `types.ts`; CPU %, per-process CPU % and net rates are computed in Rust from deltas; the first warm-up block is not emitted) and `monitor://closed {sessionId, reason}` (channel ended unasked, e.g. disconnect).
Not collected: disk I/O. Per-process PPID, PRI, NI, SHR (`statm`), start time and threads are collected (see 14.4.H). The process list now lives in the **htop** tab, not in Overview.

Frontend: `lib/monitor.svelte.ts` (`monitor` store: snapshots, 120-point history, selected VM, interval, pause/freeze; `sync()` is the polling policy: sidebar mounted -> every session at 5 s; view mounted -> selected session at `intervalMs`; neither -> all stopped). Palette commands "Dashboard: Show" and "Dashboard: Pause / Resume updates". Components in `components/monitor/`: `MonitorSidebar`, `MonitorView` (tabs Overview, htop, Disk usage, Cron; `monitor.tab`), `Meter`, `Sparkline`, `HtopView`, `HtopMeters`, `ProcDetails` (14.4.H). UI tests: scenarios 20-21; the mock backend emits fake snapshots (`window.__harness.monitorRunning()` / `kills()`).

### 13.4.K Tab keys

- State: `app.tabMru` / `app.closedTabs` (per session) + `app.touchTab`, `app.mruTabs(sessionId)`, `app.reopenClosedTab()` in `stores.svelte.ts`; `terminalStore.mru` / `closedStack` / `mruTabs()` / `closeActive()` / `reopenClosed()` in `terminal.svelte.ts`.
- Switcher: `lib/tabswitch.svelte.ts` (`tabSwitcher.step/move/commit/cancel`) rendered by `components/TabSwitcher.svelte` (`data-testid="tab-switcher"`, items `tab-switcher-item`, popup appears after 120 ms). `App.svelte` drives it: Ctrl+Tab keydown, Control keyup commits, window blur cancels.
- MRU: the active tab is always first; Ctrl+Tab goes to index 1 (Shift: last). Round robin: strip order from the current tab. Setting: `editor.tabSwitchOrder: "mru" | "roundRobin"` (default `"mru"`).
- Reopen: file stack per session (max 20, skips files already open, restores line/col fields); terminal stack keeps session, cwd, title.

### 13.4.F File ops

VS Code-style explorer file operations. Logic lives in `src/lib/fileops.svelte.ts` (components call it directly; `stores.svelte.ts` only has the `ExplorerState.multi` / `dragPaths` fields and a refresh after a deleted tab is re-saved).

- **Rename / move** (`renameEntry`, cut+paste, drag): after the backend call, `retargetPaths(sessionId, from, to)` rewrites every open tab at or under `from` (`path`, `language`) in place, so the tab keeps its buffer, dirty state, cursor and Monaco model (undo history). The Monaco model URI carries the tab id in its `query`, so it is unique per tab and never needs to change. `Editor.svelte` re-applies the language mode when the extension changes. It also rewrites explorer `expanded` / `selected` / `multi` / `cwd` and drops stale `children`. File mtime is unchanged by a rename, so no false save conflict. A stale tab already sitting on the destination path is dropped. Paused sessions only snapshot paths at pause time, so nothing to rewrite.
- **Delete** (`deleteEntries`): clean tabs at/under the path close; dirty tabs stay open with `tab.missing = true` (strike-through title plus "(deleted)", `data-deleted="true"`); saving recreates the file (and refreshes the parent listing). The confirm dialog mentions unsaved changes when relevant.
- **Clipboard**: `fileClipboard` (`copy` | `cut`; paste into another session starts a VM-to-VM transfer job, §13.4.S). Ctrl+C / Ctrl+X / Ctrl+V act only while the tree has focus (handled in `Explorer.svelte`); Ctrl+Shift+C copies the path text. Paste target: `app.newEntryDir()` (selected dir, else the selected file's dir, else the cwd). Context menu: Cut, Copy, Paste, Duplicate. Cut rows are dimmed (`opacity-50`) until pasted; a cut-paste clears the clipboard.
- **Naming**: copy into a folder with a clash gets `name copy.ext`, `name copy 2.ext` (dirs/dotfiles have no extension). A move onto an existing name fails with a toast (no overwrite). Moving or copying a folder into itself is refused.
- **Multi-select**: Ctrl/Meta+click toggles, Shift+click selects a range (`ExplorerState.multi`). Cut/Copy/Delete/drag act on all selected rows; Rename is single.
- **Drag inside the tree**: pointer events (Tauri's `dragDropEnabled` swallows HTML5 DnD). Drag a row onto a folder to move, hold Ctrl to copy. Esc cancels. Uploads from Windows Explorer still use `api.onDragDrop`.
- **Undo / redo** (`undoFileOp` / `redoFileOp`, per-session stacks of 50): Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y while the tree has focus, plus "Undo ..." / "Redo ..." items in the context menu. Rename/move undo moves back (tabs retarget back). Copy/duplicate undo removes the copy, redo copies again. Create undo removes (redo restores captured content). Delete undo recreates from an in-memory snapshot taken before the delete (text, UTF-8 files only, max 5 MB / 400 files; binary, symlinks or oversized items are deleted but not restorable, with a toast). A deleted-but-dirty tab becomes normal again when its file is restored. `app.onEntryCreated` (set by `fileops`) records creates.
- **Tests**: scenarios 28, 29 and 30; the mock backend implements `rename` / `copy_path` / `remove` on its fake tree and exposes `__harness.fileExists / fileContent / writes`.

### 13.4.R Search

- Backend `search.rs`: `search_start(sessionId, req) -> searchId`, `search_cancel(searchId)`. `req` = `SearchRequest { root, query, caseSensitive?, wholeWord?, regex?, include?, exclude?, hidden?, maxResults? (default 10000, hard 100000), maxPerFile? (default 500) }`; `include`/`exclude` are comma-separated globs. Root must be absolute POSIX.
- The remote command is `sh -c '<script>'`: `cd -- root`, then `rg` if `command -v rg` succeeds, else `grep -rnI`. Both emit `path\0line:text` (`rg --null`, `grep -Z`), so `:` in paths is safe. A first stdout line `##rg` / `##grep` names the engine. `rg` runs with `--no-ignore` so both engines behave the same. Default excludes: `.git node_modules .cache __pycache__ venv .venv dist build target`. grep `--include` globs match the base name only.
- Events: `search://matches {searchId, matches:[{path (absolute), line, text}]}` (batched, text capped at 400 chars), `search://done {searchId, total, truncated, cancelled, engine, error?}`. `error` is set only when the tool failed (exit >= 2) with zero results. Cancel closes the channel; `done` still arrives with `cancelled: true`.
- Frontend: `lib/search.svelte.ts` (`searchStore`, `runSearch`, `cancelSearch`, `searchReveal`, palette command "Find in Files", category "Search", label Ctrl+Shift+F), `components/search/SearchView.svelte` (`data-testid` `search-query`, `search-group`, `search-match`, `search-summary`).
- Reveal hook: a click sets `searchReveal.pending = {sessionId, path, line, col}` then calls `app.openFile`. `Editor.svelte` must consume it (see agent R report).
- Wiring left to the lead: add a `"search"` view to `SidebarView`/`VIEWS` (label "Search"), render `SearchView` in the sidebar, bind Ctrl+Shift+F to `searchStore.focusRequest += 1` plus show the view, and apply the Editor hook. Scenario 30 needs the "Search" activity-bar button.

### 13.4.P Ports & ProxyJump

**Backend**

- `forward.rs` (+ `tray.rs`). Commands (registered in `lib.rs`):
  - `forward_start(sessionId, spec) -> ForwardInfo`, where `spec = { kind: "L" | "R" | "D", bindAddress?, bindPort, targetHost, targetPort, label? }`. The result carries `id` (the forwardId) and the real `bindPort` (when 0 was asked). `D` ignores `targetHost`/`targetPort`.
  - `forward_stop(forwardId)`. Idempotent. `forward_list() -> ForwardInfo[]`: `{ id, sessionId, kind, bindAddress, bindPort, targetHost, targetPort, label, state: "running", activeConnections, totalConnections, bytesIn, bytesOut, lastError }`. Only running forwards exist; stopped or failed ones are removed. `bytesOut` = local -> server, `bytesIn` = server -> local.
  - `forward_set_close_to_tray(enabled)`: mirror of `settings.ports.closeToTray`.
- Event `forward://state` `{ forwardId, sessionId, state: "stopped" | "error", message: string | null }`. `message` is set when the forward ended without a user stop (listener died, session closed).
- **-L**: local `TcpListener` (default `127.0.0.1`); per socket `channel_open_direct_tcpip` + `copy_bidirectional`. **-D**: same listener; each socket first runs a SOCKS handshake (SOCKS5 no-auth CONNECT with IPv4/IPv6/domain, SOCKS4 and 4a), then opens `direct-tcpip` to the requested host. **-R**: `tcpip_forward(bind, port)` (default bind `localhost`); `ClientHandler::server_channel_open_forwarded_tcpip` routes by connected port through `Session.routes` to `targetHost:targetPort`. `cancel_tcpip_forward` on stop. Bind errors give a clear `Io` message ("Port N is already in use on A"). A refused `-R` returns `Connection`.
- Forwards of a session stop on `disconnect` (command) and on a server-side close (`ClientHandler::disconnected`). Per-connection failures show in `lastError`.
- **Tray**: `tray::setup` builds the tray icon (feature `tray-icon`). While at least one forward runs and `closeToTray` is on, `CloseRequested` on the `main` window hides it instead of quitting. With no forwards the app quits as before. Tray menu: Show OverSSH, one "Stop ..." item per running tunnel, Stop all tunnels, Quit. Left click shows the window.
- **-N / -fN**: there is no new backend command. A tunnel-only connection is a normal `connect` session that the frontend does not turn into a workspace (it is still in `SessionManager`, so `forward_start` works on it).

**ProxyJump (-J)**

- `ConnectRequest.proxyJump?: string` overrides the ssh config `ProxyJump` (`none` or empty = direct). `ConnectRequest.jumpAuth?: { [hop]: { password?, passphrase?, acceptHostKey? } }` holds secrets per jump hop. `hop` is `user@hostname:port` as sent in the error.
- Each hop is resolved like an alias (config `HostName`, `User`, `Port`, `IdentityFile`; `user@host:port` and `ssh://` forms override). The chain connects hop by hop: authenticate, `channel_open_direct_tcpip` to the next hop, `client::connect_stream` over that channel. Known-hosts TOFU runs per hop with that hop's hostname/port. The jump `Handle`s are kept in `Session.jumps`; `Session::close` disconnects them. Only the final target emits `session://closed`. A jump host's own `ProxyJump` is not followed.
- `AppError` `NeedPassword`, `NeedPassphrase`, `HostKeyUnknown` carry an optional `hop`. When set, the prompt is about that jump host; the retry must put the answer under `jumpAuth[hop]` (done by `app.submitConnectPrompt`). `HostKeyChanged` mentions the jump host in its message. Without `hop` everything is as before (backward compatible).
- `ProxyCommand` is parsed but unsupported: `connect` fails with a `Config` error ("... does not support ProxyCommand ... Use ProxyJump"). `ProxyJump none` in config or `proxyJump: "none"` = direct.
- `Profile.proxyJump?: string | null` (saved hosts, app-only). `ConnectDialog` has a "Proxy jump (-J)" field prefilled from config / the saved host; an emptied config value is sent as `"none"`. `HostList` shows "via <jump>".

**Frontend**

- `lib/forwards.svelte.ts` (`forwardStore`: `rules`, `runtime`). Rules persist in the `"forwards"` store as `ForwardRule { id, host (HostItem.key), kind, bindAddress, bindPort, targetHost, targetPort, label, autoStart, tunnelOnly }`. Runtime (status `stopped | starting | running | error`, forwardId, counters) is memory only; counters poll `forward_list` every 1.5 s while something runs.
- A rule runs on: a workspace session of its host if one exists; else, if `tunnelOnly`, a background session from `app.connectBackground(req, label)`; else a normal `app.connect` (workspace opens). Background sessions are shared per host and disconnected when their last rule stops. Starts are serialized (one prompt slot).
- `stores.svelte.ts` additions (small): `AppState.connectBackground(req, label): Promise<SessionInfo | null>`, `connect(..., background?)`, `PendingConnect.hop` / `.background`, hop-aware `submitConnectPrompt`, `pauseSession` strips `jumpAuth` secrets. `PromptDialog` shows the hop (`data-testid="prompt-hop"`).
- Autostart: on app launch, `autoStart && tunnelOnly` rules start in the background; other autostart rules start when their host connects as a workspace.
- `lib/sshCommand.ts` parses pasted commands (`-L/-R/-D`, `-N`, `-f`, `-fN`, `-J`, `-p`, `-l`, `-i`, `-o LocalForward|RemoteForward|DynamicForward|ProxyJump|Port|User|IdentityFile`). An unknown host becomes a new saved host; a `-J` for a config host is ignored with a note.
- UI: `components/ports/PortsView.svelte` (+ `RuleDialog.svelte`); "Keep tunnels running in tray" switch (`settings.ports.closeToTray`, default true). "Open in browser" copies `http://localhost:port` (no opener plugin). Palette: "Ports: Forward a Port...", "Ports: Add Forwards from ssh Command...", "Ports: Show Port Forwards", "Ports: Stop All Port Forwards".
- Tests: Rust unit tests (`parse_jump_chain`, SOCKS parser, byte-counting pump); UI scenarios 22 and 23. Real forwarding and jump hosts need a real VM; they are not covered by automated tests.

### 13.4.L Logs

Log reader. Streams over exec channels, nothing installed on the VM. No new npm dependency: the list is a lean built-in virtualizer (`LogList.svelte`; fixed 18 px rows, estimated heights when wrapping), so 100k lines stay smooth. (`@tanstack/svelte-virtual` was not needed. Features follow what lnav, Klogg, LogExpert and Dozzle offer.)

**Commands** (`src-tauri/src/logs.rs`, state `LogManager`)

| Command | Args | Returns |
|---|---|---|
| `logs_open` | `sessionId, source: LogSourceSpec` | `streamId` |
| `logs_close` | `streamId` | `void` (EOF + close; `logs://end` follows) |
| `logs_discover` | `sessionId` | `{ files, containers, units }` (readable well-known logs, `docker ps` names, running systemd services; 10 s limit; missing tools give empty lists) |
| `logs_export` | `path, lines: string[]` | `void` (writes a local file chosen with the save dialog) |

`LogSourceSpec { kind: "file"|"journal"|"docker"|"command", path?, unit?, container?, command?, lines?, sudo?, password? }`. Remote commands: `tail -n N -F -- '<path>'`, `journalctl -f -n N -o short-iso [-u '<unit>']`, `docker logs -f --tail N -t '<name>'`, or the custom command as typed. `lines` defaults to 1000. `sudo` wraps the command as `sudo -S -p '' sh -c '<cmd>'` and writes the password to the channel stdin (never logged, never persisted).

**Events**: `logs://data { streamId, lines: string[] }` (batched: every 100 ms or 500 lines; stdout and stderr are merged; split on `\n`, trailing `\r` removed, lossy UTF-8, partial lines kept across chunks and flushed at the end) and `logs://end { streamId, code: number|null, error? }`. Data events can arrive before `logs_open` resolves; the store queues them by stream id. Closing the SSH connection closes the channel, so every stream of that session ends with `logs://end` (the `disconnect` command was not edited; `LogManager::close_for_session` exists if it should call it).

**Frontend**: `lib/logs.svelte.ts` (`logStore`: `tabs`, `activeId`, `saved`, `prefs`; `LogTab` class; `openLog`, `closeLog`, `exportLines`, `saveSource`). It is module-level state and subscribes to the events on import, so streams keep filling while the view is hidden. Each `LogTab` keeps a capped ring buffer (`prefs.maxLines`, default 100000, trimmed in chunks) in plain arrays; `rev` / `visRev` signal changes; `visible` holds absolute line ids. Level (ERROR/WARN/INFO/DEBUG/TRACE/OTHER) and timestamp (ISO or syslog) are auto-detected; ANSI colors are stripped. Filters: live text (plain/regex, case, invert), pinned include/exclude chips (includes are ANDed), level toggles with counts, context lines. Also: find in results (F3), follow with a "Jump to bottom" pill, pause (buffers), clear, wrap, line numbers, timestamps, row selection (click, Shift, Ctrl) + copy, export of selection or visible lines.

**Persistence**: store `"logs"` = `{ saved: SavedLogSource[] ({ id, host: "user@hostname", name, source }), prefs: { maxLines, tailLines } }`.

**Palette** (category "Logs"): Open Log File..., Open Selected Explorer File as Log, Open System Journal, Show Logs, Clear Active Log, Pause / Resume Active Log, Toggle Follow, Close Active Log.

**Tests**: Rust unit tests (splitter, batcher, command builder, discovery parser); UI scenarios 24 and 25 (mock: `logs_open`, `logs_close`, `logs_discover`, `logs_export`, `window.__harness.logStreams()`).

### 13.4.C Cron & disk usage

Dashboard main view (`MonitorView.svelte`) is tabbed: **Overview** (meters + processes, unchanged) | **Disk usage** | **Cron**. The overview keyboard shortcuts only run on the Overview tab. Both new tabs read nothing but `du` / `crontab` / `cat`: nothing is installed on the VM.

Backend (registered in `lib.rs`, managed state `DuManager`):

| Command | Args | Notes |
|---|---|---|
| `cron_read` | `sessionId` -> `string` | `crontab -l 2>&1`. "no crontab for user" gives `""`. Other failures are an `Other` error. |
| `cron_write` | `sessionId, text` | `crontab - 2>&1`, text fed on stdin of the exec channel (CRLF normalised, final newline added). The error text is crontab's own message (e.g. bad line). |
| `du_start` | `sessionId, path, depth` -> `duId` | `path` absolute (`Config` error otherwise), depth clamped 1..8. Remote `sh -c`: probes `du -x -k -d 0 /dev/null`, else `--max-depth`, else a busybox/old-du fallback (one `du -s` per child, depth 1). `nice -n 19` if present. |
| `du_cancel` | `duId` | Closes the channel; `du://done` still arrives with `cancelled: true`. |

Events: `du://entries {duId, entries:[{path, kb}]}` (batched, deepest first, the scanned path last) and `du://done {duId, cancelled, denied, errors, errorSamples, code}`. `denied` counts stderr lines with "Permission denied"; other stderr lines count as `errors` (first 5 kept as samples). Rust tests: du line parser, stderr classifier, chunked line splitter, command builder, "no crontab" detection.

Frontend:
- `lib/cron.ts` (pure, no Svelte): `parseCrontab` / `serializeCrontab` (lines are `job | env | comment | blank | unknown`; everything except edited jobs is written back verbatim; a disabled job is a commented line that parses as a valid job, written as `#<schedule> <cmd>`), `validateSchedule` (lists, ranges, steps, month/day names, `@reboot` and the `@daily` family, dow 7 = Sun), `describeSchedule`, `nextRuns` (local time of this PC, dom/dow OR rule), `diffLines`, `PRESETS`.
- `lib/cron.svelte.ts`: `cronStore.ensure(sessionId)` -> `CronSession` (lines, raw mode, dirty state survive tab switches; `save()` writes then re-reads; `loadSystem()` reads `/etc/crontab` and `/etc/cron.d/*` read-only through `readFile`).
- `lib/treemap.ts`: own squarified treemap (`squarify(items, box)`). `lib/diskusage.svelte.ts`: `diskUsage.ensure(...)` -> `DuSession` with a merged path -> KiB map; drill-down only runs `du` for a directory whose children are unknown (`needsScan`).
- Components: `monitor/DiskUsage.svelte` (df mounts, root input, depth, scan/cancel, breadcrumb, treemap with one nested level, sortable list with bars, hover tooltip, open in explorer = `app.navigateExplorer` + `app.sidebarView = "explorer"`, delete = `app.ask` + `remove(…, true)`), `monitor/CronEditor.svelte` (table, add/edit dialog with presets + five field boxes + live validation/description/next runs, toggle, duplicate, delete, "Run now" = `terminalStore.openNew(sessionId, {command})`, raw text mode, system crontabs, diff confirm before `cron_write`).
- Test ids: `monitor-tab-{overview,disk,cron}`, `du-*` (`du-root`, `du-scan`, `du-tile`, `du-row`, `du-crumb`, `du-denied`, ...), `cron-*` (`cron-row`, `cron-toggle`, `cron-add`, `cron-save`, `cron-confirm-ok`, ...).
- Tests: UI scenarios 34 (squarify + treemap/drill/delete/open) and 35 (cron logic assertions + add/toggle/save text/raw/run). Mock backend: `cron_read/cron_write/du_start/du_cancel`, harness `cronWrites()`, `cronText()`, `setCron()`, `duRequests()`, `termWrites()`.
- Known limits: next-run times use this PC's time zone, not the VM's; `du` output is disk usage of one filesystem (`-x`), so mounts under the scanned path are not included (scan them from the df chips); the busybox fallback only lists direct children.

### 13.4.D Diff

Compare a tab with the server copy in a Monaco diff editor (agent D).

- State: `app.compare[tabId]: CompareState { tabId, path, serverContent, serverMtime }` in `stores.svelte.ts`. `app.openCompare(tabId)` does a fresh `read_file` and opens the view (also clears a pending `app.conflict`). `app.closeCompare(tabId)`. `app.applyCompare(tabId, "mine" | "server" | "merged", merged?)`: `mine` force-writes the buffer (no `expectedMtime`), `server` adopts the server text and mtime, `merged` writes the right side with `expectedMtime = serverMtime`. A new `Conflict` during the write re-reads the server copy and reopens the diff.
- UI: `components/DiffView.svelte` replaces the editor area of that tab (`Editor.svelte` hides the normal editor while `app.compare[tab.id]` exists). Left = server (read-only), right = buffer (editable). Toolbar (`data-testid` `diff-save-merged`, `diff-keep-mine`, `diff-take-server`, `diff-cancel`, `diff-toggle-inline`), Prev/Next change (`goToDiff`), Ctrl+S = Save merged. The gutter revert arrows (`renderMarginRevertIcon`) pull a hunk from the server side. Cancel leaves `tab.doc` unchanged (right-side edits made in the diff are dropped). Monaco is the same lazy offline bundle (`loadMonaco`).
- Entry points: the conflict dialog "Compare" button, tab context menu "Compare with Saved on Server", palette command `editor.compareWithServer` (`lib/compare.svelte.ts`). Autosave conflicts never open the dialog: autosave is paused for the tab (`autoSavePaused`) and a toast offers "Compare". A later manual Ctrl+S still shows the dialog.
- Search reveal (§13.4.R): `Editor.svelte` consumes `searchReveal.pending` in an effect that runs after `syncModel()`. It only fires for the matching sessionId + path, not while loading or while a diff is shown. It sets the cursor, centers, focuses and clears `pending`.
- Tests: scenarios 39 (conflict, Compare, Save merged) and 40 (search reveal line). The mock gained per-path mtimes: `__harness.touchRemote(path, content)` simulates a remote edit (bumps mtime by 100); guarded `write_file` calls on touched paths then fail with `Conflict`. `__harness.writes()` entries now carry `expectedMtime`.

### 13.4.N Snippets

- Model: `Snippet` in `types.ts` (id, name?, cmd template, description?, folder?, tags, scope `host|all`, host?, created, lastUsed, useCount, lastValues?). State: `snippets` in `lib/history.svelte.ts` with `createSnippet/updateSnippet/deleteSnippet/duplicateSnippet/markSnippetUsed/searchSnippets/exportSnippets/importSnippets`.
- Persistence: the `history` store is now an envelope `{ version: 2, entries, snippets }`. The loader (`components/snippets/model.ts` `migrateHistoryStore`) also accepts the legacy bare `HistoryEntry[]`: every pinned entry becomes a host-scoped snippet; the entries are kept (still pinned, so ghost hints do not change). Migration runs only on the legacy shape, then the v2 envelope is saved.
- Template syntax (`components/snippets/template.ts`, pure): `{{name}}`, `{{name:default}}`, `{{name|a|b}}` (choice, first = default), built-ins `{{host}} {{user}} {{cwd}} {{clipboard}} {{date}}`, escape `\{{`. A name used twice is asked once. Invalid or unclosed `{{` stays literal text.
- Running: `components/snippets/runner.svelte.ts` (`startRun`, `execute`, `snippetUi` dialog state). Variables open `SnippetRunDialog` (live preview; Run in active terminal = `term_write(cmd + "\r")`, Run in new terminal = `terminalStore.openNew(..., {command})`, Insert = write without Enter, Copy). No user variables = runs at once. Last-used values are remembered per snippet.
- UI: `CommandHistory.svelte` shows a Snippets section (search, new/edit/duplicate/delete, run buttons) above Recent, and hosts the dialogs (`SnippetEditDialog`, `SnippetPicker`, `SnippetImportDialog`). Import is paste-JSON, export copies JSON to the clipboard.
- Palette: `snippets/palette.svelte.ts` registers "Snippets: Run Snippet…" and "Snippets: New Snippet…" (lazy-imported by `loadHistory`). They switch the sidebar to the Commands view, because the dialogs live in `CommandHistory.svelte`.
- Tests: scenarios 32 (variables form, preview, run, insert, picker) and 33 (legacy migration).

### 13.4.A Auto-reconnect

A network drop or laptop sleep keeps the workspace and reconnects with the stored request.

- **Detect**: `session://closed` that the user did not ask for (`app.closing` holds ids from disconnect/pause/release), or a failed probe. Backend: keepalive 20 s with `keepalive_max` 3 (dead link noticed in about 60-80 s) and the command `session_ping(sessionId)` (SFTP `realpath(".")`, 8 s timeout). `lib/reconnect.svelte.ts` ticks every 1 s; a wall-clock jump over 30 s, a window hidden over 30 s, or the browser `online` event probes every session (`probeSessions`). A failed probe is handled like a drop.
- **Engine** (`lib/reconnect.svelte.ts`, `reconnect.items[sessionId]`: status `connecting | waiting | prompting | failed`, attempt, nextAt, lastError): attempt 1 is immediate, then waits 1, 2, 5, 10, 30 s (cap 30 s); gives up 10 min after the drop and shows "Disconnected" with Retry. Pure logic in `lib/reconnectLogic.ts` (`backoffDelayMs`, `shouldGiveUp`, `isClockJump`, `classifyReconnectError`; tests in `tests/unit`, run `npm run test:unit`). `NeedPassword/NeedPassphrase/HostKeyUnknown` show the normal prompt once (never while another prompt or dialog is open: it waits for the slot); `HostKeyChanged`/`AuthFailed`/`Config` stop with a Retry. `AuthFailed` forgets the stored secret. Secrets stay in `app.connectRequests` (memory). ProxyJump works because the whole `ConnectRequest` (incl. `jumpAuth`) is reused. Tunnel-only sessions are tracked in `app.backgroundSessions` and reconnect too; `app.releaseBackground(id)` marks an intentional release.
- **Remap**: `app.remapSession(oldId, info, req)` rebinds `sessions`, `workspaces`, tab `sessionId`, MRU/closed stacks, `activeSessionId`, then runs hooks and refreshes the explorer (root + expanded dirs). Clean tabs are silently reloaded if the remote mtime changed; dirty tabs stay dirty (the save conflict check still applies). The old backend session is cleaned with `disconnect(oldId)` when the drop is detected.
- **Registry** (`stores.svelte.ts`): `app.onSessionDrop(cb(oldId))`, `app.onSessionRemap(cb(oldId, newId))`, `app.onSessionLost(cb(id))`. Registered by: forwards (hold running rules on drop, restart them on remap, mark `error` on lost), terminals (`terminalStore.rebindSession`: new PTY in the same tab and cwd, same xterm so scrollback stays, dim "reconnected" line; exits without a code are held 600 ms and kept while the session reconnects; `TerminalTab.key` is the stable render key, `api.lastTermSize` restores the PTY size), monitor (`remapSession`), logs (tab `sessionId` follows; restart a stream by hand).
- **UI**: `WorkspaceSwitcher` banner per dropped workspace (`data-testid="reconnect-banner"`, `data-status`, buttons `reconnect-retry` / `reconnect-cancel`; Cancel = disconnect, asks about unsaved tabs), pill dot pulses; `StatusBar` shows "Reconnecting (attempt N)" / "Disconnected" and an "Auto-reconnect: On/Off" toggle.
- **Setting**: `connection.autoReconnect` (default `true`). Off = old behaviour (workspace dropped, error toast).
- **Tests**: scenario 38; mock `window.__harness.dropSession(id)`, `session_ping`, and file commands on an unknown session id reject with `Connection`.

### 13.4.S Transfers

Whole-folder upload / download and direct VM-to-VM copy, as jobs. Backend `src-tauri/src/transfer.rs` (state `TransferManager`), frontend `lib/transfers.svelte.ts` + `components/transfers/TransfersHost.svelte` (mounted in `App.svelte`: bottom-right pill with a progress ring and count, a jobs popover, and the conflict dialog).

| Command | Args | Returns |
|---|---|---|
| `transfer_start` | `spec: TransferSpec` | `jobId` |
| `transfer_cancel` | `jobId` | `void` (idempotent; half-written files are removed) |
| `transfer_resolve` | `jobId, policy: "overwrite" \| "skip" \| "newer" \| "cancel"` | `void` (answers a conflict prompt) |

`TransferSpec { kind: "upload"|"download"|"copy", sessionId, dstSessionId?, items, dest, rename?, conflict?: "ask"|"overwrite"|"skip"|"newer" }`. Upload: `items` are local paths (files or folders), `dest` a remote dir of `sessionId`. Download: `items` remote paths of `sessionId`, `dest` a local dir. Copy: `items` remote paths of `sessionId`, `dest` a remote dir of `dstSessionId` (read on A, write on B, 256 KB buffer per worker, no temp file). `rename` renames a single root item. Each root lands as `dest/<basename>`.

Engine: scan (counts files and bytes, `scanning: true` progress) -> create directories -> 4 parallel file workers (russh-sftp already pipelines reads and writes within a file). Nested symlinks and special files are skipped and counted in `skipped`; the picked roots follow links. Names from a remote listing are checked before they become local paths (`..`, separators, Windows-invalid chars are skipped). The modification time is kept; the mode only remote -> remote. A failed or cancelled file is deleted at the destination, one failing file does not stop the job.

Conflicts: the first existing destination file sends `transfer://conflict {jobId, path}` once; the answer (`overwrite`, `skip`, `newer` = overwrite if source is newer, `cancel`) applies to the whole job. A spec with `conflict` other than `ask` never prompts.

Events: `transfer://progress {jobId, bytesDone, bytesTotal, filesDone, filesTotal, currentPath, rateBps, etaSecs|null, scanning}` (every 200 ms, `rateBps` smoothed) and `transfer://done {jobId, error?, cancelled?, failed, skipped, filesDone, bytesDone}`. `error` summarizes per-file failures ("3 files failed. First: ..."). `disconnect` cancels the session's jobs and also calls `LogManager::close_for_session`. Legacy `upload` / `download` commands run through the same engine (and show in the panel).

Frontend: `startUpload / startDownload / startCopy / retryJob / cancelJob / clearFinished`. Retry re-runs the spec with `skip`. Cut + paste across sessions = copy, then on a clean finish (no failures, nothing skipped) a confirm dialog offers to delete the originals. Context menu: "Download..." (a single file asks for a name, folders or several items ask for a folder), "Upload files here...", "Upload folder here...". Dropping folders from Windows Explorer uploads them too. Tests: Rust unit tests (policy, rate, ETA, path mapping, name safety); UI scenarios 41 and 42 (`__harness.transferSpecs()`, `setTransferStepMs`, `setDialogResult`). Not done: drag between workspaces, recreating symlinks, resuming partial files.

### 13.4.T2 Recording

Terminal session recording in asciinema v2 (`.cast`). Off by default.

- **Setting**: `settings.terminal.recording = { enabled: false, autoRecordNew: false, directory: string | null }` (`null` = `<app data dir>/recordings`). When `enabled` is off, no toggle is shown and nothing records. Turning it off stops every running recording (`terminalStore` effect). `autoRecordNew` starts a recording for each new terminal.
- **Backend** (`src-tauri/src/recording.rs`, hooks in `terminal.rs`): each terminal has a `RecSlot` (PTY size + optional `Recorder`). The PTY reader task writes `[elapsed, "o", data]` lines; `term_resize` writes `"r"` events (`"COLSxROWS"`). Input is never recorded. Buffered writer, flushed every 2 s by a task, and on stop, `term_close`, session disconnect and PTY exit. Header: version 2, width, height, timestamp, title (session label), env `TERM=xterm-256color`, `SHELL=/bin/sh` (the real remote shell is unknown). File name `<host>-<yyyyMMdd-HHmmss>.cast` in local time (the UI sends `tzOffsetMinutes`); a name clash gets `-N`.
- **Commands**: `rec_start(termId, dir?, tzOffsetMinutes?) -> path` (already recording: returns the running path), `rec_stop(termId)`, `rec_list(dir?) -> RecInfo[]` (`{path,name,host,startedAt,duration,size}`, newest first), `rec_delete(path)`, `rec_read(path) -> string` (64 MB cap, `TooLarge`), `rec_reveal(path)` (explorer / open / xdg-open), `rec_default_dir()`. Paths must end in `.cast`. Event `rec://stopped {termId, reason}` when a recording dies from a write error.
- **Frontend**: `TerminalTab.recording/recPath`; `terminalStore.setRecording/toggleRecording/stopAllRecordings/showRecordings`. Red-dot toggle per tab (`data-testid="terminal-rec-toggle"`, `data-recording`). Palette: "Terminal: Start Recording" / "Stop Recording" (only while enabled), "Terminal: Show Recordings". `components/recordings/`: `RecordingsDialog` (list: host, date, duration, size; Play, Show in folder, Delete), `RecordingPlayer` (xterm.js, play/pause, 0.5x-4x, idle gaps capped at 2 s, seek bar, clock), `cast.ts` (parser). `RecordingsDialog` is mounted in `App.svelte`. Settings: Terminal section, "Recording" group.
- **Tests**: Rust unit tests in `recording.rs` (header, escaping, timestamps, writer round trip); UI scenario 36 (mock `rec_*`, `window.__harness.recCalls()`).

**Pause mode (13.4.A addendum)**: settings `connection.pauseOnDrop` (default false) and `connection.resumeOnRestore` (default false). With `pauseOnDrop`, a drop keeps the workspace in status `paused` with no attempts; the banner has "Continue" (`retryNow`). With `resumeOnRestore`, the browser `online` event or the window becoming visible again calls `continuePaused()`. The StatusBar button (`auto-reconnect-toggle`) cycles: Auto-reconnect, Pause (by hand), Pause (auto-continue), Off. Scenario `38-reconnect-pause-mode`.

## 14. Phase 6 — Terminal window, htop, git, file icons

### 14.1 Done by the lead

- Paste bug: `Terminal.svelte` Ctrl+V now calls `e.preventDefault()` (the native paste
  event also fired, so text arrived twice) and uses `term.paste()` (bracketed paste).
- Git foundation:
  - `src-tauri/src/git.rs`: one command `git_run(sessionId, repo, args, stdin?) -> GitOutput {code, stdout, stderr, truncated}`.
    It runs `env GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 LC_ALL=C git --no-pager -c color.ui=never -c core.quotepath=off -C <repo> <args…>`, each arg single-quoted.
    stdout is capped at 32 MB. A non-zero exit is not an error; check `code`.
  - `api.gitRun(...)`.
  - `src/lib/git/git.svelte.ts`: `gitStore` with `repos`, `head`, `revision`, `selection`, `sessionId`, `repo` and `run(args, stdin?)`, which throws `GitError`.
  - `SidebarView` has a new `"scm"` entry ("Source Control", GitBranchIcon).
    While it is the current or last sidebar view, the main area shows `components/git/GitView.svelte`; the sidebar shows `components/git/ScmView.svelte`.
  - `settings.git` (type in `types.ts`, defaults in `settings.svelte.ts`): enabled, autoFetchMinutes, pruneOnFetch, confirmSync, smartCommit, confirmDiscard, pullRebase, graphMaxCommits, graphAllBranches, showRemoteBranches, diffSideBySide, ignoreWhitespace, defaultBranchName.

### 14.2 Rules

The §13.2 rules apply. Read them. Use the scenario numbers below. Do not run the full UI suite; run only your own scenarios (`npm run test:ui -- 5`).

### 14.3 Ownership

| Agent | Feature | Owns | Scenarios |
|---|---|---|---|
| W | Detachable terminal window, focused Ctrl+Tab switcher (blur backdrop, centered, own switcher in the detached window) | `TerminalPanel.svelte`, `Terminal.svelte`, `terminal.svelte.ts`, `TabSwitcher.svelte`, `tabswitch.svelte.ts`, `terminal.rs`, `main.ts`, new `src/terminal-window/**` (or similar), `tauri.conf.json`, `capabilities/**`. In `App.svelte`: keyboard handler and the TerminalPanel mount only | 50–51 |
| U | Responsive middle section, minimal loading animation | `App.svelte` layout (aside/main/resizer code), `Loader.svelte`, `Logo.svelte`, `app.css`, `components/logs/**`, `components/ports/**`, `components/search/**`, `components/transfers/**`, `WorkspaceSwitcher.svelte`, `StatusBar.svelte` | 52–53 |
| H | Dashboard "htop" section | `monitor.rs`, `components/monitor/**`, `lib/monitor.svelte.ts` | 54–55 |
| X | Explorer: "Set as Explorer Root", file Info dialog, VS Code-style file icons | `Explorer.svelte`, `TreeNode.svelte`, `ContextMenu.svelte`, `EditorTabs.svelte`, `Editor.svelte`, `sftp.rs`, `commands.rs`, new `lib/fileIcons.ts`, new `components/FileInfoDialog.svelte`, `package.json` (one dependency) | 56–57 |
| G1 | Source Control sidebar: changes, stage/unstage/discard, commit, sync, stash, branches/tags handler, Git settings section | `lib/git/git.svelte.ts`, `lib/git/status.ts` (+ other new `lib/git/*` except G2's), `components/git/ScmView.svelte` (+ new `components/git/scm/**`), `SettingsDialog.svelte` (Git section only) | 58–59 |
| G2 | Git main page: VS Code-like commit graph, commit details, commit diff, working-change diff, commit context menu | `components/git/GitView.svelte` (+ new `components/git/graph/**`), `lib/git/log.ts`, `lib/git/graph.ts`, `lib/git/diff.ts` | 60–61 |

### 14.4 Contracts

(Each agent adds its subsection here.)

### 14.4.U Responsive middle section, minimal loader

- **Container names.** The middle section (`data-testid="middle-section"`, the wrapper around WorkspaceSwitcher + editor/Dashboard/Logs/Git in `App.svelte`) is a CSS container named `main`: `@container/main`. Pages inside adapt to its width, not the window's. Use Tailwind v4 variants `@sm/main:` (24rem), `@md/main:` (28rem), `@lg/main:` (32rem), `@2xl/main:` (42rem) and so on. Example: `class="hidden @lg/main:inline"`. The sidebar `<aside>` is also a container, named `side` (`@xs/side:`...). The status bar is its own unnamed `@container`.
- **Rules for pages in the middle section.** Put `min-w-0 min-h-0` on every flex/grid child. Let toolbars `flex-wrap`, or hide labels and keep icon buttons. Tables and lists scroll inside their own box (`overflow-auto`), never the page. The middle section is `overflow-hidden`, so anything wider than it is clipped, not scrolled: don't rely on it.
- **Clamps (App.svelte).** The middle section keeps at least 280 px width and 120 px height. Sidebar width is clamped to `[180, min(520, window - 44 - 4 - 280 [- 164 if a right terminal is visible])]`. Right terminal width is clamped to `[160, main width - 4 - 280]`. Bottom terminal height is clamped to `[80, main height - 4 - 120]`. The stored sizes (`app.sidebarWidth`, `panelWidth`, `panelHeight`) are not changed by a window resize; the effective sizes (`sidebarPx`, `panelWPx`, `panelHPx`) are derived, so they re-clamp live and restore when the window grows. Drag handlers clamp to the same limits.
- **Loader.** `Loader.svelte` is a thin rotating SVG arc in `currentColor` (muted foreground), same props (`label`, `delay`, `size`), `role="status"`. With `prefers-reduced-motion: reduce` it pulses slowly instead of spinning. Use `motion-reduce:animate-none` on other `animate-pulse`/`animate-spin` elements. The Pac-Man classes are gone.
- **Views I made responsive.** Logs (view and sidebar), Ports (view and rule dialog), Search sidebar, Transfers popup, WorkspaceSwitcher, StatusBar (items drop out as the window narrows).
- **Tests.** Scenarios 52 (720x480, extreme sidebar and terminal drags, window resize; no overflow, middle section >= 280x120) and 53 (loader is an svg arc; reduced motion).
### 14.4.W Detachable terminal window, Ctrl+Tab switcher

**Idea.** The whole terminal panel (all tabs) can move into a second OS window (label `terminals`) and back. PTYs stay in Rust; terminal output is already broadcast (`term://data`), so any window can render a terminal. The window loads the same bundle with `?window=terminals`; `main.ts` mounts `src/terminal-window/TerminalWindow.svelte` instead of `App.svelte`.

**Backend** (`terminal.rs`, registered in `lib.rs`):
- Per-terminal scrollback ring (last 512 KB of output text). Every `term://data` event now also carries `seq` (chunk number, from 1). `term_snapshot(termId) -> {data, seq}` returns the ring (empty, `seq` 0, if the terminal is gone). A chunk with `seq <= snapshot.seq` is already inside `data`.
- `term_window_open(geometry?)` creates the window (or focuses it), `term_window_focus()`, `term_window_close()` (destroys it). Title "OverSSH — Terminals", min size 480x280.
- `on_window_event` (called first in the `lib.rs` handler): closing the terminal window is intercepted and turned into `termwin://close-requested` (the page docks, then main closes it; forced after 3 s); a destroyed terminal window emits `termwin://gone`; destroying `main` destroys the terminal window.
- Capability `capabilities/terminals.json` (`windows: ["terminals"]`: `core:default`, set-icon, image-new). The window is created from Rust, so JS needs no window-creation permission.

**Messages** (global Tauri events; each name is one-directional): main -> window `termwin://init` (tabs, activeId, mru, closedStack, ctx, settings), `ctx` (sessions, activeSessionId, per-session explorer cwd, reconnecting ids), `settings`, `remap {oldId,newId}`, `open {reqId,sessionId,opts}`, `reopen`, `activate {id}`, `close-requested`; window -> main `ready`, `tabs` (mirror of its tab state after every change), `dock` (final tab state), `opened {reqId,id|error}`, `record {host,raw}` (command history is owned by main). Code: `src/terminal-window/bridge.svelte.ts` (`initMain`, `initTerminalWindow`, `dockBack`).

**Flow.** Detach (header button `data-testid="terminal-detach"`, palette "Terminal: Detach Panel to Window"): main listens for `ready`, calls `term_window_open`, answers `ready` with `init`, then sets `terminalStore.detached = true`. While detached: `TerminalPanel` is not mounted in main, `terminalStore.tabs/activeId` are a read-only mirror of the window's, `app.showTerminal` is forced false (setting it to true, e.g. Ctrl+J, Ctrl+`, snippets, focuses the window instead), and `DetachedBar` (`terminal-detached-bar`, buttons `terminal-focus-window`, `terminal-dock-back`) is shown. `terminalStore.openNew/reopenClosed/setActive/focusActive/rebindSession` forward to the window via `DetachHooks` (`openNew` still resolves with the new termId). Sessions, settings and auto-reconnect remaps are pushed to the window; a session that disconnects ends its PTYs, so the window closes those tabs as usual. Dock (window header button `terminal-dock`, `dockBack()`, closing the window, palette "Terminal: Dock Panel", the bar button, or closing the last terminal): the window sends `dock`, main takes the tabs back and closes the window. Every `Terminal.svelte` mount replays `term_snapshot` (held live chunks are filtered by `seq`), so docking/detaching keeps scrollback. If the window dies, `gone` makes main re-dock from the last mirrored tab list. Window position/size is remembered in `localStorage["overssh.termwin.geometry"]` (polled every 1.5 s).

**Terminal window keys** (`TerminalWindow.svelte`): Ctrl+W, Ctrl+T (uses the active tab's session), Ctrl+Shift+T, Ctrl+Tab / Ctrl+Shift+Tab (its own switcher over terminals), Ctrl+` / Ctrl+J (focus the active terminal), browser-key blocking. Copy/paste live in `Terminal.svelte` (the Ctrl+V fix is kept). The main window's Ctrl+Tab cycles files only, because no xterm exists there.

**`terminalStore` additions**: `detached`, `remote` (window only), `hooks`, `recordHook`, `sessionList`, `currentSessionId`, `defaultSessionId()`, `sessionLabel()`, `hostKey()`, `cwdFor()`, `detach()`, `dock()`, `focusWindow()`, `applyTabState()`, `snapshotState()`. `api.ts`: `termSnapshot`, `termWindowOpen/Focus/Close`, `emitEvent`, `listenEvent`.

**Switcher** (`TabSwitcher.svelte`): full-window backdrop (`tab-switcher-backdrop`, `backdrop-filter: blur(6px)`, 30% black), popup centered both ways, title header (`tab-switcher-title`: "Files" / "Terminals"), file / terminal icons, larger rows. Existing test ids and behaviour (commit on Ctrl release, arrows, MRU / round robin) are unchanged; a click on the backdrop cancels.

**Known gaps**: the second window cannot run in the UI harness (scenario 51 simulates its messages); after an auto-reconnect the pre-reconnect scrollback is not replayed on a later detach (new PTY id); a TUI started before the replay window (e.g. htop) may replay without its alternate-screen switch; the window's local ghost-hint history does not see commands typed in it until re-dock; the settings store is saved by both windows (identical content).

**Tests**: Rust `terminal::tests::scrollback_*`; UI scenarios 50 (switcher backdrop/centering/title) and 51 (detach, hand-off payload, strip, forwarding, dock back; mock commands `term_snapshot`, `term_window_*`, `__harness.termWindowCalls()/termwinEvents()`).

### 14.4.X Explorer root, file Info, file icons

**Set as Explorer Root / going up** (`ContextMenu.svelte`, `Explorer.svelte`): the folder-row context menu has "Set as Explorer Root", which calls `app.navigateExplorer(sessionId, path)` (like `cd`; expanded/selection state is reset by `refreshExplorer`). Ways back: header buttons "Go to parent folder" (`explorer-go-up`, disabled at `/`) and "Go to home folder" (`explorer-go-home`, `SessionInfo.home`), Alt+Up while the tree has focus, "Go Up" in the context menu, the existing `..` row and the editable path box. The header is now two rows (nav buttons + path box, then the action buttons). Bug fix: the background (empty space) context menu never opened because its own `svelte:window oncontextmenu` closed it in the same event; `onBackgroundContextMenu` now calls `stopPropagation()`.

**Info dialog** (`FileInfoDialog.svelte`, `lib/fileinfo.ts`): context menu "Info" or Alt+Enter on the tree. One path shows name, full path (copy button), type (file / folder / symlink with `linkTarget` and target kind), MIME, language, size (human + bytes), line count, permissions (`-rwxr-xr-x (0755)`), owner / group (`name (id)`, or just the id when names are unknown), hard links, and modified / accessed / changed / created times. For folders the size is on demand ("Calculate size": size, file and folder counts). Several selected paths show a summary (counts, total size of files, "Calculate folder sizes").
- `file_info(sessionId, path) -> FileInfo` (camelCase: `path name kind linkTarget linkTargetKind size mode uid gid user group atime mtime ctime btime hardLinks mime lines`, all nullable except `path name kind size`). SFTP `lstat` + `readlink` give the base data (SFTP v3 has no names or ctime). One extra exec channel runs `sh -c` with `stat -c`, `file -b -L --mime-type` and (text files up to 20 MB) `wc -l`; any failure or missing tool leaves those fields `null` and never fails the call.
- `dir_size(sessionId, path) -> DirSize {bytes, files, dirs, partial}`: `du -sb` (else `du -sk`) plus `find -type f|d | wc -l` over exec, wrapped in `timeout 120` when available. `partial` is true when `du` exited non-zero (unreadable subfolders). The paths are passed as quoted positional args, never interpolated into the script.
- Mock backend implements both commands.

**File icons** (`lib/fileIcons.ts`, `components/FileTypeIcon.svelte`): library `material-icon-theme` (the only new dependency). `fileIcon(name, isDir, isOpen, light)` resolves like VS Code: exact file name, then extensions from longest to shortest (`a.test.ts` tries `test.ts`, then `ts`), then the default; folders use `folderNames` / `folderNamesExpanded`. Light themes (`THEMES[settings.theme].isDark === false`) use the manifest's `light` overrides first. `<FileTypeIcon name isDir isOpen class>` renders an `<img data-icon="<id>">` and falls back to Lucide until loaded. Used in `TreeNode.svelte` and `EditorTabs.svelte`; other lists can reuse the component.
- Bundling: the manifest (452 kB, 60 kB gzip) and, in production, the id-to-URL table (`fileIconUrls.prod.ts`, 126 kB) are separate lazy chunks, so the main bundle is unchanged. The 1248 SVGs (about 2.9 MB raw, 0.3 to 1 kB each) are emitted as files in `dist/assets` (`?no-inline`, never data URIs), loaded only when a row shows them, so CSP `img-src 'self' data:` holds and no network is needed. In dev, `fileIconUrls.dev.ts` points at `/node_modules/material-icon-theme/icons/<id>.svg` (importing every SVG as a module made 1250 dev-server requests). No setting; always on.

**Known gaps**: the Info dialog is not in the editor tab menu; folder size cannot be cancelled (the `du` keeps running on the VM until it finishes or times out); `file`/`stat -c` need GNU or BusyBox tools (BSD/macOS hosts show no owner names, ctime or MIME); SFTP-only servers without exec show SFTP fields only.

**Tests**: Rust `sftp::tests::parse_exec_info_*`, `parse_dir_size_*`; `tests/unit/fileinfo.test.ts` (mode strings, sizes, icon extension candidates); UI scenarios 56 (root / up / home / Alt+Up / Go Up) and 57 (Info for file, folder, multi-select; icons in tree and tab).

### 14.4.G1 Source Control sidebar

- **Store** `lib/git/git.svelte.ts` (`gitStore`). Keeps G2's names (`sessionId`, `repo`, `revision`, `selection`, `head`, `run()`). Added: `state` (`disabled|disconnected|detecting|nogit|norepo|ready`), `detect(path?)`, `initRepo()`, `refresh(full?)`, `groups`, `refs`, `remotes`, `stashes`, `merging`, `busy`, `lastError`, `message`/`amend`/`signOff`, `viewMode`, and actions (`stage`, `unstage`, `discard`, `commit(mode)`, `fetch`, `pull`, `push`, `sync`, `stash*`, `checkout`, `createBranch`, `mergeInto`, `rebaseOnto`, tags). Mutations run one at a time through a queue (git index.lock), then refresh and bump `revision`. `head` is updated by every refresh.
- **Nothing runs until `gitStore.activated`** (set when the scm view mounts, `showSourceControl()`, or a palette Git command). `gitStore.init()` (called by `registerGitCommands()` in App's onMount) starts: detection on session/explorer-cwd change (a typed repo folder is dropped when the explorer root changes), auto-fetch timer (`settings.git.autoFetchMinutes`), refresh on window focus. ScmView also polls status every 20 s while visible.
- **Detection**: `git -C <explorer cwd> rev-parse --show-toplevel`. Exit 127 = git missing (`nogit`); other failures = `norepo` (Initialize Repository: `init -b <defaultBranchName>`, or open a folder by path).
- **Pure code** (unit tested, `tests/unit/gitStatus.test.ts`): `lib/git/status.ts` (`parseStatus` for `status --porcelain=v2 --branch -z --untracked-files=all`, `groupStatus` into merge/staged/changes, `buildChangeTree`), `lib/git/branches.ts` (`parseRefs`, `parseStashes`, `friendlyGitError`). Badge letters: M A D R C T, `U` conflict, `?` untracked.
- **Commands used**: `add`, `restore [--staged]`, `rm --cached` (unborn branch), `clean -f`, `commit -F -` (message on stdin; `--amend`, `--signoff`, `--no-edit` for merge/amend with an empty box), `fetch [--prune] [--all|<remote>]`, `pull --rebase|--no-rebase --no-edit`, `push` / `push -u <remote> <branch>`, `stash push|apply|pop|drop`, `checkout [-b|--track|--detach]`, `branch -m|-d|-D|--set-upstream-to`, `merge --no-edit`, `rebase`, `tag`. Smart commit with nothing staged asks, then `add -A` + commit. Pull/push/sync confirm per `confirmSync`; discard per `confirmDiscard`. Errors: toast plus a dismissible banner in the view (`friendlyGitError` explains auth failures, since prompts are off).
- **UI** `components/git/ScmView.svelte` + `components/git/scm/*` (`SyncBar`, `CommitBox`, `ChangeSection`, `ChangeRow`, `BranchesPane`, `StashPane`, `BranchPicker`, `RepoSetup`, `Pane`). Clicking a change sets `gitStore.selection = {kind:"change", path, staged, untracked}`; double click / "Open File" switches to the explorer and opens the file. Branch name click opens the quick pick.
- **Palette/keys**: `lib/git/commands.ts` registers "Git: Commit, Pull, Push, Fetch, Sync, Checkout to…, Create Branch…, Stash, Stash (Include Untracked), Refresh, Show Source Control"; Ctrl+Shift+G (App.svelte keydown) shows the view.
- **Settings**: "Git" section in `SettingsDialog.svelte` with every `settings.git` field.
- **Tests**: fake git in `tests/ui/mockGit.ts` (`g1GitRun`, tried after G2's handler in `mockBackend.ts`'s `gitHandlers`); harness `g1GitCalls()`, `g1GitSnapshot()`, `g1GitMissing()`, `g1GitPatch()`. Scenarios `58-scm-detect-init-commit`, `59-scm-stage-branches-sync-stash`.
- **Known gaps**: no rebase-in-progress detection (Continue/Abort Rebase are always in the ⋯ menu); no stash-and-checkout prompt; untracked listing uses `-uall` (large untracked trees are slow); StatusBar branch picker not added (agent U).

### 14.4.G2 Git main page (graph, details, diff)

`components/git/GitView.svelte` is the main area while the `scm` view is active. It owns two loaders and picks one of four states: no session, no repo, graph (+ details pane), or diff page.

- **Log** (`lib/git/log.ts`): `git log -z --topo-order --format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%s%x1f%D --max-count=N` plus `--exclude=refs/stash --all` (`graphAllBranches`; without `showRemoteBranches`: `--branches --tags HEAD`), `HEAD`, or one ref from the branch filter. `parseLog`, `parseRefs` (`%D`: current branch, detached HEAD, remote, tag; `origin/HEAD` and `refs/stash` hidden; remotes are known from `for-each-ref`), `parseDetail`, `matchesQuery`, `formatRelative/Absolute`. `max` = `graphMaxCommits` times pages; "Load more" adds a page and reloads. A reload only swaps the list if the raw output changed.
- **Lanes** (`lib/git/graph.ts`, `layoutGraph`): pure. Each row has `col`, `color` and lines `{fromLane, fromY, toLane, toY, color}` (Y = 0 top, 0.5 dot, 1 bottom). A lane waits for the sha it expects; a second parent opens a new lane; a parent that already has a lane is joined by a curve. `withUncommitted` prepends the pseudo row `*uncommitted*` (parent = HEAD) when `git status --porcelain=v1 -z` is dirty. While searching, rows are filtered and drawn as dots only.
- **Rendering** (`components/git/graph/`): `CommitGraph` (virtualized, fixed 26 px rows, overscan 8, arrow/Home/End/Page keys, one `ContextMenu` for commit and ref badges), `GraphCell` (SVG per row), `RefBadge`, `CommitDetails`, `WorkingDetails` (uncommitted row), `ChangedFiles` (list/tree), `FileDiffView` + `DiffPane` (Monaco diff, read-only), `Splitter`, `graphData.svelte.ts`, `commitData.svelte.ts`, `actions.ts` (all mutations).
- **Selection**: row click sets `gitStore.selection = {kind:"commit", sha}`; the uncommitted row clears the selection and opens `WorkingDetails`. A file click sets `{kind:"commit", sha, path}`; working files set `{kind:"change", ...}`. Either with a path shows the diff page (file list at the left when the page is 760 px or wider, previous/next file, Back). The page reloads on `gitStore.revision`, `repo`, `sessionId` and the three `graph*`/`showRemoteBranches` settings.
- **Changed files** (`lib/git/diff.ts`): `git diff-tree -r -M -z --no-commit-id --name-status|--numstat <parent> <sha>` (`--root` for a root commit), merged into `FileChange` (status A/M/D/R/C/T/U, rename source, +/-, binary). Merge commits have a parent selector (default first parent).
- **Diff sources**: commit file = `<parent>:<oldPath>` vs `<sha>:<path>` through `git cat-file blob`; staged = `HEAD:path` vs `:path`; unstaged = `:path` vs the working file (SFTP `readFile` of `<repo>/<path>`); untracked = empty vs file. A path missing in a tree reads as empty (added/deleted); NUL bytes or numstat `-` show "Binary file not shown." Side-by-side and ignore-whitespace toggles write `settings.git.diffSideBySide` / `ignoreWhitespace`. "Open file" opens `<repo>/<path>` in the editor and switches the sidebar to Explorer.
- **Mutations** (`actions.ts`, all bump `gitStore.revision`, also on failure, and toast errors): `checkout --detach`, `branch <name> <sha>`, `tag <name> <sha>`, `cherry-pick [-m 1]`, `revert --no-edit [-m 1]`, `reset --soft|--mixed|--hard` (hard asks first), badge menu: `checkout` (remote: local branch or `--track`), `merge --no-edit`, `branch -d` (retry `-D` after confirm), `tag -d`.
- **Layout**: the details pane is below the graph (or at the side via the toolbar, only on pages 760 px or wider) and resizable. Author column hidden below 560 px, date below 440 px (the page measures its own width, so it works with or without a container query).
- **Tests**: `tests/unit/gitlog.test.ts`, `gitgraph.test.ts`, `gitdiff.test.ts`; UI scenarios 60 (graph, badges, uncommitted row, search, context menu, load more, virtualization) and 61 (details, diffs, merge parent, working changes). Fake git: `tests/ui/fakeGitG2.ts`, chained into `mockBackend.ts` through `gitHandlers`; it only answers while `__harness.gitFakeSet({active:true})` is set. `window.__gitStore` (from `harness.ts`) lets scenarios set `repos` and `selection`.
- **Not done**: compare with HEAD / working tree, graph for submodules, remote branch delete, long-range lane compaction for very wide graphs (lanes beyond 10 are clipped).

### 14.4.Z Theme picker and customization

- **New themes**: `nord`, `rose-pine`, `gruvbox-dark`, `kanagawa` (all dark). `lib/themes.ts` builds their Monaco themes with `darkMonaco(palette)`; each `ThemeDef` now has `accent` (its own `--primary`). The CSS token blocks are in `styles/themes.css`. `appIcon.ts` and `fileIcons.ts` need no per-theme entries (they read `THEMES[id]` / `isDark`).
- **`settings.appearance`** (merged over `DEFAULTS` like every other group): `accent` (`#rrggbb` or `null` = theme default), `density` (`compact` 0.92x / `normal` / `comfortable` 1.08x text and spacing scale), `radius` (`sharp` 0.125rem / `default` 0.625rem / `round` 1rem), `terminalAccent` (cursor and selection of xterm follow the accent).
- **Applying** (`lib/appearance.ts`, called from `applyTheme()` in `settings.svelte.ts`, which re-runs when `settings.theme` or `settings.appearance` change, also in the detached terminal window): inline custom properties on `<html>`: `--primary`, `--primary-foreground`, `--ring`, `--sidebar-primary(-foreground)`, `--sidebar-ring`, `--chart-1`, `--radius`, `--ui-scale` (`app.css` multiplies the 13px base size by it). The accent is first nudged to 3:1 contrast against the theme background (`ensureContrast`), and the foreground on it is picked by `readableOn` (`lib/color.ts`). `--accent` (hover background) is not touched. `::selection` uses the primary. The activity-bar marker, focus rings and buttons follow `--primary`. Monaco: `monacoThemeFor(id, accent)` overrides cursor, selection, bracket match and focus colours; `monaco.ts` `defineThemes()` + `refreshMonacoThemes()` (called from an `App.svelte` effect) redefine all themes on change. xterm: `terminalTheme()` in `settings.svelte.ts` (Terminal and RecordingPlayer). The window icon uses the accent (debounced).
- **Theme picker** (`components/ThemePicker.svelte`, state `lib/themepicker.svelte.ts`): shortcut **Ctrl+Alt+T**, palette command "Preferences: Color Theme" (the old theme sub-list in `CommandPalette.svelte` is gone), and "Browse themes" in Settings > Appearance. Same look as the Ctrl+Tab switcher (blurred backdrop, centered). Rows grouped Dark / Light, each with an 8-colour swatch strip (background, foreground, accent, red, green, yellow, blue, magenta). Type to filter; Up/Down/Tab/Home/End move and **live-preview** by setting `settings.theme`; Enter keeps; Esc or a backdrop click restores the theme that was active on open. While open, `App.svelte`'s global shortcut handler returns early. Test ids: `theme-picker`, `theme-picker-item` (`data-theme-id`), `theme-picker-input`.
- **Settings > Appearance**: theme cards with a mini preview, accent swatches (`accent-swatch`, theme default, custom colour input and hex box), UI density and corner radius toggle groups, terminal accent switch, and "Reset" (`appearance-reset`, resets only `settings.appearance`). Palette command "Preferences: Reset Theme Customization" does the same.
- **Tests**: `tests/unit/color.test.ts` (colour maths, theme completeness, accent reaches Monaco/xterm); UI scenario 63 (picker preview/revert/filter/commit, accent, radius, reset); scenarios 03 and 08 updated for the picker.
- **Not done**: "darker background" / custom terminal background, per-token Monaco colours, import/export of custom themes.
