#!/usr/bin/env bash
set -euo pipefail

# Source root .env if it exists (gitignored, local-only)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$SCRIPT_DIR/../.env" ] && source "$SCRIPT_DIR/../.env"

DROPLET_IP="${1:-${DROPLET_IP:?Set DROPLET_IP env var or pass as argument}}"
REMOTE_USER="${DEPLOY_USER:-root}"
REMOTE_DIR="$([ "$REMOTE_USER" = "root" ] && echo "/root" || echo "/home/$REMOTE_USER")/crank-money"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_deploy}"

REMOTE="$REMOTE_USER@$DROPLET_IP"
SSH_OPTS="-i $SSH_KEY"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Pre-deploy backup of wallet DB + caches"
ssh $SSH_OPTS "$REMOTE" "
  cd $REMOTE_DIR
  if [ -f data/crankbot.json ]; then
    cp data/crankbot.json data/crankbot.json.pre-deploy
    echo 'Backed up data/crankbot.json'
  fi
  if [ -f positions-cache.json ]; then
    cp positions-cache.json positions-cache.json.pre-deploy
  fi
  if [ -f feed-cache.json ]; then
    cp feed-cache.json feed-cache.json.pre-deploy
  fi
"

echo "==> Syncing code to $REMOTE:$REMOTE_DIR"
rsync -avz --delete \
    -e "ssh $SSH_OPTS" \
    --exclude 'node_modules/' \
    --exclude '.env' \
    --exclude '*.env' \
    --exclude '.env.example' \
    --exclude 'target/' \
    --exclude 'ref/' \
    --exclude '.git/' \
    --exclude '.vercel/' \
    --exclude 'positions-cache.json' \
    --exclude 'feed-cache.json' \
    --exclude 'data/' \
    --exclude '.DS_Store' \
    --exclude 'claude.md' \
    "$PROJECT_ROOT/" "$REMOTE:$REMOTE_DIR/"

echo "==> Installing dependencies and restarting bot"
ssh $SSH_OPTS "$REMOTE" "cd $REMOTE_DIR && npm install --omit=dev && pm2 restart crank-harvester"

echo "==> Waiting for bot to come up..."
sleep 10

# Liveness check: process is up and HTTP responds.
# /api/health is unauthenticated (other /api/* require Bearer). 200 = fully healthy,
# 503 = process alive but gRPC still handshaking (normal for ~3–4 min post-restart).
echo "==> Liveness check"
HEALTH_JSON=$(ssh $SSH_OPTS "$REMOTE" "curl -s --max-time 5 http://localhost:8080/api/health" || true)
HEALTH_CODE=$(ssh $SSH_OPTS "$REMOTE" "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:8080/api/health" || echo "000")

if ! echo "$HEALTH_CODE" | grep -qE '^(200|503)$'; then
    echo "HTTP $HEALTH_CODE — bot not responding"
    echo ""
    echo "WARNING: Liveness check failed!"
    echo ""
    echo "Diagnostics:"
    echo "  ssh $SSH_OPTS $REMOTE 'pm2 logs crank-harvester --lines 50'"
    echo ""
    echo "Rollback (restore pre-deploy state):"
    echo "  ssh $SSH_OPTS $REMOTE 'cd $REMOTE_DIR && git checkout . && npm install --omit=dev && pm2 restart crank-harvester'"
    echo ""
    echo "Wallet DB backup (if needed):"
    echo "  ssh $SSH_OPTS $REMOTE 'ls -la $REMOTE_DIR/data/crankbot.json.pre-deploy'"
    exit 1
fi

echo "HTTP $HEALTH_CODE — bot alive"
echo "$HEALTH_JSON"

# Surface gRPC status as a note, not a failure.
if echo "$HEALTH_JSON" | grep -q '"grpcConnected":false'; then
    echo ""
    echo "NOTE: gRPC not yet connected. Handshake typically completes within 3–4 minutes."
    echo "      Safety poll (5s fallback) covers harvests in the interim."
fi

echo ""
echo "==> Deploy complete!"
