#!/bin/bash
# Build TokenFlow.app — TokenFlow's native macOS menu bar application.
#
#   scripts/build-menubar-app.sh [output-dir]
#
# Compiles menubar/TokenFlow/main.swift with swiftc (Xcode Command Line Tools)
# into a minimal .app bundle, embedding the absolute paths of this clone's
# node binary and CLI so the app can drive refresh/watch actions.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/menubar/TokenFlow/main.swift"
OUT_DIR="${1:-$REPO/dist}"
APP="$OUT_DIR/TokenFlow.app"
# App version: first argument, else package.json version. Embedded into the
# bundle's Info.plist so release CI can verify tag ↔ bundle consistency.
VERSION="${2:-$(node -p "require('$REPO/package.json').version")}"

command -v swiftc >/dev/null 2>&1 || {
  echo "error: swiftc not found — install Xcode Command Line Tools:" >&2
  echo "  xcode-select --install" >&2
  exit 1
}

NODE_BIN="$(command -v node)"
CLI_JS="$REPO/bin/tokenflow.js"
[ -f "$CLI_JS" ] || { echo "error: $CLI_JS missing" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$APP/Contents/MacOS"
mkdir -p "$APP/Contents/Resources"
cp "$REPO/menubar/TokenFlow/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>                 <string>TokenFlow</string>
    <key>CFBundleDisplayName</key>          <string>TokenFlow</string>
    <key>CFBundleIdentifier</key>           <string>app.tokenflow.bar</string>
    <key>CFBundleVersion</key>              <string>$VERSION</string>
    <key>CFBundleShortVersionString</key>   <string>$VERSION</string>
    <key>CFBundlePackageType</key>          <string>APPL</string>
    <key>CFBundleExecutable</key>           <string>TokenFlow</string>
    <key>CFBundleIconFile</key>             <string>AppIcon</string>
    <key>LSMinimumSystemVersion</key>       <string>13.0</string>
    <key>LSUIElement</key>                  <true/>
    <key>NSHighResolutionCapable</key>      <true/>
    <key>NSHumanReadableCopyright</key>     <string>MIT — local-first, nothing leaves your machine.</string>
    <key>TokenFlowNodePath</key>            <string>$NODE_BIN</string>
    <key>TokenFlowCLIPath</key>             <string>$CLI_JS</string>
</dict>
</plist>
PLIST

echo "compiling with $(swiftc --version | head -1)"
swiftc -O -swift-version 5 \
  -o "$APP/Contents/MacOS/TokenFlow" \
  "$SRC" 2>&1 | head -40

codesign --force --sign - "$APP" >/dev/null 2>&1 || true

SIZE=$(du -h "$APP" | cut -f1 | tr -d ' ')
echo "built: $APP ($SIZE)"
