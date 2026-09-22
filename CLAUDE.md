# OverSSH

Tauri v2 + Svelte 5 desktop app to browse/edit/terminal into VMs over plain SSH/SFTP.

**Read `docs/GUIDE.md` before any change.** It holds the architecture, the
frontend⇄backend contract (§5), and task cards (§10).

- Cargo is at `%USERPROFILE%\.cargo\bin`; in PowerShell run `$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"` if `cargo` is missing.
- Checks: `npm run check`, `cargo check --manifest-path src-tauri/Cargo.toml`, `cargo test --manifest-path src-tauri/Cargo.toml`
- Release exe: `npm run tauri build`
- Remote paths are POSIX strings — never `std::path` for them.
- Never log passwords, passphrases, or key material.
