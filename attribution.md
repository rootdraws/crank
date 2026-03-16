# Partner Fee Attribution and Distribution System

**Memo-based partner attribution.** White-label frontends stamp a partner ID on transactions. The bot tracks fee attribution per partner. The keeper distributes partner earnings from the bot's 50% share every Saturday.

## Architecture

```
Frontend (gsd.crank.money)
  └─ Detect subdomain → partnerId = "gsd"
  └─ Add SPL Memo IX "crank:p=gsd" to open_position_v2 tx (on-chain, immutable)

Bot (position creation)
  └─ GeyserSubscriber emits positionChanged (created)
  └─ Orchestrator fetches creation tx → parses memo → extracts partner ID
  └─ PartnerTracker stores: position_address → "gsd"

Bot (harvest / close)
  └─ HarvestExecutor estimates fee from bin data
  └─ PartnerTracker tallies: "gsd" → { totalFeeLamports, positionCount }

Keeper (Saturday step 7)
  └─ Read partner fee tallies
  └─ Subtract ops floor from bot balance
  └─ Distribute remainder proportionally via SystemProgram.transfer

Relay
  └─ GET /api/partner-scoreboard → public leaderboard
```

## Data Flow

1. User visits `gsd.crank.money`, opens a position.
2. Frontend detects subdomain, stamps `crank:p=gsd` memo on the transaction (on-chain, immutable).
3. gRPC subscriber detects new position, orchestrator fetches creation tx, parses memo.
4. `PartnerTracker` stores: `position_address -> "gsd"` in `bot/data/partner-attributions.json`.
5. When bot harvests/closes that position, executor estimates fee amount from bin data, calls `PartnerTracker.recordFee()`.
6. `PartnerTracker` tallies: `"gsd" -> { totalFeeLamports, positionCount, lastFee }` in `bot/data/partner-fees.json`.
7. Saturday step 7: keeper reads tallies, distributes from Config.bot wallet proportionally.
8. Scoreboard at `/api/partner-scoreboard` shows public leaderboard.

## On-Chain Memo as Source of Truth

The `crank:p=gsd` memo is the immutable on-chain proof of attribution. Everything else (JSON stores, tallies, scoreboard) is derived from it. If there's ever a dispute, anyone can:

1. Look up the position's creation transaction on Solscan.
2. See the SPL Memo instruction with the partner ID.
3. Verify the fee amounts from the harvest/close transactions.

The Position account has no `_reserved` bytes (unlike Config/RoverAuthority), so storing a referrer on-chain would require a realloc. The memo approach avoids this entirely — zero program changes required.

## Trust Model

| Layer | Where | Trustless? |
|-------|-------|------------|
| Attribution (who referred this) | Memo on-chain | Yes |
| Fee tally (how much did they generate) | Derivable from chain | Yes |
| Distribution (did they get paid) | Transfer on-chain | Yes |
| Scoreboard (leaderboard UI) | Relay endpoint | Verifiable against chain |

## Fee Split Math

Example week:
- Total protocol fees swept: 10 SOL
- 5 SOL → bridge_vault (holders — untouched)
- 5 SOL → Config.bot
  - Ops floor retained (e.g. 1 SOL)
  - 4 SOL → partner pool
    - `gsd` generated 60% of attributed fees → 2.4 SOL
    - `bonk` generated 30% → 1.2 SOL
    - `xyz` generated 10% → 0.4 SOL

Unattributed fees (direct crank.money usage, no memo) stay with the bot. Partners only split the portion they collectively brought in.

## Files to Create

### `bot/partner-tracker.ts`

Core module. Persistent JSON-backed stores for attribution and fee tallies.

```typescript
export class PartnerTracker {
  // position_address -> partner_id
  private attributions: Map<string, string>;
  // partner_id -> { totalFeeLamports, positionCount, lastFeeAt, distributions: [...] }
  private fees: Map<string, PartnerFeeRecord>;

  attributePosition(positionPDA: string, partnerId: string): void;
  recordFee(positionPDA: string, feeLamports: number): void;
  getPartnerForPosition(positionPDA: string): string | null;
  getScoreboard(): PartnerScoreEntry[];
  computeDistribution(availableLamports: number): Map<string, number>;
  recordDistribution(payouts: Map<string, number>, txSig: string): void;
}
```

Persistence: auto-save on write (debounced), load on startup from `bot/data/partner-attributions.json` and `bot/data/partner-fees.json`.

### `bot/data/partner-wallets.json`

Manual config mapping partner IDs to Solana wallet addresses for payouts:

