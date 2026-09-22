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
| Frontend | **Svelte 5** (runes) + **TypeScript** + **Vite**. No UI kit, no Tailwind — plain CSS with custom properties. |
| Editor | **CodeMirror 6** (`codemirror`, `@codemirror/lang-*`, `@codemirror/legacy-modes` for shell/yaml-ish/toml/nginx/dockerfile etc.), `@codemirror/theme-one-dark` |
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

**Out of scope for now:** port forwarding, ProxyJump (parse it, show "unsupported"),
git UI, extensions.

## 4. Repo layout

```
overssh/
├─ docs/GUIDE.md              ← this file
├─ CLAUDE.md                  ← short agent entrypoint (commands + pointer here)
├─ package.json, vite.config.ts, svelte.config.js, tsconfig.json, index.html
├─ src/                       ← frontend
│  ├─ main.ts, App.svelte, app.css
│  ├─ lib/
│  │  ├─ api.ts               ← ONLY place that calls invoke()/listen(); typed wrappers of §5
│  │  ├─ types.ts             ← TS mirrors of §5 types
│  │  ├─ stores.svelte.ts     ← app state (runes): sessions, open tabs, active tab
│  │  ├─ languages.ts         ← filename → CodeMirror LanguageSupport loader
│  │  └─ paths.ts             ← posix path helpers (join, dirname, basename)
│  └─ components/
│     ├─ HostList.svelte, QuickConnect.svelte, PromptDialog.svelte
│     ├─ Explorer.svelte, TreeNode.svelte, ContextMenu.svelte
│     ├─ EditorTabs.svelte, Editor.svelte
│     ├─ Terminal.svelte, TerminalPanel.svelte
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

export interface AppError { kind: ErrorKind; message: string; fingerprint?: string; keyPath?: string; }
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
| `rename` | `sessionId, from, to` | `void` | |
| `remove` | `sessionId, path, recursive: bool` | `void` | Recursive delete walks the tree over SFTP. |
| `download` | `sessionId, remotePath, localPath` | `void` | Files only (MVP). |
| `upload` | `sessionId, localPath, remoteDir` | `string` (remote path) | Files only (MVP). |
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
