#!/usr/bin/env bash
set -euo pipefail

DROPLET_IP="${1:-${DROPLET_IP:-159.223.133.9}}"
REMOTE_DIR="/root/crank-money"
REMOTE_USER="root"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_deploy}"

REMOTE="$REMOTE_USER@$DROPLET_IP"
SSH_OPTS="-i $SSH_KEY"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

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
    --exclude '.DS_Store' \
    --exclude 'claude.md' \
    "$PROJECT_ROOT/" "$REMOTE:$REMOTE_DIR/"

echo "==> Installing dependencies and restarting bot"
ssh $SSH_OPTS "$REMOTE" "cd $REMOTE_DIR && npm install --omit=dev && pm2 restart crank-harvester"

echo "==> Waiting for bot to come up..."
sleep 3

echo "==> Health check"
HEALTH=$(ssh $SSH_OPTS "$REMOTE" "curl -sf http://localhost:8080/api/stats || echo 'FAILED'")
echo "$HEALTH"

if [ "$HEALTH" = "FAILED" ]; then
    echo ""
    echo "WARNING: Health check failed. Check logs with:"
    echo "  ssh $SSH_OPTS $REMOTE 'pm2 logs crank-harvester --lines 50'"
    exit 1
fi

echo ""
echo "==> Deploy complete!"
