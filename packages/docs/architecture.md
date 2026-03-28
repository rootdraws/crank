# crankbot.md
# CrankBot — Full Context Document
# For Cursor Claude: read this entire file before writing a single line of code.

---

## PART 1 — WHAT WE ARE BUILDING

### The Product

CrankBot is a Telegram trading bot that lets users open single-sided DLMM (Discrete Liquidity Market Maker) positions on Meteora via chat commands. It is the first Telegram bot to offer ranged limit orders with yield — a fundamentally different primitive from every existing Solana trading bot (Trojan, Bonkbot, Maestro) which all execute simple swaps.

**The core user experience:**
```
User: /crankbuy SOL 85-95 USDC 4000
Bot:  ✅ Position opened — BUY SOL/USDC
      $85.00 ──[████████████████████]── $95.00
      Current price: $97.43 (above range, waiting)
      APR: 21.4% (LP fees: 9.2% + Emissions: 12.2%)
      Deposited: 4,000 USDC

[price drops to $91]

Bot:  📊 8/20 bins filled · SOL/USDC buy
      16.4 SOL harvested → your wallet
      0.008 SOL in LP fees earned
```

The user sets a range, walks away, gets push notifications as fills happen. The protocol automatically harvests filled bins and sends tokens to the user's custodial wallet. No other bot does this.

### The Protocol Stack

CrankBot sits on top of three deployed on-chain programs:

**1. `bin_farm` (crank.money core) — `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia`**
- Wraps Meteora DLMM with custody + auto-harvest capability
- Vault PDA owns the Meteora position; user signs deposit once, bot harvests permissionlessly
- Key instructions: `open_position_v2`, `harvest_bins`, `close_position`, `user_close`, `claim_fees`
- Fee: 30bps (0.3%) on harvested output only — charged on conversion, not deposit
- All fees route to `rover_authority` ATAs → `sweep_rover` → 50/50 split

**2. `monke_bananas` — `myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH`**
- Revenue share program: burn $CRANK against SMB Gen2/Gen3/Goose NFTs to earn protocol fees
- MasterChef-style pull-based accumulator: `feed_monke` increments weight, `claim_pegged` pulls $PEGGED
- 50% of all protocol fees flow here pro-rata by burn weight

**3. `pegged_bridge` — `7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN`**
- Stakes SOL from sweep into Sanctum SPL stake pool → mints $crankSOL (PEGGED) → forwards to dist_pool
- PEGGED = crankSOL LST backed by Helius + MonkeDAO + LP Army validators

### Revenue Flow

```
User opens position via CrankBot
→ bins fill → harvest_bins (bot or permissionless keeper)
→ 0.3% fee on output → rover_authority ATAs
→ sweep_rover (Saturday keeper): 50% bridge_vault, 50% bot (Config.bot = Root's keypair)
→ stake_and_forward: bridge_vault SOL → Sanctum → $PEGGED → dist_pool ATA
→ deposit_pegged: dist_pool ATA → program_vault ATA (updates accumulator)
→ Burners call claim_pegged: program_vault → their wallet (pro-rata by burn weight)
```

### The Token Economics

- **$CRANK** — `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` — burn token (6 decimals)
- **$PEGGED** — crankSOL LST — yield-bearing emissions token
- Root holds ~50% of CRANK supply, ~96.5% of burn weight → dominant protocol revenue claimant
- Burn CRANK → get vote weight → direct 50% of protocol fees to pools you choose
- Vote weight is permanent (irreversible burn), snapshots taken weekly

### The Incentive Model (Epoch-Based Emissions)

```
Protocol revenue split:
  50% → Burner pool (pro-rata by MonkeBurn.share_weight, existing MasterChef)
  50% → Pool emissions (directed by burner vote weight each epoch)

Epoch mechanics:
  - Votes persist until changed (not weekly reset)
  - Saturday keeper snapshots current vote weights
  - Computes pool emissions: pool_share = (pool_vote_weight / total_vote_weight) × 50% revenue
  - Traders in covered pools earn from their pool's emission slice
  - Trader share = their epoch harvest volume / pool total harvest volume
  - Paid in $PEGGED, claimable anytime after epoch settlement (merkle proof)

Pool coverage:
  - Root curates the approved pool list (LaserStream capacity constraint)
  - Burners vote emissions toward pools within approved list
  - Communities wanting coverage: burn CRANK, vote for their pool, generate volume
```

