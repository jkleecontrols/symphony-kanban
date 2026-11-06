#!/bin/zsh
# Builds Symphony.app from this checkout and installs it to /Applications
# (or ~/Applications if /Applications isn't writable).
#
#   desktop/build.sh              build + install
#   desktop/build.sh --no-install build into dist/ only
#   PORT=8790 desktop/build.sh    bake in a different port
set -euo pipefail

here=${0:A:h}
repo=${here:h}
port=${PORT:-8787}
out="$repo/dist/Symphony.app"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "• drawing the icon"
swift "$here/make-icon.swift" "$work/icon-1024.png" >/dev/null
iconset="$work/Symphony.iconset"
mkdir -p "$iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$work/icon-1024.png" --out "$iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$work/icon-1024.png" --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null
done

echo "• compiling"
rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
swiftc -O -target "$(uname -m)-apple-macos13.0" -o "$out/Contents/MacOS/Symphony" "$here/main.swift" -framework AppKit -framework WebKit
iconutil -c icns "$iconset" -o "$out/Contents/Resources/Symphony.icns"

cat > "$out/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Symphony</string>
  <key>CFBundleDisplayName</key><string>Symphony</string>
  <key>CFBundleIdentifier</key><string>local.symphony.kanban</string>
  <key>CFBundleExecutable</key><string>Symphony</string>
  <key>CFBundleIconFile</key><string>Symphony</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$(node -p "require('$repo/package.json').version")</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>SymphonyRepo</key><string>$repo</string>
  <key>SymphonyPort</key><string>$port</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$out" >/dev/null 2>&1
echo "• built $out"

if [[ "${1:-}" != "--no-install" ]]; then
  dest=/Applications
  [[ -w $dest ]] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
  rm -rf "$dest/Symphony.app"
  cp -R "$out" "$dest/"
  touch "$dest/Symphony.app" # nudge Finder/Dock to pick up the new icon
  echo "• installed $dest/Symphony.app"
fi
