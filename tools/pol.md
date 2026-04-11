# pol.md — Protocol-Owned Liquidity Tools

Tools for managing and analyzing protocol-owned DLMM liquidity on the CRANK/SOL pool. No on-chain programs — talks directly to Meteora's DLMM program via SDK.

## Tools

### `npm run depth <TICKER>` — Order Book Depth Chart

ASCII visualization of buy/sell pressure by market cap band. Reads real bin liquidity from Meteora, aggregates into bands, renders centered on current price.

```bash
npm run depth CRANK                    # Default: 10 bands, auto $5k bands
npm run depth CRANK -- --bands 15      # More bands
npm run depth CRANK -- --band-size 10k # Override band width
npm run depth SOL -- --pool sol-usdc-1 # Price-mode pool
npm run depth CRANK -- --bins 300      # Override bin fetch count
```

**Output:** Sell pressure stacks above current price (bars grow right), buy support below. `↓` = cumulative sell from that band to current price, `↑` = cumulative buy from that band to current price. The thickest bar is where the most resistance (or support) sits.

**File:** `tools/depth.ts` (~300 lines, single file)

### `npm run protocol-lp` — Protocol LP Automation Bot

Headless bot that manages Root's large (~400 bin) sell-side DLMM position. Cycle: harvest SOL from converted sell bins → accumulate → deploy as BidAsk buy positions 70 bins below active price.

```bash
DRY_RUN=true npm run protocol-lp      # Logs what it would do
DRY_RUN=false npm run protocol-lp     # Live mode
```

**Files:** `tools/protocol-lp/`

## Protocol LP Architecture

### The cycle

1. Root has a wide sell-side position on CRANK/SOL (protocol-owned liquidity)
2. As CRANK price rises, bins convert CRANK → SOL
3. Bot detects safe bins (`binId < activeId` = fully converted) and harvests the SOL
4. SOL accumulates in the wallet until it reaches the minimum threshold (2 SOL default)
5. Bot opens a NEW 70-bin BidAsk buy position below current active price
6. Discord announces the redeployment

The big sell position is never modified — only harvested. Each re-entry is a fresh Meteora position.

### Why BidAsk (not Spot)

BidAsk concentrates more liquidity at the far end of the range. For buy positions below current price, this means heavier SOL at the lowest bins. As price dumps, it hits increasingly thick buy walls. Creates a real floor — the deeper someone sells, the more resistance they face.

Spot distributes evenly. Curve is a middle ground. BidAsk is the strongest floor shape.

### Why 2 SOL minimum

Depth chart shows each $5k MC band holds 1.6-10 SOL. A 0.1 SOL position is invisible noise. At 2 SOL, a re-entry shows up as a visible band on the depth chart. Keeps positions meaningful, reduces rent overhead from many tiny positions (~0.06 SOL rent each).

### On-chain optics

Every harvest + redeployment is visible on-chain. Observers see SOL leaving converted sell bins and immediately going back in as buy support lower on the book. The Discord webhook announces each deployment with a Solscan link. The message: "Your SOL contributed toward a deeper floor."

## File map

```
tools/
  depth.ts                       — Depth chart (standalone script)
  pol.md                         — This file
  protocol-lp/
    index.ts                     — ProtocolLP class, poll loop, orchestrator
    config.ts                    — Env loading, validation, CONFIG export
    harvester.ts                 — Position discovery, safe bin detection, removeLiquidity
    deployer.ts                  — BidAsk buy position creation + Discord webhook
    state.ts                     — Persistent state (data/protocol-lp-state.json)
    health.ts                    — HTTP health endpoint (:8081/health)
    types.ts                     — Shared interfaces
    ecosystem.config.cjs         — PM2 config for droplet deployment
    .env.example                 — Environment template
```

