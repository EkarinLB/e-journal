# OpenJournal

Local-first ink notebook for Windows and Linux. A clean-room, original
implementation inspired by the *behavior* of pen-and-paper journal apps —
not a copy of any Microsoft software.

> **Legal boundary (not legal advice):** this repo contains only original
> code. Do not commit Microsoft binaries, decompiled output, app assets,
> icons, or trademarks here. We learn *facts* from the installed app
> (e.g. notebooks contain ordered pages; journal files are SQLite-based),
> then write our own code. Name, icons, and artwork are ours.

## Status: v0.1 MVP

- Notebooks with pages, pressure-sensitive pen, highlighter, eraser
- Colors, stroke width, undo, page add/delete, title search
- Local JSON library (no account, no cloud), `.openjournal` export/import
- Runs on Windows and Linux via Electron

## Run

```sh
npm install
npm test    # model + store round-trip checks (no GUI needed)
npm start   # launch the app
```

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