### The Existing Infrastructure

**The harvester bot already exists and runs in production.** It uses:
- Helius LaserStream gRPC (`$999/mo Professional plan`) for real-time price monitoring
- `GeyserSubscriber` — watches lb_pair accounts for active bin changes
- `HarvestExecutor` — job queue, executes `harvest_bins` and `close_position`
- `MonkeKeeper` — Saturday sequencer (unwrap WSOL → sweep → stake → open fee rovers → deposit → cleanup)
- `RelayServer` — WebSocket + REST relay exposing bot state to the frontend
- Event emitter: `harvestExecuted`, `positionClosed` events already fire

**The frontend already has working position open/close.** `app.js` contains:
- Complete `resolveMeteoraCPIAccounts()` — resolves all 18 accounts for `open_position_v2`
- `getMeteoraPosiitonPDA()` — reads `position_counter` on-chain, derives PDA (critical: uses current count before increment)
- `ensureBinArraysExist()` — initializes missing bin arrays
- `ensureAccountsSetup()` — idempotent ATA creation preflight
- `parseLbPairFull()` — reads LbPair account, extracts mints/reserves/token program flags
- `confirmAndCheck()` — confirms tx AND checks for on-chain errors
- `buildWrapSolIxs()` — SOL wrapping for native deposits
- All PDA derivations: `getConfigPDA`, `getPositionPDA`, `getVaultPDA`, `getRoverAuthorityPDA`, etc.
- Codama-generated instruction builders: `getOpenPositionV2InstructionAsync`, `getUserCloseInstructionAsync`, `getHarvestBinsInstructionAsync`, `getClaimFeesInstruction`

**The only missing piece is the Telegram interface and custodial wallet layer.**

---

## PART 2 — WHAT MUST BE BUILT

### Architecture

```
crankbot/
├── packages/
│   ├── core-sdk/           ← extracted from frontend app.js (mostly copy-paste)
│   │   ├── constants.ts    ← program IDs, token mints, program addresses
│   │   ├── pda.ts          ← all PDA derivation functions
│   │   ├── math.ts         ← binToPrice, priceToBin, calculateFee
│   │   ├── meteora.ts      ← resolveMeteoraCPIAccounts, parseLbPairFull
│   │   ├── transactions.ts ← ensureBinArraysExist, ensureAccountsSetup, confirmAndCheck
│   │   └── index.ts        ← re-exports everything
│   │
│   └── telegram-bot/
│       ├── src/
│       │   ├── index.ts           ← entry point, wires everything together
│       │   ├── signer.ts          ← 10 lines: keypair replaces Phantom SDK
│       │   ├── wallet-service.ts  ← custodial keypair management (the new core piece)
│       │   ├── commands.ts        ← /start /crankbuy /cranksell /positions /balance /withdraw /vote /myemissions /claim
│       │   ├── position-builder.ts ← thin wrapper calling core-sdk with custodial keypair
│       │   ├── notifier.ts        ← wires HarvestExecutor events → Telegram push notifications
│       │   ├── renderer.ts        ← ASCII position visualization
│       │   └── db.ts              ← sqlite/postgres: users, positions, votes, harvests
│       ├── package.json
│       └── tsconfig.json
│
├── package.json    ← workspace root
└── .env.example
```

### Build Priority Order

```
Phase 1 — Core (nothing else matters until this works):
  1. core-sdk extraction (copy-paste from app.js, add TypeScript types)
  2. wallet-service.ts (keypair gen, encrypt, store, reverse lookup)
  3. signer.ts (10 lines)
  4. /start command (creates wallet, returns deposit address)
  5. /balance command
  6. /crankbuy command (calls core-sdk, signs with custodial keypair)
  7. /cranksell command
  8. /positions command (ASCII renderer)
  9. notifier.ts (harvest/close events → Telegram push)
  10. /withdraw command

Phase 2 — Emissions:
  11. db.ts vote storage
  12. /vote command
  13. Saturday keeper extension (vote tally → pool emission weights)
  14. APR display on position open
  15. /myemissions command
  16. /claim command (merkle proof)

Phase 3 — Community:
  17. Approved pool list management
  18. Referral tracking
  19. Trial system
```

