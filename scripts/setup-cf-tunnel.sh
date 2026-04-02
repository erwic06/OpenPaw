#!/usr/bin/env bash
# OpenPaw Cloudflare Tunnel and Access Setup
#
# Prerequisites:
#   - Cloudflare account with a domain (openpaw.me)
#   - cloudflared CLI installed: brew install cloudflare/cloudflare/cloudflared
#   - Authenticated: cloudflared login
#
# This script automates what can be automated. Some steps require
# the Cloudflare dashboard.

set -euo pipefail

TUNNEL_NAME="${1:-openpaw}"
DOMAIN="${2:-openpaw.me}"
LOCAL_PORT="${3:-9999}"

echo "=== OpenPaw Cloudflare Tunnel Setup ==="
echo "Tunnel: $TUNNEL_NAME"
echo "Domain: $DOMAIN"
echo "Local port: $LOCAL_PORT"
echo

# Step 1: Create tunnel
echo "[1/4] Creating Cloudflare Tunnel..."
if cloudflared tunnel list | grep -q "$TUNNEL_NAME"; then
  echo "  Tunnel '$TUNNEL_NAME' already exists, skipping creation."
else
  cloudflared tunnel create "$TUNNEL_NAME"
  echo "  Tunnel created."
fi

# Step 2: Route DNS
echo "[2/4] Routing DNS..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN" 2>/dev/null || echo "  DNS route may already exist."

# Step 3: Write config
CONFIG_DIR="$HOME/.cloudflared"
CONFIG_FILE="$CONFIG_DIR/config.yml"
echo "[3/4] Writing tunnel config to $CONFIG_FILE..."

TUNNEL_ID=$(cloudflared tunnel list --output json | python3 -c "
import json, sys
tunnels = json.load(sys.stdin)
for t in tunnels:
    if t['name'] == '$TUNNEL_NAME':
        print(t['id'])
        break
" 2>/dev/null || echo "")

if [ -z "$TUNNEL_ID" ]; then
  echo "  ERROR: Could not find tunnel ID. Create it manually."
  exit 1
fi

cat > "$CONFIG_FILE" << EOF
tunnel: $TUNNEL_ID
credentials-file: $CONFIG_DIR/$TUNNEL_ID.json

ingress:
  - hostname: $DOMAIN
    service: http://localhost:$LOCAL_PORT
    originRequest:
      noTLSVerify: true
  - service: http_status:404
EOF
echo "  Config written."

# Step 4: Manual steps
echo "[4/4] Manual steps required:"
echo
echo "  A) Cloudflare Access (dashboard.cloudflare.com > Zero Trust > Access > Applications):"
echo "     1. Create a Self-Hosted Application"
echo "        - Application domain: $DOMAIN"
echo "        - Session duration: 24 hours"
echo "     2. Add a policy:"
echo "        - Policy name: 'GitHub OAuth'"
echo "        - Action: Allow"
echo "        - Include: Login Methods = GitHub"
echo "        - Require: Emails = <your-github-email>"
echo "     3. Enable MFA in Authentication > Settings"
echo "     4. Note the Application Audience (AUD) Tag"
echo
echo "  B) Add secrets to ~/.nanoclaw/secrets/:"
echo "     echo '<your-cf-team-domain>' > ~/.nanoclaw/secrets/cf_team_domain"
echo "     echo '<application-aud-tag>' > ~/.nanoclaw/secrets/cf_audience_tag"
echo
echo "  C) Start the tunnel:"
echo "     cloudflared tunnel run $TUNNEL_NAME"
echo "     OR add to Docker Compose (see docker-compose.yml)"
echo
echo "  D) Test: curl -I https://$DOMAIN/health"
echo
echo "Done."
