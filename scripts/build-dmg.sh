#!/bin/bash
# Package TokenFlow.app into a distributable DMG.
#
#   scripts/build-dmg.sh [version]        # → dist/TokenFlow-<version>.dmg
#
# Builds the app first (scripts/build-menubar-app.sh), then wraps it in a
# drag-to-Applications DMG. Requires macOS with hdiutil (built in) and
# Xcode Command Line Tools for swiftc. The DMG is unsigned — Gatekeeper
# right-click → Open on first launch, see docs/getting-started.md.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(node -p "require('$REPO/package.json').version")}"
DIST="$REPO/dist"
APP="$DIST/TokenFlow.app"
DMG="$DIST/TokenFlow-$VERSION.dmg"

# A DMG is for other people's machines, so it must carry no path from this one.
TOKENFLOW_PORTABLE=1 "$REPO/scripts/build-menubar-app.sh" "$DIST" "$VERSION" >/dev/null
echo "built TokenFlow.app (portable)"

# Fail here rather than shipping an app that points at the build host.
for KEY in TokenFlowCLIPath TokenFlowNodePath; do
  if /usr/libexec/PlistBuddy -c "Print :$KEY" "$APP/Contents/Info.plist" >/dev/null 2>&1; then
    echo "error: $KEY is embedded in a distributable build" >&2
    exit 1
  fi
done

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"

rm -f "$DMG"
hdiutil create -volname "TokenFlow $VERSION" \
  -srcfolder "$STAGING" \
  -ov -format UDZO \
  "$DMG" | tail -1

echo "wrote $DMG ($(du -h "$DMG" | cut -f1))"
