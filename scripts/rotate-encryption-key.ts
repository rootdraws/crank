#!/usr/bin/env npx tsx
/**
 * rotate-encryption-key.ts
 *
 * Decrypts all custody wallets with the old key, re-encrypts with a new key.
 * Run ON THE SERVER ONLY. Never pipe keys through chat.
 *
 * Usage (on the droplet):
 *   OLD_KEY=<old_hex> NEW_KEY=<new_hex> npx tsx scripts/rotate-encryption-key.ts
 *
 * Or generate a new key inline:
 *   OLD_KEY=$(grep WALLET_ENCRYPTION_KEY bot/.env | cut -d= -f2) \
 *   NEW_KEY=$(openssl rand -hex 32) \
 *   npx tsx scripts/rotate-encryption-key.ts
 *
 * After success:
 *   1. Update WALLET_ENCRYPTION_KEY in bot/.env with the new key
 *   2. Restart PM2: pm2 restart crank-harvester
 *   3. Verify: pm2 logs crank-harvester --lines 20 (no decryption errors)
 *   4. Store old key backup somewhere safe until you're confident
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

const DB_PATH = process.env.DB_PATH || './data/crankbot.json';

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseKey(hex: string, label: string): Buffer {
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_LEN) {
    throw new Error(`${label} must be ${KEY_LEN * 2} hex chars (${KEY_LEN} bytes), got ${hex.length}`);
  }
  return key;
}

function decrypt(ciphertext: string, key: Buffer): Buffer {
  const data = Buffer.from(ciphertext, 'hex');
  const iv = data.subarray(0, IV_LEN);
  const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = data.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function encrypt(plaintext: Buffer, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('hex');
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const oldHex = process.env.OLD_KEY;
  const newHex = process.env.NEW_KEY;

  if (!oldHex || !newHex) {
    console.error('Usage: OLD_KEY=<hex> NEW_KEY=<hex> npx tsx scripts/rotate-encryption-key.ts');
    process.exit(1);
  }

  if (oldHex === newHex) {
    console.error('ERROR: OLD_KEY and NEW_KEY are identical. Nothing to rotate.');
    process.exit(1);
  }

  const oldKey = parseKey(oldHex, 'OLD_KEY');
  const newKey = parseKey(newHex, 'NEW_KEY');

  const dbPath = path.resolve(DB_PATH);
  if (!fs.existsSync(dbPath)) {
    console.error(`ERROR: DB not found at ${dbPath}`);
    process.exit(1);
  }

  // Back up before touching anything
  const backupPath = dbPath + `.bak-${Date.now()}`;
  fs.copyFileSync(dbPath, backupPath);
  console.log(`Backup created: ${backupPath}`);

  const data = JSON.parse(fs.readFileSync(dbPath, 'utf-8'));
  const users = data.users || {};
  const userIds = Object.keys(users);

  if (userIds.length === 0) {
    console.log('No users in DB. Nothing to rotate.');
    return;
  }

  console.log(`Found ${userIds.length} user(s). Rotating keys...`);

  let rotated = 0;
  let errors = 0;

  for (const userId of userIds) {
    const user = users[userId];
    try {
      // Decrypt with old key
      const secretKey = decrypt(user.encrypted_keypair, oldKey);

      // Sanity check: Ed25519 keypair is 64 bytes
      if (secretKey.length !== 64) {
        throw new Error(`Unexpected keypair length: ${secretKey.length} (expected 64)`);
      }

      // Re-encrypt with new key
      user.encrypted_keypair = encrypt(secretKey, newKey);
      rotated++;
    } catch (err: any) {
      console.error(`FAILED to rotate user ${userId}: ${err.message}`);
      errors++;
    }
  }

  if (errors > 0) {
    console.error(`\n${errors} error(s) encountered. DB NOT written.`);
    console.error(`Backup preserved at: ${backupPath}`);
    console.error('Fix the errors and re-run. If OLD_KEY is wrong, all decryptions will fail.');
    process.exit(1);
  }

  // Write rotated DB
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
  console.log(`\nRotated ${rotated} keypair(s) successfully.`);
  console.log(`DB written to: ${dbPath}`);
  console.log(`Backup at: ${backupPath}`);
  console.log('\nNext steps:');
  console.log('  1. Update WALLET_ENCRYPTION_KEY in bot/.env with NEW_KEY');
  console.log('  2. pm2 restart crank-harvester');
  console.log('  3. Verify: pm2 logs crank-harvester --lines 20');
  console.log('  4. Keep backup + old key until confirmed working');
}

main();
