# monke.army

**Limit orders that earn fees, instead of paying them.** Sell the rips. Buy the dips. Monke's Harvester protects your position against round-trip loss.

Managed Meteora DLMM positions with sub-second bin harvesting via Helius LaserStream and NFT revenue sharing (SMB Gen2/Gen3 + GooseDAO pixel geese) on Solana.

## Programs

| Program | Description |
|---------|-------------|
| `core.rs` (bin_farm) | Position management. Open, harvest, close. All CPI via V2 variants (Token-2022 native). Performance fee on converted output — all fees → rover_authority → `sweep_rover` splits 60/40 (bridge_vault + Config.bot). TOKEN fees → rover_authority (BidAskImBalanced DLMM recycling, no market dump). Permissionless fallback on harvest + close (heartbeat + staleness). Rovers use BidAskImBalanced distribution. Emergency escape hatch for deprecated pools. |
| `monke_bananas.rs` | Feed BANANAS to your Monke (or Goose). Burn $BANANAS (1M per tx, unlimited stacking) against SMB Gen2, Gen3, or gooseswtf pixel goose NFTs — all 1x weight. gooseswtf requires GooseDAO Core membership on first feed only (once in, always in). MasterChef accumulator distributes $PEGGED to all fed NFT holders. `deposit_pegged` / `claim_pegged` for token-based distribution. `compost_monke`: permissionless cleanup of burned NFTs. |
| `pegged_bridge.rs` | SOL → $PEGGED bridge. Single permissionless crank: `stake_and_forward` deposits SOL into the MonkeDAO SPL stake pool, receives $PEGGED, forwards it to the dist_pool ATA on monke_bananas. |

## How It Works

Users deposit single-sided liquidity into Meteora DLMM bins via the core program — sell the rips (tokens above price) or buy the dips (SOL below price). A vault PDA owns the Meteora position on behalf of the user. As price moves through bins, Monke's Harvester detects fully-converted bins in sub-second via Helius LaserStream gRPC and calls `harvest_bins` to withdraw them. Tokens flow Meteora → vault ATA → owner wallet in a single instruction.

Performance fee (0.3%) is taken on converted output only. All fees flow through rover_authority. `sweep_rover` splits 60/40: half to bridge_vault (→ $PEGGED for monke holders), half to `Config.bot` (operations). Hardcoded on-chain. The bridge vault's SOL is staked to the MonkeDAO validator via `stake_and_forward`, minting $PEGGED — a yield-bearing LST that appreciates each epoch. TOKEN fees route to rover_authority for BidAskImBalanced DLMM recycling — no market dumping on thin meme pools. Unconverted deposits return untaxed.

### Key Instructions

```
open_position_v2(pool, amount, min_bin, max_bin, side, max_active_bin_slippage)
  → No fee. 100% deposited into Meteora bins.
  → `side` is derived on-chain from active_id (parameter ignored).
  → Token-2022 native. All CPI via V2 variants.

harvest_bins(bin_ids: Vec<i32>)
  → SOL fees → rover_authority → sweep_rover → 60% bridge_vault (→ $PEGGED) + 40% bot. TOKEN fees → rover_authority (DLMM recycling)
  → Remainder → owner. Position stays open.
  → Permissionless fallback: anyone can call when bot is stale,
    earns a keeper tip from the fee.

close_position()
  → Same fee mechanic + permissionless fallback.
  → Meteora position closed, rent refunded to owner.

user_close()
  → User-initiated close. Same fee. No free exits.

feed_monke(nft_mint)
  → Burn 1M $BANANAS, assigned to an SMB Gen2 or Gen3 NFT you hold.
  → All collections = +1 weight per feed. Burns stack. No cap.

feed_goose(goose_nft_mint)
  → Burn 1M $BANANAS, assigned to a gooseswtf pixel goose NFT you hold.
  → Requires GooseDAO Core membership on first feed only (once in, always in).
  → +1 weight per feed. Same MasterChef accumulator as monkes.
  → On subsequent feeds, GooseDAO membership is not re-checked.

compost_monke()
  → Permissionless. Clean up MonkeBurn PDA for burned NFTs (supply == 0).
  → Subtracts dead weight. Rent refund to caller.

open_rover_position(amount, bin_step)
  → Deposit tokens into sell-side BidAskImBalanced DLMM position.
  → active_id read from on-chain lb_pair (never trust caller).
  → Position owned by rover_authority PDA. One-way. No refunds.

open_fee_rover(amount, bin_step)
  → Bot-gated. Opens BidAskImBalanced position from accumulated fee tokens
    in rover_authority ATAs. Bot pays rent.

sweep_rover()
  → Permissionless. SOL from rover_authority → 60% bridge_vault + 40% Config.bot (operations).

close_rover_token_account()
  → Permissionless. Closes any token account owned by rover_authority.
  → For WSOL: unwraps to native SOL on rover_authority (picked up by sweep_rover).
  → For empty ATAs: reclaims rent to rover_authority.

stake_and_forward()  [pegged_bridge]
  → Permissionless crank. bridge_vault SOL → SPL stake pool deposit
    → $PEGGED minted → dist_pool ATA (monke_bananas).

deposit_pegged()  [monke_bananas]
  → Permissionless. dist_pool $PEGGED → program_vault $PEGGED.
    Accumulator updated. Units shift from lamports to $PEGGED base units.

claim_pegged()  [monke_bananas]
  → Claim accrued $PEGGED from program_vault → user's $PEGGED ATA.
    Weight-proportional via MasterChef accumulator.
```

