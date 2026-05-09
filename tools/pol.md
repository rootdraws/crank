# pol.md — Protocol LP Tools

Per-wallet DLMM harvester/deployer for managing single-sided positions on a wallet's behalf. Originally designed for W-Buy / W-Sell-CRANK / W-{TRIBE} operator wallets; that topology has been superseded by the 4-way Hopper layout (`dest_treasury / dest_admin / dest_ops / dest_tax`). The harvester logic itself is wallet-agnostic — useful anywhere a DLMM position needs unattended harvest/redeploy.

No on-chain programs of its own — uses Meteora's DLMM SDK directly.

## Tools

### `npm run depth <TICKER>` — Order Book Depth Chart

ASCII visualization of buy/sell pressure by market cap band on a Meteora pool.

```bash
npm run depth CRANK                    # 10 bands, auto $5k bands
npm run depth CRANK -- --bands 15
npm run depth CRANK -- --band-size 10k
npm run depth SOL  -- --pool sol-usdc-1
```

Sell pressure stacks above current price; buy support below. The thickest bar = where the most resistance/support sits. Useful before placing discretionary ranges.

**File:** `tools/depth.ts`

### `npm run protocol-lp` — Per-wallet harvester/deployer

Headless bot that runs on a single keypair. Discovers DLMM positions owned by that wallet, harvests converted liquidity from safe bins, and (optionally) re-deploys it as a new BidAsk position. Configured via `MODE` to one of:

- **`MODE=sell`** (e.g. W-Sell-CRANK): harvest converted bins (CRANK → SOL once price ripped through), `do not auto-redeploy`. Harvested SOL stays in the wallet — sweep to the Hopper happens externally.
- **`MODE=buy`** (e.g. W-Buy): when SOL arrives from the Hopper, deploy fresh BidAsk buy positions below active. Harvest converted CRANK (SOL → CRANK once price dipped through). `Do not auto-redeploy as sells` — operator manually rotates accumulated CRANK to W-Sell-CRANK when ready.

```bash
DRY_RUN=true MODE=sell npm run protocol-lp     # logs what it would do
DRY_RUN=false MODE=buy npm run protocol-lp     # live mode
```

**Files:** `tools/protocol-lp/`

## How it fits

```
Hopper sweep_sol  ─┐                    Operator (manual rotation)
                   │
                   ▼                          ┌──────────────┐
                W-Buy droplet ──┐             │ W-Buy holds  │
                  • deploy buy   │             │ CRANK after  │
                    positions    │             │ bin fills    │
                  • harvest CRANK│             └──────┬───────┘
                  • no redeploy  │                    │ manual transfer
                   │             │                    ▼
                   │             │             W-Sell-CRANK droplet
                   │             │              • operator opens new
                   │             │                sell positions
                   │             │              • harvest SOL when bins fill
                   │             │              • no redeploy
                   ▼             │                    │
              CRANK accumulates  │                    │ SOL accumulates
                                 │                    │
                                 │                    ▼
                                 │              sweep to Hopper
                                 │              (external cron / keeper)
                                 │                    │
                                 └────────────────────┘
                                                       cycle continues
```

Per-tribe wallets follow the same pattern: one droplet per `W-{TRIBE}`, configured against the tribe's pool, harvested SOL flows to the Hopper.

## Config