### Critical Implementation Details

#### The position_counter Race Condition
Two simultaneous `/crankbuy` commands from same user on same pool will both read `count=0`, derive the same PDA, one fails. Solution: per-user mutex using in-memory Map<userId, Promise> or Redis lock. Lock before reading counter, release after tx confirms.

```typescript
const userLocks = new Map<string, Promise<void>>();

async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = userLocks.get(userId) ?? Promise.resolve();
  let resolve!: () => void;
  const next = new Promise<void>(r => resolve = r);
  userLocks.set(userId, prev.then(() => next));
  await prev;
  try { return await fn(); }
  finally { resolve(); }
}
```

#### The position_counter Read (MOST CRITICAL)
From app.js — the exact counter read logic:
```typescript
const [counterPDA] = getPositionCounterPDA(user, lbPairPubkey);
let posCounter = 0;
try {
  const counterInfo = await conn.getAccountInfo(counterPDA);
  if (counterInfo && counterInfo.data.length >= 16) {
    posCounter = Number(new DataView(
      counterInfo.data.buffer, counterInfo.data.byteOffset
    ).getBigUint64(8, true)); // offset 8 = after 8-byte discriminator
  }
} catch { /* counter doesn't exist yet — first position, count = 0 */ }
// Then derive: getMeteoraPosiitonPDA(user, lbPair, posCounter)
```

#### Vault ATA Pre-creation
Vault token X and Y ATAs must exist before `open_position_v2`. They are owned by the vault PDA (off-curve). Create them in the setup tx using `createAssociatedTokenAccountIdempotentInstruction` with `allowOwnerOffCurve = true`.

#### Bin Array Pre-initialization
If bin arrays for the position range don't exist, `open_position_v2` fails. Always run `ensureBinArraysExist` before the main tx. If any init instructions are returned, send them in a separate setup tx first.

#### Token-2022 Support
The bot MUST handle Token-2022 pools. `parseLbPairFull` reads `tokenXProgramFlag` and `tokenYProgramFlag` from LbPair bytes at offsets 880 and 881. Flag=0 → SPL Token, Flag=1 → Token-2022. Pass correct program ID to `getAssociatedTokenAddressSync` and to `createAssociatedTokenAccountIdempotentInstruction`.

#### The Two-Transaction Pattern (from app.js)
```
TX 1 (setup): ATA creation + bin array init + SOL wrapping (standard SPL ops only)
TX 2 (execute): compute budget + single program instruction only

WHY: Reduces Blowfish/wallet risk scoring on TX 2.
     Keeps compute budget for the actual instruction.
     ATAs that already exist don't fail (idempotent create).
```
For custodial bot: both txs signed by `userKeypair`. Bot pays rent for ATAs.

#### The LP Position ALT
The frontend uses a Pool Address Lookup Table (`CONFIG.POOL_ALT`) to compress the v0 transaction. For the Telegram bot, check if the same ALT applies, or use a legacy transaction instead (simpler, adequate for now, can upgrade later).

---

## PART 3 — SOURCE MATERIAL

### Repositories to Clone / Reference

```bash
# Meteora DLMM SDK (read-only for getActiveBin, pool data, bin state)
npm install @meteora-ag/dlmm @coral-xyz/anchor @solana/web3.js

# Telegram bot framework (use grammy, NOT node-telegram-bot-api)
npm install grammy

# Encryption (custodial wallet security)
npm install @aws-sdk/client-kms  # if using AWS KMS
# or:
npm install node-forge            # for local AES-256-GCM (dev only)

# Database
npm install better-sqlite3        # for local dev
npm install @types/better-sqlite3

# Existing bot (the harvester — connect to this, don't rebuild it)
# Location: the existing anchor-harvest-bot.ts monorepo
# The Telegram bot IMPORTS from HarvestExecutor's EventEmitter
```

