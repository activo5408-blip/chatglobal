#!/usr/bin/env bash
# Compila e instala Hermes Messenger en LMDE 7 / Debian 13
set -euo pipefail
cd "$(dirname "$0")"

sudo apt update
sudo apt install -y build-essential curl wget file pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev xdg-utils mpv

if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  . "$HOME/.cargo/env"
fi
rustup update stable 2>/dev/null || true

cargo install tauri-cli --version "^2" --locked
cd src-tauri
cargo tauri build --bundles deb

DEB=$(ls -t target/release/bundle/deb/*.deb | head -1)
echo "Paquete generado: $DEB"
sudo apt install -y "./$DEB"
echo "Listo. Busca 'Hermes Messenger' en el menú o ejecuta: chatlan"