```json
{
  "gsd": "GsDpartnerWalletAddress...",
  "bonk": "BonkPartnerWalletAddress..."
}
```

## Files to Modify

### `public/app.js` — Subdomain detection + memo stamping

**Subdomain detection** — early in app init, parse `window.location.hostname`:
- `gsd.crank.money` → `state.partnerId = "gsd"`
- `crank.money` or `localhost` → `state.partnerId = null`

**Memo instruction** — standalone SPL Memo IX:

```javascript
function buildPartnerMemoIx(partnerId) {
  return new TransactionInstruction({
    programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
    keys: [],
    data: Buffer.from(`crank:p=${partnerId}`),
  });
}
```

Added in two places matching the two TX paths:
- **Versioned path** (`createPosition`): add memo IX to the `ixs` array before compiling to V0 message.
- **Legacy path** (`walletSendTransaction`): add `tx.add(memoIx)` if `state.partnerId` is set.

No signers, no accounts — works in both versioned and legacy transactions with zero overhead.

### `bot/harvest-executor.ts` — Fee estimation + emit amounts

Currently `harvestBins()` and `closePosition()` emit events without fee amounts. Modify to:

1. Before submitting the harvest TX, calculate converted output from bin data:
   - Sell-side: `totalConverted = sum of positionYAmount for harvested bins`
   - Buy-side: `totalConverted = sum of positionXAmount for harvested bins`
2. Calculate fee: `feeLamports = totalConverted * fee_bps / 10000`
3. Add `feeLamports` and `convertedLamports` to emitted events.
4. Call `partnerTracker.recordFee(positionPDA, feeLamports)` if attribution exists.

Bin amounts already available in `meteoraPos.positionData.positionBinData`. For buy-side (token fees), estimate SOL value using DLMM price from `activeId` + `binStep`.

### `bot/anchor-harvest-bot.ts` — Wire partner tracker + creation-tx attribution

In `run()`:
1. Create `PartnerTracker` instance (alongside `AddressBookStore`).
2. Pass it to `HarvestExecutor` and `MonkeKeeper`.
3. Extend existing `positionChanged` handler — when `action === 'created'`:
   - `getSignaturesForAddress(positionPDA, { limit: 1 })` then `getParsedTransaction(sig)`
   - Parse memo instruction data for `crank:p=<partnerId>` pattern.
   - Call `partnerTracker.attributePosition(positionPDA, partnerId)`.

One RPC lookup per new position (not per harvest) — minimal overhead.

### `bot/keeper.ts` — Saturday step 7: Partner distribution

Add `crankPartnerDistribution()` after step 6 in `runSaturdaySequence()`.

1. Get bot wallet balance.
2. Subtract operations floor (`PARTNER_OPS_FLOOR_LAMPORTS`, default 1 SOL).
3. Read partner fee tallies via `PartnerTracker.computeDistribution(available)`.
4. Build `SystemProgram.transfer` to each partner wallet.
5. Batch into transactions, send via `sendAndConfirmTransaction`.
6. Call `partnerTracker.recordDistribution(payouts, txSig)`.

Partner wallets loaded from `bot/data/partner-wallets.json`.

### `bot/relay-server.ts` — Scoreboard endpoint

Add `GET /api/partner-scoreboard` to the `handleRequest` switch:

```json
{
  "partners": [
    {
      "id": "gsd",
      "totalFeesGenerated": 1250000000,
      "positionCount": 47,
      "sharePercent": 62.5,
      "totalDistributed": 850000000,
      "lastDistribution": "2026-03-15T00:00:00Z"
    }
  ],
  "periodStart": "2026-03-08T00:00:00Z",
  "totalProtocolFees": 2000000000
}
```

## Configuration

New env vars in `bot/.env`:
- `PARTNER_OPS_FLOOR_LAMPORTS` — minimum SOL to retain in bot wallet before distributing (default: 1000000000 = 1 SOL)
- `PARTNER_DISTRIBUTION_ENABLED` — toggle distribution on/off (default: false, flip when first partner ships)

## Future: On-Chain Referrer (optional upgrade)

Config has 96 bytes `_reserved`, RoverAuthority has 64 bytes `_reserved`. A future program upgrade could:
- Add a partner registry to Config (or a separate PDA)
- Store `referrer: Pubkey` on Position via realloc
- Move the distribution logic on-chain (merkle root of partner shares + claim instruction)

The memo system works now and is fully auditable. On-chain distribution is an optimization for when the partner count justifies it.
