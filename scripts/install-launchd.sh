#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_NAME="com.openpaw.nanoclaw"
PLIST_SRC="$REPO_DIR/$PLIST_NAME.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
LOG_DIR="$HOME/.nanoclaw/logs"

# Verify prerequisites
if [ ! -f "$PLIST_SRC" ]; then
    echo "Error: $PLIST_SRC not found" >&2
    exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "Error: docker not found in PATH" >&2
    exit 1
fi

if [ ! -f "$REPO_DIR/docker-compose.yml" ]; then
    echo "Error: docker-compose.yml not found in $REPO_DIR" >&2
    exit 1
fi

# Unload existing agent if loaded
if launchctl list "$PLIST_NAME" >/dev/null 2>&1; then
    echo "Unloading existing $PLIST_NAME..."
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

# Create required directories
mkdir -p "$LOG_DIR"
mkdir -p "$HOME/Library/LaunchAgents"

# Generate plist with resolved paths
sed -e "s|__REPO_DIR__|$REPO_DIR|g" \
    -e "s|__HOME_DIR__|$HOME|g" \
    "$PLIST_SRC" > "$PLIST_DEST"

# Make wrapper script executable
chmod +x "$REPO_DIR/scripts/nanoclaw-start.sh"

# Validate plist XML
if ! plutil -lint "$PLIST_DEST" >/dev/null 2>&1; then
    echo "Error: generated plist is invalid" >&2
    plutil -lint "$PLIST_DEST"
    exit 1
fi

# Load the agent
launchctl load -w "$PLIST_DEST"

echo "Installed and loaded $PLIST_NAME"
echo "  Plist: $PLIST_DEST"
echo "  Logs:  $LOG_DIR/nanoclaw.{stdout,stderr}.log"
echo ""
echo "Commands:"
echo "  launchctl unload $PLIST_DEST    # stop"
echo "  launchctl load -w $PLIST_DEST   # start"
echo "  launchctl list $PLIST_NAME      # status"
