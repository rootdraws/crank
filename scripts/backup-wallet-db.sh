#!/usr/bin/env bash
set -euo pipefail

# Per-minute backup of crankbot.json to DigitalOcean Spaces (S3-compatible)
#
# Prerequisites:
#   1. Create a DO Space (e.g. "crank-backups") in the DO dashboard
#   2. Generate Spaces API keys: cloud.digitalocean.com → API → Spaces Keys
#   3. Install s3cmd: apt install -y s3cmd
#   4. Configure: s3cmd --configure
#      - Access Key: <your spaces access key>
#      - Secret Key: <your spaces secret key>
#      - S3 Endpoint: nyc3.digitaloceanspaces.com (match your space region)
#      - DNS-style: %(bucket)s.nyc3.digitaloceanspaces.com
#      - Leave everything else default, save config
#   5. Add cron:
#      crontab -e
#      * * * * * /root/crank-money/scripts/backup-wallet-db.sh >> /var/log/crank-backup.log 2>&1

DB_PATH="/root/crank-money/data/crankbot.json"
SPACE="s3://crank-backups"
TIMESTAMP=$(date +%F-%H%M)

if [ ! -f "$DB_PATH" ]; then
  echo "$(date): No wallet DB found at $DB_PATH — skipping backup"
  exit 0
fi

# Upload with timestamp (per-minute granularity)
s3cmd put --quiet "$DB_PATH" "$SPACE/crankbot-$TIMESTAMP.json"

# Also upload as "latest" for easy restore
s3cmd put --quiet "$DB_PATH" "$SPACE/crankbot-latest.json"

# Clean up backups older than 7 days (keeps ~10k files, ~6MB total)
s3cmd ls "$SPACE/" | while read -r line; do
  file_date=$(echo "$line" | awk '{print $1}')
  file_path=$(echo "$line" | awk '{print $4}')
  if [ -z "$file_path" ] || [[ "$file_path" == *"latest"* ]]; then
    continue
  fi
  if [ "$(date -d "$file_date" +%s 2>/dev/null || echo 0)" -lt "$(date -d '7 days ago' +%s)" ]; then
    s3cmd del --quiet "$file_path"
  fi
done
