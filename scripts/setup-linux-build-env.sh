#!/usr/bin/env bash
# One-time Linux build environment for OpenJournal inside WSL2/Ubuntu.
# Run:  wsl -d Ubuntu -- bash "/mnt/c/Users/Adam/Documents/Default Project/openjournal/scripts/setup-linux-build-env.sh"
set -euo pipefail

echo "==> Installing Tauri v2 system dependencies"
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential curl wget file pkg-config \
  libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev patchelf desktop-file-utils xdg-utils fuse3

echo "==> Installing Node.js 22 LTS"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "==> Installing Rust (stable)"
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  source "$HOME/.cargo/env"
fi
cargo --version
rustc --version

echo "==> Verifying webkit2gtk is visible to pkg-config"
pkg-config --modversion webkit2gtk-4.1

echo
echo "Linux build environment ready."
echo "Next: bash scripts/build-linux.sh"