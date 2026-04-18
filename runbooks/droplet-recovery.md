# Droplet Recovery Runbook

**Use case:** the DigitalOcean droplet `crank-harvester` is dead, unresponsive, or has to be rebuilt. This walks through bringing a fresh droplet to the same operational state.

**Expected downtime:** 30-60 min if nothing goes wrong. Bot is offline during this window — no harvests, no Discord slash commands, no API. Open positions are not at risk (on-chain), but unharvested converted bins sit until the bot is back.

## Pre-req: what you need in hand

Before starting, verify you have access to each of these. If any is missing, **stop and recover it first** — some are unrecoverable.

| Asset | Location | Lost → what happens |
|---|---|---|
| Bot keypair | `~/crank-wallet-backup.json` (Root's local machine) | Lose this → lose admin authority on all 6 programs. Run keypair-separation runbook FIRST if this is the failure. |
| SSH deploy key | `~/.ssh/id_ed25519_deploy` | Can generate a new one and add to new droplet. |
| `.env` secrets (DISCORD_TOKEN, DISCORD_CLIENT_ID, RELAY_AUTH_TOKEN, GRPC_ENDPOINT, RPC_URL, PINATA_JWT, s3cmd credentials for DO Spaces, BACKUP_ENCRYPTION_KEY) | Not in repo. Keep a copy in a password manager. | Lose them → regenerate each: Discord tokens in dev portal, RELAY_AUTH_TOKEN can be any random string (update wherever it's consumed), Helius key from dashboard, etc. |
| DigitalOcean account | `rootdraws@gmail.com` | Lose → can't spin up. Recover DO account first. |
| Vercel DNS control for `crank.money` | Vercel dashboard | Lose → point DNS elsewhere, but bot.crank.money A record must be updated. |
| DO Spaces bucket `crank-backups` | Spaces dashboard | Has encrypted wallet DB snapshots. Losing this means users need to re-register via `/start` (inconvenience, not fund loss — all funds are in PDA vaults on-chain). |

## Step 1 — Provision new droplet

DO UI → Droplets → Create → **Ubuntu 22.04 (LTS) x64**, **s-2vcpu-4gb**, **NYC1** (match prior region). Add SSH key `id_ed25519_deploy.pub` during creation.

Once provisioned, note the IP. Update `DROPLET_IP` in `scripts/deploy.sh` (top of file) if it differs from `159.223.133.9`. Also update wherever else you reference it (`~/.ssh/config`, shell aliases).

Verify access:
```bash
ssh -i ~/.ssh/id_ed25519_deploy root@<NEW_IP> 'uname -a'
```

## Step 2 — Add swap

PM2 runs lean but the build steps can spike memory. 1GB swap:
```bash
ssh -i ~/.ssh/id_ed25519_deploy root@<NEW_IP> '
  fallocate -l 1G /swapfile &&
  chmod 600 /swapfile &&
  mkswap /swapfile &&
  swapon /swapfile &&
  echo "/swapfile none swap sw 0 0" >> /etc/fstab'
```

## Step 3 — Run setup-droplet.sh

Remote execution — pulls the script from local machine:

```bash
scp -i ~/.ssh/id_ed25519_deploy scripts/setup-droplet.sh root@<NEW_IP>:/root/
ssh -i ~/.ssh/id_ed25519_deploy root@<NEW_IP> 'bash /root/setup-droplet.sh'
```

This installs: Node, PM2, nginx, certbot, fail2ban, unattended-upgrades, UFW firewall, PM2 log rotation, s3cmd.

## Step 4 — Install bot keypair + encryption key

```bash
scp -i ~/.ssh/id_ed25519_deploy ~/crank-wallet-backup.json root@<NEW_IP>:/root/.keys/bot-keypair.json
ssh -i ~/.ssh/id_ed25519_deploy root@<NEW_IP> 'chmod 600 /root/.keys/bot-keypair.json'
```

Generate (or restore) the backup encryption key for wallet DB backups:
```bash
# First time only — generates and stores locally
ssh -i ~/.ssh/id_ed25519_deploy root@<NEW_IP> '
  openssl rand -hex 32 > /root/.keys/backup.key &&
  chmod 600 /root/.keys/backup.key'
# Save the output somewhere safe. You need THIS key to decrypt any future DO Spaces backups.
```

If you already have a backup.key from the dead droplet (you saved it somewhere), scp that instead of generating a new one — otherwise old DO Spaces snapshots become unreadable.

## Step 5 — Configure s3cmd for DO Spaces

```bash
ssh -i ~/.ssh/id_ed25519_deploy root@<NEW_IP> 's3cmd --configure'
# - Access Key / Secret: from DO API dashboard (Spaces credentials)
# - Region: nyc3
# - DNS-style: %(bucket)s.nyc3.digitaloceanspaces.com
```

Test:
```bash
ssh -i ~/.ssh/id_ed25519_deploy root@<NEW_IP> 's3cmd ls s3://crank-backups/ | tail -5'
```

## Step 6 — Restore wallet DB from DO Spaces

```bash
ssh -i ~/.ssh/id_ed25519_deploy root@<NEW_IP> '
  mkdir -p /root/crank-money/data &&
  s3cmd ls s3://crank-backups/ | tail -1
  s3cmd get s3://crank-backups/crankbot-latest.json.enc /tmp/backup.enc &&
  openssl enc -d -aes-256-cbc -pbkdf2 -in /tmp/backup.enc -out /root/crank-money/data/crankbot.json \
    -pass pass:"$(cat /root/.keys/backup.key)" &&
  chmod 600 /root/crank-money/data/crankbot.json &&
  shred -u /tmp/backup.enc'
```

(The decryption is two-line — snap the real S3 key in and run.)

Verify the DB loaded:
```bash
ssh -i ~/.ssh/id_ed25519_deploy root@<NEW_IP> 'head -c 200 /root/crank-money/data/crankbot.json'
```

If this fails and a fresh-start is acceptable: delete the file. Users re-register via `/start`. No funds lost.

## Step 7 — Clone repo + create .env

Skip clone — `scripts/deploy.sh` rsyncs from local. But `.env` must be placed manually (it's excluded from rsync):

```bash
scp -i ~/.ssh/id_ed25519_deploy ~/path/to/local/bot.env root@<NEW_IP>:/root/crank-money/bot/.env
ssh -i ~/.ssh/id_ed25519_deploy root@<NEW_IP> 'chmod 600 /root/crank-money/bot/.env'
```

If you don't have a saved `.env`, reconstruct from the password manager. Minimum vars:
- `RPC_URL` (Helius mainnet RPC)
- `GRPC_ENDPOINT` (Helius LaserStream)
- `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`
- `DISCORD_FEED_CHANNEL_ID`, `DISCORD_CRANK_ROLE_ID`, `DISCORD_ENABLE_MEMBER_INTENT=true`
- `RELAY_AUTH_TOKEN` (any 32+ char random string — must match whatever external tools use)
- `BOT_KEYPAIR_PATH=/root/.keys/bot-keypair.json`
- `DB_PATH=/root/crank-money/data/crankbot.json`
- `PINATA_JWT` (for IPFS uploads from epoch-computer)
- `CRANK_ROLE_PRUNE_DRY_RUN=false`
- `MIN_HARVEST_USD=0.25`

## Step 8 — Deploy

```bash
bash scripts/deploy.sh
```

Liveness check should return HTTP 200.

## Step 9 — Re-register Discord slash commands

```bash
ssh -i ~/.ssh/id_ed25519_deploy root@<NEW_IP> '
  cd /root/crank-money/packages/discord-bot && npm run deploy-commands'
```

## Step 10 — DNS cutover

Update `bot.crank.money` A record on Vercel DNS to the new droplet IP. Propagation: usually < 5 min.

```bash
# Verify
dig +short bot.crank.money
```

## Step 11 — SSL cert

Let's Encrypt:
```bash
ssh -i ~/.ssh/id_ed25519_deploy root@<NEW_IP> '
  certbot --nginx -d bot.crank.money --non-interactive --agree-tos -m rootdraws@gmail.com'
```

Verify:
```bash
curl -s https://bot.crank.money/api/health
```

## Step 12 — Install wallet DB backup cron

```bash
ssh -i ~/.ssh/id_ed25519_deploy root@<NEW_IP> '
  (crontab -l 2>/dev/null; echo "* * * * * /usr/bin/flock -n /tmp/crank-backup.lock /root/crank-money/scripts/backup-wallet-db.sh >> /var/log/crank-backup.log 2>&1") | crontab -'
```

## Step 13 — Verify end-to-end

- `https://bot.crank.money/api/health` returns 200, `grpcConnected: true`
- Discord: bot shows online, slash commands work
- Open a $1 test position via `/buy`, watch feed channel for confirmation, close it
- `/stats` returns something sensible

## Post-recovery

- Update `CLAUDE.md` if droplet IP changed
- Push any fixes from this runbook back into scripts (automation debt)
- Consider: does this failure change the risk profile of single-keypair setup? If yes → prioritize the keypair-separation runbook
