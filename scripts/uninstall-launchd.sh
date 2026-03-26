#!/bin/bash
set -euo pipefail

PLIST_NAME="com.openpaw.nanoclaw"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

if [ ! -f "$PLIST_DEST" ]; then
    echo "$PLIST_NAME is not installed"
    exit 0
fi

# Unload if loaded
if launchctl list "$PLIST_NAME" >/dev/null 2>&1; then
    echo "Unloading $PLIST_NAME..."
    launchctl unload "$PLIST_DEST"
fi

rm "$PLIST_DEST"
echo "Removed $PLIST_DEST"
echo ""
echo "Note: Log files in ~/.nanoclaw/logs/ were not removed."