### Program Addresses (Mainnet)

```typescript
// Core
BIN_FARM_PROGRAM_ID   = '8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia'
MONKE_BANANAS_ID      = 'myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH'
PEGGED_BRIDGE_ID      = '7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN'

// Meteora
METEORA_DLMM_PROGRAM  = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'

// SPL
SPL_MEMO_PROGRAM_ID   = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
TOKEN_PROGRAM_ID      = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
ASSOCIATED_TOKEN_PID  = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
NATIVE_MINT           = 'So11111111111111111111111111111111111111112'

// Tokens
CRANK_MINT            = 'Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump'

// Collections (for monke_bananas)
SMB_GEN2_COLLECTION   = 'SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W'
SMB_GEN3_COLLECTION   = '8Rt3Ayqth4DAiPnW9MDFi63TiQJHmohfTWLMQFHi4KZH'
GOOSE_PIXEL_COLLECTION = '6ubyyuUz3EVFwZrBh3C2ezSXXfyjxP4jhemLPyGgdL6Y'
```

### LbPair Account Layout (verified, 904 bytes)
```
offset  size  field
8       4     active_id (i32) ← READ THIS for current price
80      2     bin_step (u16)
88      32    token_x_mint
120     32    token_y_mint
152     32    reserve_x
184     32    reserve_y
880     1     token_x_program_flag (0=SPL, 1=Token2022)
881     1     token_y_program_flag
```

### Codama-Generated Clients
The frontend uses Codama clients from `../src/generated/`. The Telegram bot needs the same clients. Either:
1. Copy the generated files from the frontend repo into `packages/core-sdk/generated/`
2. Or regenerate from IDL using `npx @codama/cli generate`

Key imports needed:
```typescript
import {
  getOpenPositionV2InstructionAsync,
  getUserCloseInstructionAsync,
  getClaimFeesInstruction,
  getHarvestBinsInstructionAsync,
  decodePosition, decodeConfig,
  BIN_FARM_PROGRAM_ADDRESS, Side,
} from './generated/bin-farm/index.js';
```

---

## PART 4 — CLAUDE.MD (For Cursor Claude)

### Who You Are Working For

Root — DeFi protocol builder. Operator of crank.money on Solana. Holds ~50% of $CRANK supply. Runs the harvester bot in production. Builds toward full protocol independence. High-context, terse communication style.

### What Already Exists (Do Not Rebuild)

1. **The harvester bot** (`anchor-harvest-bot.ts` + modules) — live in production, handles harvest/close/keeper. DO NOT TOUCH IT. You are extending it.

2. **The frontend** (`app.js`) — has working position open/close via Phantom wallet. All the hard account resolution work is done here. EXTRACT IT, don't rewrite it.

3. **The on-chain programs** — deployed and working. You are building a client, not modifying programs.

### The One Thing That Changes

The frontend uses `phantomSDK.solana.signAndSendTransaction(vtx)`.
The Telegram bot uses `vtx.sign([userKeypair])` + `connection.sendRawTransaction(vtx.serialize())`.

That is literally the only architectural difference. Everything else is the same code.

### Key Patterns From the Frontend (Use These Verbatim)

**Account resolution:**
```typescript
// resolveMeteoraCPIAccounts is the gold standard.
// It reads LbPair on-chain, derives all 18 accounts correctly.
// Copy it from app.js. Do not rewrite it.
const cpi = await resolveMeteoraCPIAccounts(poolAddress, minBinId, maxBinId);
```

**Counter read (CRITICAL — get this wrong and everything fails):**
```typescript
// position_counter.count is the CURRENT count (before this open).
// The on-chain program uses count.to_le_bytes() as PDA seed.
// After open, count becomes count+1 for the NEXT position.
const counterInfo = await conn.getAccountInfo(counterPDA);
const posCounter = counterInfo?.data.length >= 16
  ? Number(new DataView(counterInfo.data.buffer, counterInfo.data.byteOffset).getBigUint64(8, true))
  : 0;
const [meteoraPositionPDA] = getMeteoraPosiitonPDA(user, lbPairPubkey, posCounter);
```

