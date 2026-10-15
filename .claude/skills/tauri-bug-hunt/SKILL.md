---
name: tauri-bug-hunt
description: Systematic bug hunt for this Tauri v2 + Svelte 5 + Rust (russh) app. Use when asked to find and fix bugs, audit an area, or harden the app. Gives the bug classes that recur in Tauri apps, how to search for each, how to prove a bug, and how to fix and report it.
---

# Tauri bug hunt (OverSSH)

Read `docs/GUIDE.md` first (architecture, §5 contract, §15 ownership, §16 platform rules, §17 VM load).
Hunt only in the files you own. If a fix needs a file you do not own, put it in your report.

## Method

1. **Map the area.** List the commands, events, timers, listeners and windows in your files.
2. **Sweep each bug class below** with the given searches. Read the code around each hit.
3. **Prove the bug** before you fix it, by one of these:
   - a failing unit test (`tests/unit/*.test.ts`, `npm run test:unit`),
   - a failing Rust test (`cargo test --manifest-path src-tauri/Cargo.toml <name>`),
   - a UI scenario (`tests/ui/scenarios/NN-*.ts`, `npm run test:ui -- NN`, mock in `tests/ui/mockBackend.ts`),
   - or an exact trace through the code: file:line, input, wrong result.
   Do not report style issues, guesses, or "could be cleaner".
4. **Fix the smallest correct way**, matching the surrounding code. Add or extend a test.
5. **Run the checks for what you touched:** `npm run check` (0 errors and 0 warnings), the unit tests,
   the scenarios in your area, and `cargo test` if you changed Rust. Under memory pressure, set
   `CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1`.
6. **Do not commit.** Report each bug in this form:
   `file:line | class | trigger -> wrong result | fix | test`.

## Bug classes

### A. IPC contract (frontend <-> Rust)
- The arguments to `invoke`/`call` are camelCase, and the Rust parameters are snake_case. Tauri maps one
  to the other, so a name that does not match arrives as a missing argument. Compare `src/lib/api.ts`
  with each `#[tauri::command]` signature.
- A command must be in `generate_handler!` in `lib.rs`. Search: `#\[tauri::command\]` against the handler list.
- `Option<T>` in Rust compared with `undefined` or `null` on the frontend. Check that serde
  `rename_all = "camelCase"` on structs matches the field names in `src/lib/types.ts`.
- Event names: `emit("x://y")` must match `listen("x://y")`. Payload fields are camelCase.
- Window capabilities: each `plugin:*` API that a window calls must be permitted in
  `src-tauri/capabilities/*.json` for that window label (`main` or `terminals`).

### B. Listener and timer leaks (Svelte 5)
- `listen()` / `api.on*()` returns a Promise of an unlisten function. It must be called on destroy, also
  when the component is destroyed before the Promise resolves.
- `setInterval`, `setTimeout`, `addEventListener`, `ResizeObserver` and `MutationObserver` must each
  have a cleanup in `onMount` or `$effect`.
- An `$effect` that writes state that it also reads causes a loop. Use `untrack`.
- Stale async results: a request that is answered after the session, tab or path changed must not
  overwrite newer state. Use request tokens or check the id.

### C. Async and concurrency (Rust)
- Do not hold a `std::sync::Mutex`, or a `RwLock` guard, across `.await`.
- Blocking calls (`std::fs`, `std::process::Command::output`, a long CPU loop) inside an `async fn`
  must use `spawn_blocking`.
- `unwrap()`/`expect()` on data from the network or a file: in release builds `panic = "abort"`, so a
  panic kills the whole app.
- Maps of streams or sessions that get entries but never lose them (a leak on error paths or on
  disconnect).
- A remote process that outlives its channel. Long streams must use `docker::stream_wrap`.
- A missing timeout on a network wait (auth, SFTP, exec).

### D. Windows and the platform
- Behaviour of a frameless window (`decorations:false`): drag regions, maximize state, close
  (Alt+F4 / Cmd+Q) with unsaved edits.
- The two windows (`main`, `terminals`) share state through events. Check what happens when one of
  them closes during a request.
- Hide-to-tray: anything that polls must stop while the window is hidden (§17).
- Windows-only Tauri limits: `setIcon` sets only the small icon (see `appicon.rs`), and a `blob:` URL
  is blocked by the CSP.
- Local paths use `std::path`. Remote paths are POSIX strings, never `std::path`.

### E. Input and data edge cases
- Remote file names with spaces, quotes, `'`, newlines, a leading `-`, or non-UTF-8 bytes.
- Shell quoting: every remote argument goes through `sh_quote`/`shell_quote`.
- Empty files, large files (> 10 MB), binary files, CRLF, and files without a final newline.
- A session that drops in the middle of an operation (the reconnect path).
- Settings or stores that are missing, corrupted or from an old version.

### F. Security (rules in CLAUDE.md)
- Never log passwords, passphrases or key material, also not in error strings sent to the UI.
- Never write to `~/.ssh/config`. Recording must never capture input.
- CSP: no `unsafe-eval`. HTML from the remote host must not go into `{@html}` without escaping.
