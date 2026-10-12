# OverSSH

A desktop app to browse, edit and work on remote machines over plain SSH and SFTP. Nothing is installed on the server.

Built with Tauri v2, Svelte 5 and Rust (russh).

## Features

- File explorer over SFTP: create, rename, move, copy, delete, upload and download. Split view with two panes.
- Code editor (Monaco) for remote files, with sudo save.
- Terminals: tabs, split panes, a detached terminal window and session recording.
- Hosts read from `~/.ssh/config` (read-only). Password, key and agent authentication, ProxyJump.
- Git: status, staging, commit, history graph and diffs.
- Docker: containers, images, logs, exec, compose files and container file browsing.
- Monitoring: CPU, memory, processes (htop-style), disk usage and systemd services.
- Log viewer for files, journald units and Docker containers.
- Port forwarding, cron editor, snippets and search in files.
- Themes, workspace profiles and settings export/import.

## Download

Get the installer for your platform from [Releases](https://github.com/Subham-chaudhary/overssh/releases):

| Platform | File |
| --- | --- |
| Windows | `OverSSH_<version>_x64-setup.exe` or `.msi` |
| macOS (Apple Silicon) | `OverSSH_<version>_aarch64.dmg` |
| macOS (Intel) | `OverSSH_<version>_x64.dmg` |
| Linux | `.AppImage`, `.deb` or `.rpm` |

The macOS build is not notarized. After you copy it to Applications, run:

```
xattr -cr /Applications/OverSSH.app
```

## Build from source

Requirements: Node.js 22, Rust (stable), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```
npm install
npm run tauri dev      # run in development
npm run tauri build    # build an installer
```

Checks:

```
npm run check
npm run test:unit
cargo test --manifest-path src-tauri/Cargo.toml
```

## Releases

Pushing a tag `vX.Y.Z` builds installers for Windows, macOS and Linux and attaches them to a draft GitHub release. See `.github/workflows/release.yml`.

```
node scripts/set-version.mjs 1.2.14
git commit -am "chore: release 1.2.14"
git tag v1.2.14
git push origin main v1.2.14
```

## Documentation

`docs/GUIDE.md` covers the architecture, the frontend/backend contract and the platform rules.