**Two-tx pattern (always follow this):**
```
TX 1: ensureAccountsSetup() — ATAs + bin arrays + SOL wrap
TX 2: compute budget + single instruction
```

**Contiguous bin enforcement (harvest_bins):**
The on-chain program requires: `(to_bin - from_bin + 1) == bin_ids.len()`. Non-contiguous bin_ids will revert. Always expand to full contiguous range when gaps detected.

### Security Requirements (Non-Negotiable)

1. **Custodial keypairs must be encrypted at rest.** Use AES-256-GCM minimum. Key must not live in same process as encrypted data in production. Use AWS KMS or equivalent.

2. **Never log private keys.** Audit every logger.info/error call.

3. **Per-user mutex on position opens.** Two concurrent opens from same user on same pool will corrupt the counter PDA derivation.

4. **Reverse lookup table.** owner_pubkey → telegram_user_id must exist in DB from day one. The executor emits `data.owner` and the notifier needs to find the Telegram user from it.

5. **Vault ATAs are off-curve.** Pass `allowOwnerOffCurve = true` to all ATA functions for vault PDA owners.

### Bot Commands to Implement

```
/start          → create custodial wallet, return deposit address
/balance        → show custodial wallet token balances
/crankbuy TOKEN_OR_POOL LOW_PCT-HIGH_PCT QUOTE AMOUNT
                → open buy-side DLMM position
                → example: /crankbuy SOL 5-15 USDC 1000
/cranksell TOKEN_OR_POOL LOW_PCT-HIGH_PCT QUOTE AMOUNT
                → open sell-side DLMM position
/positions      → list open positions with ASCII fill bars
/close POSITION_ID → user_close on specific position
/withdraw TOKEN AMOUNT ADDRESS → sweep to external wallet
/vote POOL_1:PCT POOL_2:PCT → allocate vote weight to pools
/myemissions    → show claimable $PEGGED per pool per epoch
/claim          → claim all pending emissions
```

### Command Parsing

`/crankbuy SOL 5-15 USDC 1000` means:
- Token: SOL (resolve to SOL mint)
- Range: 5% to 15% BELOW current price (buy side)
- Quote: USDC (the token being deposited)
- Amount: 1000 USDC

Internally:
```typescript
const nearPrice = currentPrice * (1 - nearPct / 100);
const farPrice  = currentPrice * (1 - farPct / 100);
const minBin = priceToBin(Math.min(nearPrice, farPrice), binStep, decimalsX, decimalsY);
const maxBin = priceToBin(Math.max(nearPrice, farPrice), binStep, decimalsX, decimalsY, false);
// Validate: for buy side, maxBin must be < activeBin
```

`/cranksell TOKEN 5-20 SOL 500` means:
- Range: 5% to 20% ABOVE current price (sell side)
- Depositing 500 TOKEN
- minBin must be > activeBin

### The ASCII Position Renderer

```
SOL/USDC · BUY · $85–$95

$85  [▓▓▓▓▓▓▓▓░░░░░░░░░░░░]  $95
     [===filled===|=waiting=]
                 ^$91.20

Filled:    8/20 bins  (40%)
Harvested: 16.4 SOL
LP fees:   0.008 SOL
APR:       21.4% (LP 9.2% + Emissions 12.2%)
```

Fill bar logic:
- Buy side: bins LEFT of active bin are filled (▓), bins right are waiting (░)
- Sell side: bins RIGHT of active bin are filled (▓), bins left are waiting (░)
- Width: 20 chars
- Price cursor: space-padded ^ at proportional position

### Notification Format

```typescript
// On harvestExecuted event from HarvestExecutor:
`📦 ${binCount} bins harvested
${poolName} · ${side}
${formattedAmount} → your wallet
Fees earned: ${formattedFees}
Total harvested: ${totalHarvested}`

// On positionClosed event:
`✅ Position fully closed
${poolName} · ${side}
Final proceeds: ${amount} → your wallet`
```

### Database Schema (Minimum Viable)

