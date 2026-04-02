# packages/core-sdk — shared SDK for crank.money bot commands

Platform-agnostic TypeScript SDK consumed by the Discord bot (and future Telegram bot). Provides all the building blocks for trading, wallet management, and on-chain interaction. Imported as `@crankbot/core-sdk` via npm workspaces.

## Files

| File | What it does |
|------|-------------|
| `constants.ts` | All program IDs (5 programs + Meteora DLMM), token mints (CRANK, BANK, USDC), LbPair byte layout offsets, protocol constants. SOURCE OF TRUTH. |
| `pda.ts` | PDA derivation for all 5 programs + Meteora + Metaplex. Seeds match on-chain exactly. |
| `math.ts` | `binToPrice`, `priceToBin`, `percentRangeToBins`, `formatPrice`, `formatAmount`, fee calculations. |
| `meteora.ts` | `parseLbPairData` (raw 904-byte parsing), `parseLbPairFull` (RPC fetch + parse), `resolveMeteoraCPIAccounts` (builds all 18 accounts for open_position_v2), `deriveATA`. |
| `pool-config.ts` | `PoolConfig` type, `loadPoolRegistry()` (pools for routing), `loadGauges()` (one gauge per pair for voting). Reads `curator.json` at runtime. Cached. |
| `range-parser.ts` | `parseRangeInput` (price/mcap/pct endpoint parsing), `rangeInputToPrice` (converts to dollar price), `parseCommand` (full command string parsing). |
| `pool-router.ts` | `routeCommand` — multi-pool routing with `quoteTokenUsdPrice` param for non-USD quote pools (CRANK/SOL). Tries all candidate pools, picks fewest positions with lowest binStep tiebreaker. Auto-splits up to 5 positions. |
| `price-source.ts` | `fetchDexScreenerPrice` — SOL price from Pyth Hermes oracle (not DexScreener). Other tokens from DexScreener with stablecoin pair preference + symbol consensus filter. 10s per-mint cache. |
| `transactions.ts` | `buildPriorityFeeIxs`, `ensureBinArraysExist`, `buildSetupTx` (ATA creation, 800K CU for bin array init), `buildWrapSolIxs`, `confirmAndCheck`, `kitIxToWeb3` / `asSigner` (Codama adapter shims). |
| `wallet-service.ts` | `WalletService` class — custodial keypair management with AES-256-GCM encryption, JSON file store, position/vote/harvest tracking, bidirectional pubkey-userId index, withdraw address lock (`setWithdrawAddress`/`getWithdrawAddress` — called by deposit-detect, not user-facing), harvest totals (`getHarvestedTotal`). `withUserLock` per-user mutex. |
| `signer.ts` | `signAndSend` (versioned tx) and `signAndSendLegacy` (legacy tx) — keypair-based signing with confirmation. |
| `index.ts` | Re-exports everything. |

## How it's consumed

```
packages/discord-bot/  →  import { ... } from '@crankbot/core-sdk'
bot/anchor-harvest-bot.ts  →  import('../packages/discord-bot/src/index')  →  core-sdk
```

Resolved via npm workspaces (root `package.json` has `"workspaces": ["packages/core-sdk", "packages/discord-bot"]`). Run via `tsx` — no build step, imports TypeScript source directly.

## Key flows

**Opening a position (/buy, /sell):**
`parseCommand` → `loadPoolRegistry` → `routeCommand` → `resolveMeteoraCPIAccounts` → `buildSetupTx` → `signAndSendLegacy` → build open_position_v2 ix → `signAndSend`

**Burning CRANK (/burn):**
`getOrCreate` (wallet) → `getBankConfigPDA` → `deriveATA` (CRANK + BANK) → `buildSetupTx` → raw `burn_and_mint` ix → `signAndSend`

## Token programs

| Token | Program | Decimals |
|-------|---------|----------|
| CRANK | Token-2022 | 6 |
| BANK | SPL Token | 6 |
| USDC | SPL Token | 6 |

This matters for ATA derivation, transfer instructions, and withdraw — always pass the correct token program.
