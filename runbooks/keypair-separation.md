# Keypair Separation Runbook

**Status:** not yet executed. Blocked on Ledger acquisition.
**Source:** Audit C-02 / todo.md "Keypair Separation".

## Why

Today a single keypair (`FFwqCuYTw7DFWWRQD3tYcPBPpmaAQjT1JV5kqG15QPsL`) does three things:

1. Signs daily bot txs (harvest, sweep, epoch, keeper) — on droplet at `/root/.keys/bot-keypair.json`.
2. Holds upgrade authority for all 6 programs (bin-farm, bank-mint, gauge-voter, merkle-distributor, bank-distributor, epoch-vault).
3. Is `Config.bot` — receives protocol skim from `sweep_rover`.

Droplet compromise → attacker gets all three. User funds stay safe (PDA vault architecture, non-custodial distribution), but attacker can:
- Push malicious program upgrades to any of the 6 programs.
- Redirect future protocol skim to their wallet.
- Sign arbitrary txs as the protocol.

Separation goal: three keys with different security levels.

| Role | Key | Where | Signing frequency |
|---|---|---|---|
| Hot bot | `bot-keypair.json` | droplet, chmod 600 | every tx |
| Admin (upgrade authority ×6) | Ledger slot 0 | hardware wallet, offline | ~monthly |
| Treasury (skim destination) | Ledger slot 1 OR same as Admin | hardware wallet | on withdraw |

Admin + Treasury can be the same key if you don't want to split. Separation matters between hot/cold, not within cold.

## Prereqs

- Ledger Nano X or Nano S Plus (~$80, Solana app installed).
- ~2 SOL available to fund the new hot bot keypair.
- `solana-cli` locally configured to talk to mainnet.
- Discord bot offline window of ~30min.

## Steps

Execute one at a time. Verify each before moving to the next. `--dry-run` every on-chain call first when available.

### 0. Snapshot current state

```bash
solana program show 8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia --url mainnet-beta
solana program show FjK8AaLTfj8fP8bf88tmwCxu2xyhTXhaSkHGzCEZyczk --url mainnet-beta
solana program show DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA --url mainnet-beta
solana program show DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV --url mainnet-beta
solana program show 9sqcwp65VGxkbLG3KN85BrzZz2Q77xnfbpPcBfn1kj7M --url mainnet-beta
solana program show 7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN --url mainnet-beta
```

Confirm every `Authority:` line prints `FFwqCuYTw7DFWWRQD3tYcPBPpmaAQjT1JV5kqG15QPsL`. Screenshot or save to a file.

### 1. Set up Ledger

- Fresh seed phrase. Write it down twice. Store offline in two geographically separated locations. Don't photograph.
- Install Solana app (Ledger Live → Manager → Solana).
- Derive address: `solana address --keypair usb://ledger` — this is the **Admin** address.
- If splitting Treasury: derive a second address with a different derivation path, e.g. `usb://ledger?key=1`.

### 2. Generate hot bot keypair

Local, not on droplet:

```bash
solana-keygen new --outfile ~/.keys/new-bot-keypair.json --no-bip39-passphrase
solana-keygen pubkey ~/.keys/new-bot-keypair.json  # record the address
```

Fund it with ~2 SOL from the current bot wallet:

```bash
solana transfer <new-bot-pubkey> 2 --url mainnet-beta --allow-unfunded-recipient
```

### 3. Call `update_bot` on bin-farm

```bash
# Use a script or Anchor CLI. This changes Config.bot → new hot bot.
# Signed by current authority (old key).
npx tsx scripts/update-bot.ts --new-bot <new-bot-pubkey> --execute
```

(Write this script if it doesn't exist — signature is `update_bot(new_bot: Pubkey)` in bin-farm, admin-gated.)

**Note:** `Config.bot` is both the bot tx signer AND the skim destination. If Admin == Treasury, you're done here. If Treasury is separate, the cleanest path is to split `Config.bot` into `Config.bot` (signer) + `Config.fee_destination` (skim) — requires a bin-farm upgrade. Simpler: reuse the Admin Ledger key for both until you actually need separation.

### 4. Verify hot bot works

Before transferring any upgrade authority:

1. Update `/root/.keys/bot-keypair.json` on droplet to the new hot bot keypair.
2. Restart PM2: `pm2 restart crank-harvester`.
3. Run at least one full keeper cycle: `curl -H "Authorization: Bearer $RELAY_AUTH_TOKEN" http://localhost:8080/api/health`.
4. Open a test position, close it. Check bot wallet delta.
5. Run a manual epoch dry-run: `npx tsx scripts/test-epoch.ts --dry-run`.

If any of this fails, roll back to the old keypair. You still have upgrade authority — you can fix anything.

### 5. Transfer upgrade authority (point of no return)

For each program, one at a time. Verify after each.

```bash
solana program set-upgrade-authority <program-id> \
  --new-upgrade-authority <ledger-admin-pubkey> \
  --url mainnet-beta
```

Programs:

```
8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia  # bin-farm
FjK8AaLTfj8fP8bf88tmwCxu2xyhTXhaSkHGzCEZyczk  # bank-mint
DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA  # gauge-voter
DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV  # merkle-distributor
9sqcwp65VGxkbLG3KN85BrzZz2Q77xnfbpPcBfn1kj7M  # bank-distributor
7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN  # epoch-vault
```

After each, re-run the corresponding `solana program show` and confirm `Authority:` is the Ledger address.

### 6. Drain and retire the old keypair

Old key should now hold no authority. Drain any remaining SOL to Treasury:

```bash
solana transfer <treasury-pubkey> ALL --keypair <old-keypair> --url mainnet-beta
```

Move the old keypair file out of `/root/.keys/`. Keep it offline for disaster recovery (it's no longer dangerous — can't do anything).

### 7. Update docs

- `CLAUDE.md` bot security section: document the new key roles.
- `todo.md`: mark C-02 complete with deployment date.
- Back up Ledger seed phrase location (not on Ledger, not digital).

## Rollback

If step 4 fails: revert `/root/.keys/bot-keypair.json` to old key, restart PM2, call `update_bot(OLD_PUBKEY)` with old key (which still has admin authority at this point).

If step 5 fails mid-way: you've transferred some upgrade authorities but not others. This is fine — partial state is still secure. Complete remaining transfers when ready.

If Ledger seed is ever lost: you cannot recover admin authority. This is why we write the seed twice and store in two locations.

## Time estimate

- Ledger setup: 15min
- New bot keypair + fund: 5min
- `update_bot` + verification: 10min
- Upgrade authority transfers (×6): 15min
- Retire old keypair: 5min

Total: ~1 hour if nothing breaks. Budget 2 hours for first-time execution.