```sql
-- Users
CREATE TABLE users (
  telegram_id TEXT PRIMARY KEY,
  wallet_pubkey TEXT NOT NULL UNIQUE,
  encrypted_keypair TEXT NOT NULL,  -- AES-256-GCM encrypted
  created_at INTEGER NOT NULL
);

-- Positions (mirror of on-chain, for notifications)
CREATE TABLE positions (
  position_pda TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  wallet_pubkey TEXT NOT NULL,
  lb_pair TEXT NOT NULL,
  meteora_position TEXT NOT NULL,
  side TEXT NOT NULL,  -- 'Buy' | 'Sell'
  min_bin_id INTEGER NOT NULL,
  max_bin_id INTEGER NOT NULL,
  initial_amount TEXT NOT NULL,  -- store as string (bigint)
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

-- Votes (persistent, epoch-snapshotted)
CREATE TABLE votes (
  wallet_pubkey TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  allocation_pct INTEGER NOT NULL,  -- 0-100, must sum to 100 per wallet
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (wallet_pubkey, pool_address)
);

-- Harvests (for epoch emission calculations)
CREATE TABLE harvests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_pda TEXT NOT NULL,
  wallet_pubkey TEXT NOT NULL,
  lb_pair TEXT NOT NULL,
  amount_out TEXT NOT NULL,
  fee_taken TEXT NOT NULL,
  tx_sig TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

### Integration With Existing Harvester Bot

The Telegram bot runs **in the same process** as the harvester. It imports from `HarvestExecutor` directly:

```typescript
// In the main bot orchestrator:
import { HarvestBot } from './anchor-harvest-bot';
import { TelegramBot } from './telegram-bot/src/index';

// HarvestBot exposes its executor:
const telegramBot = new TelegramBot({
  executor: harvestBot.executor,      // for event subscriptions
  subscriber: harvestBot.subscriber,  // for position registry reads
  connection: harvestBot.connection,
  coreProgram: harvestBot.coreProgram,
  coreProgramId: CORE_PROGRAM_ID,
});

// Wire events:
harvestBot.executor.on('harvestExecuted', (data) => {
  telegramBot.notifier.onHarvestExecuted(data);
});
harvestBot.executor.on('positionClosed', (data) => {
  telegramBot.notifier.onPositionClosed(data);
});
```

---

## PART 5 — BUILD INSTRUCTIONS

### Step 1: Set Up Monorepo

```bash
cd crankbot
npm install  # installs workspaces

cd packages/core-sdk
npm install

cd packages/telegram-bot
npm install
```

### Step 2: Copy Core SDK From Frontend

Open the existing `app.js` frontend file. Copy these functions into the corresponding `core-sdk/` files:

**→ `constants.ts`**: All `const` declarations at top of app.js
**→ `pda.ts`**: All functions named `get*PDA()`
**→ `math.ts`**: `binToPrice`, `priceToBin`, `formatPrice`, `calculateFee`, `calculateAmounts`
**→ `meteora.ts`**: `resolveMeteoraCPIAccounts`, `parseLbPairFull`, `parseLbPair`, `deriveBinArrayPDA`, `deriveEventAuthorityPDA`, `deriveBitmapExtPDA`, `binIdToBinArrayIndex`
**→ `transactions.ts`**: `ensureBinArraysExist`, `ensureAccountsSetup`, `confirmAndCheck`, `buildWrapSolIxs`, `buildSystemTransferIx`, `createSyncNativeIx`, `createAssociatedTokenAccountIx`, `buildInitBinArrayIx`, `makeComputeUnitPriceIx`, `kitIxToWeb3`, `asSigner`

Convert from vanilla JS to TypeScript. Add types. Remove browser-specific code (`window`, `document`, Phantom SDK references).

### Step 3: Copy Generated Codama Clients

Copy `src/generated/bin-farm/` and `src/generated/monke-bananas/` from the frontend repo into `packages/core-sdk/generated/`. These are the instruction builders.

### Step 4: Implement wallet-service.ts

See starter file in this repo. Key requirements:
- AES-256-GCM encryption with key from `WALLET_ENCRYPTION_KEY` env var
- SQLite backend (better-sqlite3, sync API is fine for bot scale)
- Bidirectional lookup: telegram_id → keypair, owner_pubkey → telegram_id

### Step 5: Implement signer.ts

See starter file. This is 10 lines. The entire "port from Phantom to bot" lives here.

### Step 6: Implement commands.ts

See starter file for command stubs. Each command:
1. Gets user's custodial keypair from wallet-service
2. Calls core-sdk functions to build transactions
3. Uses signer.ts to sign and send
4. Updates DB
5. Returns formatted response

### Step 7: Wire Into Harvester Bot

In `anchor-harvest-bot.ts`:
```typescript
if (process.env.TELEGRAM_BOT_TOKEN) {
  const telegramBot = new TelegramBot({ executor, subscriber, connection, coreProgram, coreProgramId });
  await telegramBot.start();
}
```

### Step 8: Test Sequence

```
1. /start → verify wallet created, address valid
2. Send 0.01 SOL to deposit address
3. /balance → verify balance shows
4. /crankbuy SOL 5-10 USDC 0.001 → verify tx succeeds on devnet first
5. /positions → verify ASCII display
6. Wait for price to move / simulate harvest
7. Verify push notification fires
8. /withdraw → verify sweep works
```

### Environment Variables Required

```env
# Telegram
TELEGRAM_BOT_TOKEN=

