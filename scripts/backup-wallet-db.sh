#!/usr/bin/env bash
set -euo pipefail

# Per-minute backup of crankbot.json to DigitalOcean Spaces (S3-compatible)
# Encrypted with AES-256-CBC before upload using BACKUP_ENCRYPTION_KEY.
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
#   5. Set BACKUP_ENCRYPTION_KEY in /root/.keys/backup.key (chmod 600)
#      Generate: openssl rand -hex 32 > /root/.keys/backup.key && chmod 600 /root/.keys/backup.key
#   6. Add cron:
#      crontab -e
#      * * * * * /root/crank-money/scripts/backup-wallet-db.sh >> /var/log/crank-backup.log 2>&1

DB_PATH="/root/crank-money/data/crankbot.json"
SPACE="s3://crank-backups"
TIMESTAMP=$(date +%F-%H%M)
BACKUP_KEY_FILE="/root/.keys/backup.key"

if [ ! -f "$DB_PATH" ]; then
  echo "$(date): No wallet DB found at $DB_PATH — skipping backup"
  exit 0
fi

# Encrypt before upload if key is available
if [ -f "$BACKUP_KEY_FILE" ]; then
  BACKUP_KEY=$(cat "$BACKUP_KEY_FILE" | tr -d '[:space:]')
  ENCRYPTED_PATH=$(mktemp)
  trap "rm -f $ENCRYPTED_PATH" EXIT

  openssl enc -aes-256-cbc -salt -pbkdf2 \
    -in "$DB_PATH" -out "$ENCRYPTED_PATH" \
    -pass "pass:$BACKUP_KEY"

  # Upload encrypted with timestamp
  s3cmd put --quiet "$ENCRYPTED_PATH" "$SPACE/crankbot-$TIMESTAMP.json.enc"
  # Also upload as "latest" for easy restore
  s3cmd put --quiet "$ENCRYPTED_PATH" "$SPACE/crankbot-latest.json.enc"

  # Verify: download latest and compare checksum
  VERIFY_PATH=$(mktemp)
  trap "rm -f $ENCRYPTED_PATH $VERIFY_PATH" EXIT
  s3cmd get --quiet --force "$SPACE/crankbot-latest.json.enc" "$VERIFY_PATH"
  LOCAL_SUM=$(sha256sum "$ENCRYPTED_PATH" | awk '{print $1}')
  REMOTE_SUM=$(sha256sum "$VERIFY_PATH" | awk '{print $1}')
  if [ "$LOCAL_SUM" != "$REMOTE_SUM" ]; then
    echo "$(date): BACKUP INTEGRITY FAILURE — local=$LOCAL_SUM remote=$REMOTE_SUM"
    exit 1
  fi
else
  echo "$(date): WARNING — no backup key at $BACKUP_KEY_FILE, uploading unencrypted"
  s3cmd put --quiet "$DB_PATH" "$SPACE/crankbot-$TIMESTAMP.json"
  s3cmd put --quiet "$DB_PATH" "$SPACE/crankbot-latest.json"
fi

# Clean up backups older than 7 days
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
