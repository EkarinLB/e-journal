E-Journal 0.12.0 — beta

Windows (setup.exe, msi) and Linux (deb, AppImage) builds are attached.
SHA-256 sums are in checksums.txt.


Fixed
- Deleting a notebook, page or clearing a page is now written to disk
  immediately, so it survives closing the app. Previously a pending write
  could be discarded and the deleted item came back.
- The eraser now works continuously while dragging. It only fired on
  pointer-down, so one swipe removed a single stroke.
- Pen styles are actually different. Ballpoint, fountain and brush differed
  by less than a fifth of a pixel at the default width, so switching style
  appeared to do nothing.
- A zero-length library file no longer prevents the app from starting. An
  interrupted write previously left a file that could not be parsed.
- Upgrading no longer resurrects notebooks you deliberately deleted. Legacy
  migration only runs when the current library is genuinely absent or
  unusable, and an unreadable library is recovered from its .bak first.
- Notebook names can be edited by clicking the title on the home shelf or in
  the editor.


Added
- Export the current page as PNG, or the whole notebook as PDF.
- A single Import button. .E-Journal libraries and Microsoft Journal .ink
  files are routed by file type instead of needing separate buttons.
- A rolling .bak copy of the previous library is kept beside it, and a save
  that would replace real notebooks with an empty library is refused.


Performance
- Ink is cached in an offscreen layer. Repaints previously re-smoothed and
  re-stroked every stroke on every pointer event, so the app got slower the
  more you wrote. Cost is now flat as a page fills.
- Repaints are batched to one per animation frame.
- Stroke saves are debounced. Writing the whole library after every stroke
  made saving cost grow with the size of the notebook.


Notes
- Windows binaries are unsigned, so SmartScreen may warn on first run.
  Choose More info -> Run anyway, or check the published SHA-256.
- Flatpak packaging is paused while the app is rebuilt natively in Rust.
  The AppImage and .deb are unaffected.
- The Rust rewrite is underway in native/: ink geometry, storage, a page
  cache whose memory stays flat regardless of notebook length, and pen input
  for Windows (WM_POINTER) and Linux (libinput). It is not yet the shipped
  app.