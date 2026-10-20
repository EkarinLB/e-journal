First release of the native Rust app with no webview dependency.

Built with winit 0.30 + tiny-skia + softbuffer + ab_glyph.

Includes:
- Native Windows .exe (1.18 MB, no WebView2 dependency)
- Native Linux executable (3.27 MB)
- Home shelf, editor canvas, pressure-sensitive ink
- Pen pressure sensitivity toggle + sensitivity slider
- Undo/redo, atomic saves with .bak backup
- Settings panel (theme, pressure, library location)

The Tauri build (v0.12.1) remains available with .msi, .deb, AppImage bundles.

SHA-256 checksums in native_checksums.txt