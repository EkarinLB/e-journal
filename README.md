# OpenJournal

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

## What works today

- Notebooks with pages, pressure-sensitive pen with three nib styles,
  translucent highlighter, eraser, image insert/move/delete
- Scribble-to-delete gesture, Chaikin stroke smoothing, ruled paper
- Home shelf, continuous page scroll (new pages on scroll-down), page dock
- Zoom, hideable UI, light/dark themes, undo/redo, color picker
- Local JSON library (no account, no cloud), `.openjournal` export/import
- Read-only `.ink` import, drag-and-drop for images/notebooks
- Data at `%APPDATA%\OpenJournal\openjournal-library.json` (legacy
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

The Rust backend stores the same `openjournal-library.json` format as the
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