### Bin Detection Logic — Sell the Rips, Buy the Dips

```
SELL THE RIPS (token deposited above price → SOL output):
  Safe bins = bins where binId < activeId (price ripped above them)
  These hold Y (SOL). Harvest Y.

BUY THE DIPS (SOL deposited below price → token output):
  Safe bins = bins where binId > activeId (price dipped below them)
  These hold X (token). Harvest X.
```

## Project Structure

```
monke-army/
├── programs/                      # Anchor workspace (build targets)
│   ├── bin-farm/src/
│   │   ├── lib.rs                 # Core program (positions, harvest, close, fees, rovers)
│   │   └── meteora_dlmm_cpi.rs   # Meteora DLMM CPI wrappers (V2 only)
│   ├── monke-bananas/src/lib.rs   # Burn $BANANAS, stack weight, claim $PEGGED, compost dead monkes
│   └── pegged-bridge/src/lib.rs   # SOL → $PEGGED bridge (stake_and_forward via SPL stake pool)
├── src/
│   └── generated/                 # Codama-generated TypeScript clients (bin-farm + monke-bananas + pegged-bridge)
├── bot/                           # Monke's Harvester (off-chain infrastructure)
│   ├── anchor-harvest-bot.ts      # Orchestrator + health endpoint + relay wiring
│   ├── geyser-subscriber.ts       # Helius LaserStream gRPC — sub-second bin detection
│   ├── relay-server.ts            # WebSocket + REST relay for frontend (/ws + /api/*)
│   ├── meteora-accounts.ts        # Shared Meteora CPI account resolution + DLMM cache
│   ├── harvest-executor.ts        # Job queue: harvest/close tx (emits events to relay)
│   ├── keeper.ts                  # MonkeKeeper: Saturday sequencer (incl. stake_and_forward + deposit_pegged)
│   ├── retry.ts                   # Shared withRetry (exponential backoff, 3 retries)
│   └── logger.ts                  # Pino structured logging
├── public/                        # Frontend: Trade / Positions / Rank / Ops / Recon
│   ├── index.html                 # Navigation sigil astrolabe + all page layouts
│   ├── styles.css                 # Military monke color palette + all page styles
│   ├── app.js                     # Page logic, relay WebSocket client, Codama instruction builders
│   ├── config.json                # Program IDs, RPC, BOT_RELAY_URL (gitignored — see config.example.json)
│   └── config.example.json        # Template for config.json (no API keys)
├── scripts/
│   ├── deploy-and-init.mjs        # Deploy + init programs atomically (anti-front-run)
│   ├── build-frontend.mjs         # Frontend build: bundle app.js (Codama + @solana/kit)
│   ├── generate-clients.mjs       # Codama client generation from IDL → src/generated/
│   ├── init-bridge.ts             # Initialize pegged_bridge program on-chain
│   ├── set-pegged-and-redirect.ts # set_pegged_mint + propose_revenue_dest (bridge_vault)
│   ├── preflight-check.ts         # Pre-deployment verification of all programs, PDAs, ATAs
│   ├── test-close-position.ts     # Close a stuck position (mainnet)
│   └── recycle-fee-rover.ts       # Open fee rover from accumulated token fees
├── meteora-invent/                # Meteora DAMM v2 launch toolkit (cloned)
│   └── studio/config/damm_v2_config.jsonc  # $BANANAS pool + Alpha Vault config
├── Anchor.toml                    # Workspace config (3 programs, devnet + mainnet)
├── Cargo.toml                     # Workspace root
├── whitepaper.md                  # Product overview + mechanics
├── TODO.md                        # Task list
├── docs/
│   └── addressbook.md             # Pool discovery + address book reference (API, Phase 2)
└── ref/dlmm-sdk/                  # Cloned Meteora DLMM SDK (source of truth for CPI layouts)
```

## Build & Deploy

