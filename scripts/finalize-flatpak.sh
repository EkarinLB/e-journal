#!/usr/bin/env bash
# Rewrite packaging IDs from com.openjournal.app to the GitHub reverse-DNS
# form Flathub expects: com.github.<owner>.openjournal
#
# Run:  bash scripts/finalize-flatpak.sh <github-owner>
set -euo pipefail

OWNER="${1:?usage: finalize-flatpak.sh <github-owner>}"
NEW_ID="com.github.${OWNER}.openjournal"
OLD_ID="com.openjournal.app"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FILES=(
  flatpak/com.openjournal.app.yml
  data/metainfo/com.openjournal.app.metainfo.xml
  data/com.openjournal.app.desktop
)

echo "Rewriting ${OLD_ID} -> ${NEW_ID} in ${#FILES[@]} files"
for f in "${FILES[@]}"; do
  # skip the application-id meta key, which stays as-is
  sed -i.bak "s/${OLD_ID}/${NEW_ID}/g" "$f" && rm -f "$f.bak"
done

mv flatpak/com.openjournal.app.yml "flatpak/${NEW_ID}.yml"
mv data/metainfo/com.openjournal.app.metainfo.xml "data/metainfo/${NEW_ID}.metainfo.xml"
mv data/com.openjournal.app.desktop "data/${NEW_ID}.desktop"
git mv data/icons/128x128/com.openjournal.app.png "data/icons/128x128/${NEW_ID}.png" 2>/dev/null || \
  mv data/icons/128x128/com.openjournal.app.png "data/icons/128x128/${NEW_ID}.png"
git mv data/icons/256x256/com.openjournal.app.png "data/icons/256x256/${NEW_ID}.png" 2>/dev/null || \
  mv data/icons/256x256/com.openjournal.app.png "data/icons/256x256/${NEW_ID}.png"

# URLs in metainfo
sed -i.bak "s#https://github.com/OWNER/openjournal#https://github.com/${OWNER}/openjournal#g" \
  "data/metainfo/${NEW_ID}.metainfo.xml" && rm -f "data/metainfo/${NEW_ID}.metainfo.xml.bak"

# Tauri bundle identifiers (rebuild required after this)
sed -i.bak "s/com.openjournal.app/${NEW_ID}/g" src-tauri/tauri.conf.json && rm -f src-tauri/tauri.conf.json.bak

echo "Done. App ID is now ${NEW_ID}"
echo "Next: rebuild so the bundled Linux desktop/icon files carry the new ID:"
echo "  bash scripts/build-linux.sh"
echo "And set the Windows installer identifier if desired:"
echo "  (src-tauri/tauri.conf.json identifier was updated)"