Per-instance `.env`. Each wallet gets its own droplet, its own keypair, its own state file.

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_URL` | required | Mainnet RPC |
| `KEYPAIR_PATH` | `/root/.keys/lp-keypair.json` | Wallet keypair |
| `POOL_ADDRESS` | required | Meteora LbPair (e.g. CRANK/SOL = `9R9gc...`) |
| `MODE` | `sell` | `sell` (harvest only) / `buy` (deploy + harvest, no auto-redeploy) |
| `REENTRY_BIN_COUNT` | `70` | Bins below active for buy re-entry (max 70). Used in `MODE=buy`. |
| `REENTRY_STRATEGY` | `BidAsk` | `BidAsk` / `Spot` / `Curve`. BidAsk concentrates at the far end — heavier walls at the lowest bins. |
| `MIN_HARVEST_LAMPORTS` | `10000000` | Min converted bin liquidity to trigger harvest |
| `MIN_REENTRY_LAMPORTS` | `2000000000` | Min accumulated SOL to deploy a new buy position (`MODE=buy`) |
| `SOL_RESERVE_LAMPORTS` | `50000000` | Gas reserve, never deployed |
| `POLL_INTERVAL_MS` | `30000` | Idle poll interval |
| `POLL_FAST_MS` | `5000` | Post-harvest poll interval |
| `FAST_MODE_DURATION_MS` | `120000` | How long fast mode lasts |
| `HEALTH_PORT` | `8081` | Health endpoint |
| `DRY_RUN` | `true` | Log only, no transactions |
| `DISCORD_WEBHOOK_URL` | optional | Announce deployments |

> **MODE wiring is a TODO.** Today the tool runs the full closed-loop (harvest + auto-redeploy in same wallet). The `MODE` env var doesn't exist in code yet — it's the contract we want before instantiating per-wallet. Until that lands, run instances in DRY_RUN and drive harvest/deploy manually, or accept the closed-loop behavior as long as the wallet is funded externally for buy-side and has CRANK loaded for sell-side.

## File map

```
tools/
  depth.ts                       Standalone CLI: ASCII depth chart
  pol.md                         This file
  protocol-lp/
    index.ts                     ProtocolLP class, poll loop, orchestrator
    config.ts                    Env loading + validation
    harvester.ts                 Position discovery, safe bin detection, removeLiquidity
    deployer.ts                  BidAsk position creation + Discord webhook
    state.ts                     Persistent state (data/protocol-lp-state.json)
    health.ts                    HTTP health on :HEALTH_PORT
    types.ts                     Shared interfaces
    ecosystem.config.cjs         PM2 config
    .env.example                 Env template
```

## Key logic

**Safe bin detection (`harvester.ts`):**
- Sell-side positions: harvest Y (SOL) from bins where `binId < activeId` (price ripped above → CRANK fully converted).
- Buy-side positions: harvest X (CRANK) from bins where `binId > activeId` (price dipped below → SOL fully converted).

**Buy position deployment (`deployer.ts`):**
- `minBinId = activeId - REENTRY_BIN_COUNT`, `maxBinId = activeId - 1`
- `strategy = BidAsk` (heavier at bottom — strongest floor shape)
- `totalXAmount = 0`, `totalYAmount = accumulated SOL`
- Uses `dlmm.initializePositionAndAddLiquidityByStrategy()` (creates position + adds liquidity in one tx).

**State (`state.ts`):**
- File: `data/protocol-lp-state.json` (gitignored).
- Tracks positions, harvests, deployments, running totals. Atomic writes (temp + rename), simple mutex, capped at 500 records each.

**Adaptive polling:** 30s idle → 5s for 2 min after harvest → revert. Graceful SIGTERM/SIGINT (waits up to 30s for in-flight ops).

## Deployment

Separate droplet per wallet. Same spec as crank-harvester (s-2vcpu-4gb, NYC1).

```bash
pm2 start tools/protocol-lp/ecosystem.config.cjs
pm2 logs protocol-lp --lines 50
curl localhost:8081/health
```

Keypair at `/root/.keys/lp-keypair.json` (chmod 600). `.env` at `tools/protocol-lp/.env`.

**Data safety:** `data/protocol-lp-state.json` is reconstructable — positions exist on-chain. Losing the file forfeits harvest/deployment history but no funds.

## Import pattern (tsx + Node 24 quirk)

External imports use `createRequire`:

```typescript
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const DLMM = _require('@meteora-ag/dlmm');
const sdk = _require('@crankbot/core-sdk');
const { Connection, PublicKey, Keypair } = _require('@solana/web3.js');
```

Required because tsx resolves `@meteora-ag/dlmm`'s `"source"` field and tries to compile raw TS that uses incompatible Anchor imports. CJS dist works fine via `createRequire`.

## Ancestry

Descended from `/Users/root1/dlmm-harvester/` — the proto-version of crank-money. That bot's harvester logic (position discovery, safe-bin detection, removeLiquidity, adaptive polling, retry, graceful shutdown) was ported into `harvester.ts`. The deployer + state persistence are new.
