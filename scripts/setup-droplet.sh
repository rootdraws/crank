#!/usr/bin/env bash
set -euo pipefail

DOMAIN="bot.crank.money"
APP_DIR="/root/crank-money"
KEYS_DIR="/root/.keys"

echo "==> Installing Node.js 20 via NodeSource"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "==> Installing PM2 globally"
npm install -g pm2

echo "==> Installing nginx"
apt-get install -y nginx

echo "==> Installing certbot"
apt-get install -y certbot python3-certbot-nginx

echo "==> Installing fail2ban"
apt-get install -y fail2ban
systemctl enable fail2ban
systemctl start fail2ban

echo "==> Installing unattended-upgrades"
apt-get install -y unattended-upgrades
# Enable automatic security updates
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'APTCONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
APTCONF

echo "==> Hardening SSH"
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
systemctl reload sshd

echo "==> Configuring UFW firewall"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "==> Creating application directories"
mkdir -p "$APP_DIR"
mkdir -p "$APP_DIR/data"
chmod 700 "$APP_DIR/data"
mkdir -p "$KEYS_DIR"
chmod 700 "$KEYS_DIR"

echo "==> Installing nginx site config"
cp "$APP_DIR/deploy/nginx/$DOMAIN.conf" "/etc/nginx/sites-available/$DOMAIN"
ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> Obtaining SSL certificate via Let's Encrypt"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email

echo "==> Configuring PM2 log rotation"
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true

echo "==> Starting bot with PM2"
cd "$APP_DIR"
npm install --omit=dev
pm2 start bot/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash

echo ""
echo "==> Setup complete!"
echo "    App dir:  $APP_DIR"
echo "    Keys dir: $KEYS_DIR"
echo "    Domain:   https://$DOMAIN"
echo ""
echo "Next steps:"
echo "  1. Copy bot keypair to $KEYS_DIR/bot-keypair.json (chmod 600)"
echo "  2. Copy bot/.env to the server and set BOT_KEYPAIR_PATH=$KEYS_DIR/bot-keypair.json"
echo "  3. Run: pm2 restart crank-harvester"
echo "  4. Verify: curl https://$DOMAIN/api/stats"
echo "  5. Back up WALLET_ENCRYPTION_KEY offline (password manager / safe deposit box)"