## Config reference

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_URL` | required | Helius mainnet RPC |
| `KEYPAIR_PATH` | `/root/.keys/lp-keypair.json` | LP wallet keypair |
| `POOL_ADDRESS` | `9R9gc...` (CRANK/SOL) | Meteora LbPair address |
| `REENTRY_BIN_COUNT` | `70` | Bins below active for buy re-entry (max 70) |
| `REENTRY_STRATEGY` | `BidAsk` | `BidAsk` / `Spot` / `Curve` |
| `MIN_HARVEST_LAMPORTS` | `10000000` (0.01 SOL) | Min SOL in safe bins to trigger harvest |
| `MIN_REENTRY_LAMPORTS` | `2000000000` (2 SOL) | Min accumulated SOL to deploy buy position |
| `SOL_RESERVE_LAMPORTS` | `50000000` (0.05 SOL) | Gas reserve, never deployed |
| `POLL_INTERVAL_MS` | `30000` | Idle poll interval |
| `POLL_FAST_MS` | `5000` | Post-harvest poll interval |
| `FAST_MODE_DURATION_MS` | `120000` | How long fast mode lasts |
| `HEALTH_PORT` | `8081` | Health endpoint port |
| `DRY_RUN` | `true` | Log only, no transactions |
| `DISCORD_WEBHOOK_URL` | optional | Discord webhook for deployment announcements |

## Key logic

### Safe bin detection (harvester.ts)

```
SELL positions: harvest Y (SOL) from bins where binId < activeId
  → Price ripped above these bins, CRANK fully converted to SOL

BUY positions: harvest X (CRANK) from bins where binId > activeId
  → Price dipped below these bins, SOL fully converted to CRANK
  → Phase 2 (logged only in Phase 1)
```

### Buy position deployment (deployer.ts)

```
minBinId = activeId - 70
maxBinId = activeId - 1
strategy = BidAsk (heavier at bottom)
totalXAmount = 0 (no CRANK — buy side is SOL only)
totalYAmount = accumulated SOL
```

Uses `dlmm.initializePositionAndAddLiquidityByStrategy()` — creates position + adds liquidity in one transaction. The `positionKeypair` is generated fresh and must be included in signers.

### State persistence (state.ts)

File: `data/protocol-lp-state.json` (in .gitignore via `data/`).

Tracks:
- Positions: pubkey, side, bin range, status, deployed amount
- Harvests: timestamp, position, amount, tx sig, bins harvested
- Deployments: timestamp, position, amount, bin range, activeId at deploy, tx sig
- Running totals: SOL harvested, SOL deployed, cycle count

Atomic writes (temp file + rename). Simple mutex prevents concurrent writes. Capped at 500 records each.

### Adaptive polling

- Idle: 30s poll interval
- After harvest: switches to 5s for 2 minutes, then reverts
- Graceful shutdown: SIGTERM/SIGINT wait up to 30s for in-flight operations

## Deployment

Separate DigitalOcean droplet from crank-harvester. Same spec (s-2vcpu-4gb, NYC1).

```bash
# On the droplet
pm2 start tools/protocol-lp/ecosystem.config.cjs
pm2 logs protocol-lp --lines 50
curl localhost:8081/health
```

Keypair at `/root/.keys/lp-keypair.json` (chmod 600). `.env` at `tools/protocol-lp/.env`.

**Data safety:** `data/protocol-lp-state.json` is state only (positions, harvests, deployments). Unlike the main bot's wallet DB, losing this file is not catastrophic — positions exist on-chain and will be rediscovered. But it means harvest/deployment history is lost.

## Import pattern

tsx + Node 24 treats workspace packages as CJS. All external imports use `createRequire`:

```typescript
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const DLMM = _require('@meteora-ag/dlmm');
const sdk = _require('@crankbot/core-sdk');
const { Connection, PublicKey, Keypair } = _require('@solana/web3.js');
```

This is required because tsx resolves `@meteora-ag/dlmm`'s `"source"` field and tries to compile raw TS that uses incompatible Anchor imports. The CJS dist works fine via `createRequire`.

## Ancestry

The protocol-lp bot descends from `/Users/root1/dlmm-harvester/` — the proto-version of crank-money. That bot's harvest logic (position discovery, safe bin detection, removeLiquidity, adaptive polling, retry, graceful shutdown) was ported into `harvester.ts`. The re-entry logic (`deployer.ts`) is new — dlmm-harvester only harvested, never re-entered.

## Phase 2 (future)

- Harvest CRANK from exhausted buy positions (price dipped through them → SOL converted to CRANK)
- Close exhausted positions to reclaim ~0.06 SOL rent each
- Full cycle: sell → harvest SOL → buy → harvest CRANK → sell again
- Aggregated re-entry: batch multiple small harvests into one larger position
- gRPC subscription instead of polling for sub-second detection
