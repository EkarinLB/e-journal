# E-Journal

Local-first ink notebook for Windows and Linux. A clean-room, original
implementation inspired by the *behavior* of pen-and-paper journal apps —
not a copy of any Microsoft software.

## Status: v0.11 — beta, not feature-complete

Local-first ink notebook for Windows and Linux. Clean-room original code.

### Known gaps (tracked deliberately)
- No backup/version history — one library file, overwritten on save
- No typed text, sticky notes, shapes, or ruled-page templates
- Search covers notebook titles only (no handwriting recognition)
- `.ink` import shows page snapshots; 3 of 25 sample files carry no
  snapshot and import blank (stroke-blob decoding still outstanding)
- No PDF/PNG export — ink is not yet portable out of the app
- Single flat shelf: no tags, favorites, or sorting

> **Legal boundary (not legal advice):** this repo contains only original
> code. Do not commit Microsoft binaries, decompiled output, app assets,
> icons, or trademarks here. We learn *facts* from the installed app
> (e.g. notebooks contain ordered pages; journal files are SQLite-based),
> then write our own code. Name, icons, and artwork are ours.

## Downloads

Latest: **[v0.11.0 (beta)](https://github.com/EkarinLB/e-journal/releases/tag/v0.11.0)**

| Platform | File | Size |
|---|---|---|
| Windows 64-bit | [`E-Journal_0.11.0_x64-setup.exe`](https://github.com/EkarinLB/e-journal/releases/download/v0.11.0/E-Journal_0.11.0_x64-setup.exe) | 2.5 MB |
| Windows (MSI/enterprise) | [`E-Journal_0.11.0_x64_en-US.msi`](https://github.com/EkarinLB/e-journal/releases/download/v0.11.0/E-Journal_0.11.0_x64_en-US.msi) | 3.5 MB |
| Debian/Ubuntu | [`E-Journal_0.11.0_amd64.deb`](https://github.com/EkarinLB/e-journal/releases/download/v0.11.0/E-Journal_0.11.0_amd64.deb) | 3.6 MB |
| Linux portable | [`E-Journal_0.11.0_amd64.AppImage`](https://github.com/EkarinLB/e-journal/releases/download/v0.11.0/E-Journal_0.11.0_amd64.AppImage) | 78 MB |

SHA-256 sums for every artifact are in
[`checksums.txt`](https://github.com/EkarinLB/e-journal/releases/download/v0.11.0/checksums.txt).
All packages are produced by CI from the tagged source.

## Requirements

### Windows

| Requirement | Detail |
|---|---|
| Operating system | Windows 10 version 1809 (April 2018 update) or newer, or Windows 11 |
| Architecture | 64-bit (x86-64) |
| Extra runtimes | **None** — see below |
| Disk space | ~30 MB installed |
| Internet | Only at install time, and only if the WebView2 runtime is missing |

There are two installers; both are equivalent and either is fine:

- `E-Journal_<version>_x64-setup.exe` — standard installer (NSIS), installs for
  the current user without administrator rights
- `E-Journal_<version>_x64_en-US.msi` — MSI for managed/enterprise deployment

**Do I need to install anything first?** On a current Windows 10 or 11 machine,
no. The app's UI is rendered by the *Microsoft Edge WebView2 Runtime*, which
ships as part of Windows 10 (1809+) and Windows 11. The installer checks for it
and, if it is genuinely missing (older or heavily modified systems), downloads
and runs Microsoft's official bootstrapper for you — that is the only step that
needs a network connection.

You do **not** need the Microsoft Visual C++ Redistributable. The binary is
statically linked against the Visual C++ runtime and only uses the Universal
CRT (`api-ms-win-crt-*`), which is built into Windows itself.

Windows 7 and 8.1 are not supported: WebView2 does not run reliably there and
Tauri v2 does not target them.

### Linux

The Flatpak is the simplest option and pulls in every dependency for you:

```sh
flatpak install flathub com.ejournal.app    # after the app is published
```

For the `.deb`, install it like any other Debian/Ubuntu package
(`sudo apt install ./E-Journal_<version>_amd64.deb`); the required WebKitGTK
libraries are pulled in automatically as package dependencies.

For the AppImage, most distributions need FUSE2 enabled first, which is the
usual cause of "AppImages require FUSE" errors:

```sh
sudo apt install libfuse2      # Debian/Ubuntu
```

### macOS

Not provided. There is no macOS build.

## Installing

**Windows:** download the `.exe` installer and run it. It installs for the
current user into `%LOCALAPPDATA%\E-Journal` and adds an entry to
Settings → Apps so you can uninstall normally.

Your notes are stored in a single readable file:

```
%APPDATA%\E-Journal\e-journal-library.json
```

Because it is plain JSON (not a proprietary database), your notebooks can be
backed up by copying that one file. Earlier locations from previous versions are
migrated automatically on first launch.

## What works today

- Notebooks with pages, pressure-sensitive pen with three nib styles,
  translucent highlighter, eraser, image insert/move/delete
- Scribble-to-delete gesture, Chaikin stroke smoothing, ruled paper
- Home shelf, continuous page scroll (new pages on scroll-down), page dock
- Zoom, hideable UI, light/dark themes, undo/redo, color picker
- Local JSON library (no account, no cloud), `.E-Journal` export/import
- Read-only `.ink` import, drag-and-drop for images/notebooks
- Data at `%APPDATA%\E-Journal\E-Journal-library.json` (legacy
  locations are auto-migrated on first run)

## Run (Electron dev shell)

```sh
npm install
npm test    # model + store + gesture round-trip checks (no GUI needed)
npm start   # launch the app
```

## Native build (Tauri v2, Rust backend)

Prerequisites on Windows: Rust stable + Visual Studio Build Tools with the
"Desktop development with C++" workload (for the MSVC linker) + WebView2
(preinstalled on Windows 10/11). Open a *Developer* shell (or run from an
environment with the MSVC `link.exe` first on `PATH`; note a Git-for-Windows
`link.exe` shim must not shadow it):

```sh
npm run tauri dev    # debug build + hot window
npm run tauri build  # release installer under src-tauri/target/release/bundle
cargo test --manifest-path src-tauri/Cargo.toml  # Rust backend unit tests
```

The Rust backend stores the same `E-Journal-library.json` format as the
Electron shell, so notes carry over. Linux packages (AppImage/deb) are built
from CI (see `.github/workflows`, planned) since they cannot be produced
from a Windows host.

## What we learned from recon (facts only)

- Installed app package: `Microsoft.MicrosoftJournal_*` under
  `C:\Program Files\WindowsApps`, entry `Journal.exe` /
  `Constellation.App` (WinRT activation — Windows-only, not portable).
- Core `Journal.dll` (~77 MB) is a **native** x64 PE: no .NET CIL, so a
  recompile/port of Microsoft's binary is not possible — hence this
  clean-room rewrite.
- User data: `.ink` files are **SQLite** databases with `pages`,
  `blobs` (stroke payloads), `markup`, `metadata` (icon/color) tables,
  plus a `LocalCache/index.db` notebook/page index. This makes a
  future **read-only `.ink` importer** feasible without touching
  Microsoft code.

## Roadmap

1. Read-only `.ink` importer (SQLite schema mapping + stroke-blob decode)
2. PDF background pages, image insertion
3. Handwriting search index (local)
4. Linux packaging (AppImage/deb) + Windows installer