# Solana
RPC_URL=
HELIUS_RPC_URL=  # private RPC for bot transactions
GRPC_ENDPOINT=   # Helius LaserStream endpoint

# Programs
CORE_PROGRAM_ID=8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia
MONKE_BANANAS_PROGRAM_ID=myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH

# Bot keypair (same as existing harvester bot)
BOT_KEYPAIR_PATH=  # path to JSON keypair file
# OR
BOT_PRIVATE_KEY=   # base58 encoded

# Custodial wallet encryption (NEVER LOG THIS)
WALLET_ENCRYPTION_KEY=  # 32-byte hex key for AES-256-GCM

# Tokens
CRANK_MINT=Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump
PEGGED_MINT=  # crankSOL mint

# Optional
POOL_ALT=      # Address Lookup Table for v0 transactions
IDL_DIR=./idl  # path to IDL JSON files
LOG_LEVEL=info
DB_PATH=./data/crankbot.db
```

### Priority Pools for Launch (Tier 1 — Always Covered)

```
CRANK/SOL    ← protocol's own token
SOL/USDC     ← highest volume on Meteora
BTC/SOL      ← blue chip
```

These three are hardcoded into the approved pool list. All other pools require vote weight to earn coverage.

---

## APPENDIX: Key Gotchas

1. **`getMeteoraPosiitonPDA` has a typo** (double 'i' in 'Position') — it's in the original app.js, keep the same name for consistency but note it.

2. **Bitmap ext PDA** — if the bitmap extension account doesn't exist, pass the DLMM program ID as a placeholder (not writable). If it exists, it must be writable. The app.js `resolveMeteoraCPIAccounts` handles this correctly.

3. **Side determination** — the contract determines side from on-chain `active_id`, NOT the caller's input. `side` param in `open_position_v2` is still required but the contract re-derives it. Your bin range validation must match: buy = all bins below active_id, sell = all bins above active_id.

4. **Bin width limit** — maximum 70 bins per position (`MAX_POSITION_WIDTH`). Validate before submitting. Error message should tell user the max price spread in % terms.

5. **Minimum deposit** — `MIN_POSITION_AMOUNT = 10_000` (base units). For SOL this is 0.00001 SOL (basically nothing). For USDC with 6 decimals this is 0.01 USDC. Always validate.

6. **LP fees vs harvest fees** — the 0.3% protocol fee applies to `harvest_bins` output (delta-based). LP trading fees (earned from bin spread) are separate and claimed via `claim_fees`. On `close_position`, the 0.3% fee applies to the full vault balance including accrued LP fees (the contract notes this explicitly). Users who want fee-free LP fee withdrawal should call `claim_fees` before closing.

7. **crankSOL/PEGGED decimal** — check the actual mint decimals. Don't assume 9.

8. **`harvest_bins` is NOT paused by `config.paused`** — intentional. Harvests must always work to protect existing positions. Only `open_position_v2` is gated by pause.
