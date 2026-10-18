#!/usr/bin/env bash
# Build Linux binaries (.deb + AppImage) from inside WSL/Ubuntu.
# Run:  wsl -d Ubuntu -- bash "/mnt/c/Users/Adam/Documents/Default Project/E-Journal/scripts/build-linux.sh"
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
source "$HOME/.cargo/env" 2>/dev/null || true

echo "==> Installing npm dependencies"
npm install

echo "==> Running tests"
npm test
cargo test --manifest-path src-tauri/Cargo.toml

echo "==> Building Linux bundles (.deb + AppImage)"
npx tauri build --bundles deb,appimage

echo
echo "Artifacts:"
find src-tauri/target/release/bundle -maxdepth 2 \
  \( -name '*.deb' -o -name '*.AppImage' -o -name '*.rpm' \) \
  -exec ls -lh {} \; 2>/dev/null || true