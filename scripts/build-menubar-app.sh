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
#
# The binary is universal (arm64 + x86_64) and targets TOKENFLOW_MACOS_FLOOR,
# default 13.0. Raise the floor only when a compiler diagnostic forces it, and
# move Casks/tokenflow.rb's `depends_on macos:` in the same commit — the cask is
# the one place that repeats the number instead of reading it.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/menubar/TokenFlow/main.swift"
OUT_DIR="${1:-$REPO/dist}"
APP="$OUT_DIR/TokenFlow.app"
# App version: first argument, else package.json version. Embedded into the
# bundle's Info.plist so release CI can verify tag ↔ bundle consistency.
VERSION="${2:-$(node -p "require('$REPO/package.json').version")}"
# The oldest macOS the binary will run on. swiftc defaults this to the version
# of the machine doing the build, which is how 1.3.x and 1.4.0 shipped binaries
# refusing to launch below macOS 26 while their own Info.plist advertised 13.0.
# Declared once here and written into LSMinimumSystemVersion below, so the
# advertised floor and the compiled floor cannot drift apart again.
MACOS_FLOOR="${TOKENFLOW_MACOS_FLOOR:-13.0}"

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
    <key>LSMinimumSystemVersion</key>       <string>$MACOS_FLOOR</string>
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
echo "targeting macOS $MACOS_FLOOR, arm64 + x86_64"
# DesignTokens.swift is generated from design/tokens.yaml (`npm run design`);
# the app is compiled from both files so it cannot drift from the dashboard.
#
# Once per architecture, then lipo'd together. An Apple Silicon runner builds an
# arm64-only binary by default, which will not launch on any Intel Mac — and
# Ventura, the floor this app advertises, runs on plenty of them.
#
# No `| head -40` on these: a pipe discards swiftc's exit status, so a failed
# compile used to leave an empty Contents/MacOS and let the script report
# success. The whole point of the checks below is that a broken build stops here
# rather than in someone's Applications folder.
SLICES=()
for ARCH in arm64 x86_64; do
  echo "  · $ARCH"
  swiftc -O -swift-version 5 -target "$ARCH-apple-macos$MACOS_FLOOR" \
    -o "$TMP/TokenFlow-$ARCH" \
    "$SRC" "$REPO/menubar/TokenFlow/DesignTokens.swift"
  SLICES+=("$TMP/TokenFlow-$ARCH")
done
lipo -create -output "$APP/Contents/MacOS/TokenFlow" "${SLICES[@]}"

# Prove the binary is what the Info.plist claims, on the machine that built it.
# Everything above is a compiler flag, and a flag that silently stops working
# is exactly how the macOS 26 floor shipped three times without anyone noticing.
BUILT_MINOS="$(otool -l "$APP/Contents/MacOS/TokenFlow" \
  | awk '/LC_BUILD_VERSION/{f=1} f&&/^ *minos/{print $2; exit}')"
if [ "$BUILT_MINOS" != "$MACOS_FLOOR" ]; then
  echo "error: binary minos is $BUILT_MINOS, Info.plist advertises $MACOS_FLOOR" >&2
  exit 1
fi
BUILT_ARCHS="$(lipo -archs "$APP/Contents/MacOS/TokenFlow")"
for ARCH in arm64 x86_64; do
  case " $BUILT_ARCHS " in
    *" $ARCH "*) ;;
    *) echo "error: $ARCH missing from the binary ($BUILT_ARCHS)" >&2; exit 1 ;;
  esac
done
echo "binary: $BUILT_ARCHS · minos $BUILT_MINOS"

codesign --force --sign - "$APP" >/dev/null 2>&1 || true

SIZE=$(du -sh "$APP" | cut -f1 | tr -d ' ')
echo "built: $APP ($SIZE)$([ "$PORTABLE" = "1" ] && echo ' · portable, no embedded paths')"