```bash
npm install

# Build program (Homebrew cargo doesn't support +toolchain — use rustup cargo)
PATH="$HOME/.cargo/bin:$PATH" cargo-build-sbf --manifest-path programs/bin-farm/Cargo.toml

# Deploy / upgrade (upgrade authority required)
solana program deploy target/deploy/bin_farm.so \
  --program-id 8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia \
  --url mainnet-beta

# First-time deploy + initialize atomically (prevents front-running)
BOT_PUBKEY=<bot-key> BANANAS_MINT=<mint> \
  node scripts/deploy-and-init.mjs --cluster mainnet

# Verify no one front-ran initialization
node scripts/deploy-and-init.mjs --verify-only
```

Note: `blake3` pinned to 1.5.5, `borsh` pinned to 1.5.5. If you `cargo update`, re-pin both:
```bash
cargo update -p blake3 --precise 1.5.5
cargo update -p borsh@1.6.0 --precise 1.5.5
```

### IDL & Client Generation

```bash
# Generate IDL from on-chain program structs (Anchor 0.31.1)
anchor idl build -p bin_farm -o bot/idl/bin_farm.json
anchor idl build -p monke_bananas -o bot/idl/monke_bananas.json
anchor idl build -p pegged_bridge -o bot/idl/pegged_bridge.json

# Generate Codama TypeScript clients from IDL
node scripts/generate-clients.mjs
# Output: src/generated/bin-farm/ + src/generated/monke-bananas/ + src/generated/pegged-bridge/
```

Regenerate after any on-chain struct change. IDL files at `bot/idl/` are used by the bot's Anchor client. Codama clients at `src/generated/` provide typed instruction builders and account decoders for the frontend (`app.js` imports them via esbuild bundling).

## Run Monke's Harvester

```bash
cp bot/anchor-harvest-bot.env.example bot/.env
# Edit bot/.env — set RPC_URL, GRPC_ENDPOINT, etc.
npm run bot
```

Sub-second harvest via LaserStream, permissionless fallback on all operations (harvest, close, sweep, stake_and_forward, deposit — anyone can crank when bot is stale and earn a tip), periodic fee sweeps, Saturday keeper sequence (unwrap → sweep → bridge → fee rovers → deposit_pegged → cleanup), adaptive intervals, health endpoint.

## Run Frontend

```bash
node scripts/build-frontend.mjs && npx serve dist   # local dev
node scripts/build-frontend.mjs                      # production (Vercel runs this)
```

Frontend pages: **Trade** (DLMM harvester — pool discovery via token CA search + Meteora trending feed + server-side address book, default SOL/USDC pool), **Positions** (all wallet positions with inline close + claim fees), **Rank** (monke feed/claim + leaderboard, sub-pages: Monke + Roster), **Ops** (bounty board + permissionless crank + live stats from relay), **Recon** (rover TVL — deferred). Sigil astrolabe navigation. Bot relay provides live data via WebSocket (`/ws`) and REST (`/api/*`) at `wss://bot.monke.army`.

## Mainnet Addresses

### Programs

