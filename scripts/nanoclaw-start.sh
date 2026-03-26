#!/bin/bash
set -euo pipefail

# launchd provides a minimal PATH; add common Docker installation paths
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

# Docker Desktop may start after launchd on boot -- wait up to 5 minutes
MAX_WAIT=300
WAITED=0
while ! docker info >/dev/null 2>&1; do
    if [ "$WAITED" -ge "$MAX_WAIT" ]; then
        echo "$(date): Docker not available after ${MAX_WAIT}s" >&2
        exit 1
    fi
    sleep 5
    WAITED=$((WAITED + 5))
done

echo "$(date): Starting NanoClaw"

# exec replaces this shell so launchd directly manages the compose process.
# docker compose up handles already-running containers gracefully --
# it attaches to existing containers without recreating them.
exec docker compose up
