#!/bin/bash
# Build TokenFlow.app — TokenFlow's native macOS menu bar application.
#
#   scripts/build-menubar-app.sh [output-dir]
#
# Compiles menubar/TokenFlow/main.swift with swiftc (Xcode Command Line Tools)
# into a minimal .app bundle.
#
# The CLI is ALWAYS bundled into Contents/Resources/cli, packed with `npm pack`
# so the copy inside the app is byte-for-byte the published package rather than
# a hand-picked subset of the working tree. The app drives that copy, which is
# the only one guaranteed to match the binary it ships beside: the app and the
# CLI share a contract (the status file, the watcher lock format, /api/ping),
# and an unrelated CLI version next door is a mismatch nobody can reason about.
#
# Two build flavours:
#
#   local (default)      also embeds this clone's absolute node + CLI paths, so
#                        a developer's installed app drives the checkout they
#                        are editing.
#   TOKENFLOW_PORTABLE=1 embeds NO absolute paths. Anything built for
#                        distribution must use this: a release built on CI
#                        otherwise ships /Users/runner/... in its Info.plist,
#                        which exists on no user's machine.
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
PORTABLE="${TOKENFLOW_PORTABLE:-0}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
mkdir -p "$APP/Contents/Resources"
cp "$REPO/menubar/TokenFlow/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

# ---- bundle the CLI ---------------------------------------------------------
# `npm pack` rather than copying bin/ and src/: the tarball is what npm
# publishes, filtered by package.json "files", so the app can never ship a file
# the package does not.
echo "packing the CLI into the bundle"
( cd "$REPO" && npm pack --silent --pack-destination "$TMP" >/dev/null )
TGZ="$(ls "$TMP"/*.tgz | head -1)"
[ -f "$TGZ" ] || { echo "error: npm pack produced no tarball" >&2; exit 1; }
mkdir -p "$APP/Contents/Resources/cli"
tar -xzf "$TGZ" -C "$APP/Contents/Resources/cli"
BUNDLED_CLI="$APP/Contents/Resources/cli/package/bin/tokenflow.js"
[ -f "$BUNDLED_CLI" ] || { echo "error: bundled CLI missing at $BUNDLED_CLI" >&2; exit 1; }

# Keep only what the CLI actually executes. docs/, skills/, examples/ and
# scripts/ are never read at runtime — they appear in printed hints and nothing
# opens them — and they are four fifths of the tarball. Whatever remains still
# came from `npm pack`, so the bundle is a subset of the published package and
# never a file npm does not ship.
( cd "$APP/Contents/Resources/cli/package" \
  && rm -rf docs skills examples scripts \
     README.md CONTRIBUTING.md SECURITY.md CHANGELOG.md "Refresh & Open Dashboard.command" )
[ -f "$BUNDLED_CLI" ] || { echo "error: pruning removed the CLI" >&2; exit 1; }
[ -d "$APP/Contents/Resources/cli/package/src" ] || { echo "error: pruning removed src/" >&2; exit 1; }

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
</dict>
</plist>
PLIST

# A distributable build embeds no machine-specific path. A local one does, so
# the developer's installed app drives the clone they are working in.
if [ "$PORTABLE" != "1" ]; then
  /usr/libexec/PlistBuddy \
    -c "Add :TokenFlowNodePath string $NODE_BIN" \
    -c "Add :TokenFlowCLIPath string $CLI_JS" \
    "$APP/Contents/Info.plist" >/dev/null
fi

echo "compiling with $(swiftc --version | head -1)"
swiftc -O -swift-version 5 \
  -o "$APP/Contents/MacOS/TokenFlow" \
  "$SRC" 2>&1 | head -40

codesign --force --sign - "$APP" >/dev/null 2>&1 || true

SIZE=$(du -sh "$APP" | cut -f1 | tr -d ' ')
echo "built: $APP ($SIZE)$([ "$PORTABLE" = "1" ] && echo ' · portable, no embedded paths')"