| Program | Address |
|---------|---------|
| core (bin_farm) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` |
| monke_bananas | `myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH` |
| pegged_bridge | `7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN` |

### Tokens

| Item | Address |
|------|---------|
| $BANANAS Mint | `ABj8RJzGHxbLoB8JBea8kvBx626KwSfvbpce9xVfkK7w` |
| $PEGGED Mint (LST) | `GmqNKeVoKJiF52xRriHXsmmgvTWpkU4UVn2LdPgEiEX1` |
| SPL Stake Pool | `9tkzwSotpYFNWYg7ggunktSqcpykVzzPunsSoNwPacjg` |

### PDAs

| PDA | Address | Program |
|-----|---------|---------|
| Core Config | `MeTGCG86PTWhnN52yV9ie8oJkgfSLGyuRCFxhDd97i2` | core |
| Rover Authority | `56UrucGXHYPfsXS8BMZG82UA632fHDB1o6aXWwt9i6PR` | core |
| MonkeState | `6DZqJbD3rWzfySHyRASL5nMUsf5WroZvykdf256BNXMo` | monke_bananas |
| Dist Pool | `2uZxacLniw264zRpr84qGW4NcYkTv3M448733t6MRK1e` | monke_bananas |
| Program Vault | `6r63srLezrtjiYwwoVwMB82o3c7mwz3BUktGiHRq4FxX` | monke_bananas |
| Bridge Config | PDA `[b"bridge_config"]` | pegged_bridge |
| Bridge Vault | `B9gTfeCbN1oSXKCKgog5gGTH3VGNr3U5SYH4mL3gtqxK` | pegged_bridge |
| Bridge Vault $PEGGED ATA | `Ft1TzupfeAKMvYXg9GfcotK1VFTq2nqvJsq2XCYXpqKB` | pegged_bridge |
| Dist Pool $PEGGED ATA | `3NBqb4nRadQqe3wwffmwCwP4SLWA19jhxdm85ZhAjTMB` | monke_bananas |
| Program Vault $PEGGED ATA | `9ZsSHkbzziVwRLuR4uT9KAR6CVu1WoL23xk8rNvpyiXM` | monke_bananas |

### Launch Parameters

- **Init Price:** 0.000001 SOL/token (1 SOL = 1M BANANAS = 1 monke feed)
- **Alpha Vault:** Pro-rata, 420 SOL max buying cap, permissionless (closed)
- **Activation:** March 1, 2026 00:00 UTC (trading live)
- **Vesting:** Instant (1s after activation)
- **Fee Decay:** 69% → 1% over 3 hours (sniper tax)
- **Liquidity:** 100% permanently locked (DAMM v2 position NFT held by operator). Trading fees from the locked liquidity position are private to the operator — not part of the 60/40 protocol split.
- **Supply:** 1,000,000,000 BANANAS (6 decimals). Mint/freeze/update authorities revoked.

## NFT Integration — Feed Your Monke (or Goose)

Three eligible collections, all **1x weight per feed**:

| Collection | Address | Standard | Gate |
|------------|---------|----------|------|
| SMB Gen2 | `SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W` | Token Metadata (V1_NFT) | Hold NFT |
| SMB Gen3 | `8Rt3Ayqth4DAiPnW9MDFi63TiQJHmohfTWLMQFHi4KZH` | Token Metadata (V1_NFT) | Hold NFT |
| gooseswtf (pixel goose) | `6ubyyuUz3EVFwZrBh3C2ezSXXfyjxP4jhemLPyGgdL6Y` | Token Metadata (pNFT) | Hold NFT + GooseDAO membership (first feed only) |

**GooseDAO membership** is verified via a Metaplex Core asset from collection `XkH2QVN9AKNi1AGnaEYdEHCHxFjTjs8BdbTJfcRW2rY` (Core program `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d`). The membership check only runs on the first `feed_goose` call for a given pixel goose. Once a gooseswtf has a MonkeBurn PDA (`share_weight > 0`), subsequent feeds and claims work forever — even if the wallet later loses GooseDAO membership. **Once in, always in.**

- **Burn:** 1,000,000 $BANANAS per `feed_monke` / `feed_goose` call (6 decimals enforced at init)
- **Stacking:** Unlimited. Per-NFT `MonkeBurn` PDA tracks cumulative weight.
- **Revenue:** 60% of protocol fees are converted to $PEGGED and distributed to all fed NFT holders. 40% funds bot operations.
- **Claiming:** Weight and unclaimed $PEGGED travel with the NFT on secondary sales.
- **Cleanup:** `compost_monke` — permissionless removal of dead weight when NFT is burned (supply == 0)

## Deployment

| Component | URL |
|-----------|-----|
| Frontend | [monke.army](https://www.monke.army/) |
| Bot Relay | `wss://bot.monke.army` |

## Security

- **Upgrade authority:** Retained by operator. Program can be upgraded.
- **Audit status:** Unaudited. Use at your own risk.
- **Fee split:** 60/40 hardcoded on-chain (bridge_vault → $PEGGED for monke holders / Config.bot for operations). Not governable by operator. Revenue destination change requires 24hr timelock.
- **Permissionless fallback:** All harvests and sweeps can be cranked by anyone when the bot is stale, preventing fund lock-up.

## Known Limitations

- **Token-2022 fully supported (Feb 23).** All outbound transfers use `anchor_spl::token_interface::transfer_checked`, dispatching to whichever token program owns the account. SPL Token and Token-2022 pools both work end-to-end.

- **Token-2022 Transfer Fee mints:** Tokens with the Transfer Fee extension work end-to-end, but the recipient receives slightly less than displayed. The protocol's delta-based fee calculation is accurate, but downstream transfers also incur the token's built-in transfer fee. Economic impact bounded by the token's fee rate (typically <2%).

- **Token-2022 Transfer Hook mints:** Mints with the Transfer Hook extension are **not supported**. Transfer hook extra accounts are not resolved (`RemainingAccountsInfo::empty_hooks()` used everywhere). Add when demand exists.

## Dependencies

- Solana CLI 3.0+ (Agave) or 1.18+
- Anchor 0.31.1
- Rust (via rustup)
- Node.js 18+
- Meteora DLMM SDK (`@meteora-ag/dlmm`)
- Helius LaserStream gRPC (`@triton-one/yellowstone-grpc`)
- tsx (TypeScript execution for bot)
- `@solana/kit` (Codama-generated client runtime)
- esbuild (build: bundle + minify)

## License

MIT
