# crank.money

**Limit orders that earn fees. Burn $CRANK, earn $PEGGED.**

Managed Meteora DLMM positions with sub-second bin harvesting via Helius LaserStream and NFT revenue sharing (SMB Gen2/Gen3) on Solana.

## Programs

| Program | Description |
|---------|-------------|
| `bin_farm` | Position wrapper on Meteora DLMM.|
| `bin_farm` (sweep_rover) | 50% of protocol fees are swept to $PEGGED. 50% to development. Program also manages Protocol Owned DLMM positions to reduce sell pressure on TOKEN fees.|
| `monke_bananas.rs` | Burn 1M $CRANK, Earn $PEGGED. MasterChef contract distributes $PEGGED amongst NFT holders who have burned $CRANK. |
| `pegged_bridge.rs` | Deposits SOL into SPL multi-stake pool (Helius + LP Army + MonkeDAO validators), receives $PEGGED, forwards to dist_pool ATA on monke_bananas. |

## The Problem

Your market buys and sells are clumsy. They slam the orderbook, and slippage eats away at your profits.

Your LP positions get bled out by Impermanent Loss.

You need Automations, but Jupiter charges you 0.12% as a platform fee, plus LP fees and slippage on execution.

---

## The Solution

### Yield Bearing, Ranged Limit Orders.

Set your range as a single-sided LP. If price moves through your range, Crank's Harvester captures that profit, or accumulation, and pulls it into your wallet.

**Sell the Rips.** Crank's Harvester pulls your SOL before the chart reverses.

**Buy the Dips.** Crank's Harvester lets you build a position over a range of lows.

**How it works:**

1. User deposits SOL or TOKEN into bins above/below current price.
2. Position acts as a limit order, earning LP fees as the position fills.
3. Price sweeps through bins, and your tokens are converted via Meteora DLMM.
4. Crank's Harvester detects fully-converted bins via Helius LaserStream gRPC.
5. Harvester calls `harvest_bins` with those specific bin IDs.
6. Anchor program CPIs to Meteora `removeLiquidity` for only those bins.
7. Harvested tokens flow directly into the owner's wallet.
8. Remaining bins stay open, waiting to be filled.

### Crank's Harvester — Powered by Helius LaserStream

A pipeline of information coming straight from the source, enables sub-second Crank Automations, to protect your trade.

### Permissionless Harvesting - Decentralized Backup

If our bot goes down, you can always harvest or close your position by yourself, or another Crank user can do so for you, and earn a small fee.

Every step in the revenue pipeline is permissionless. Harvest, close, sweep, distribute, deposit — all crankable by anyone. crank.money is built to be fast and convenient through running our own infrastructure, but the system is resilient without it. 

### Performance Fee

Zero fee on deposit. 0.3% on converted output only.

The 0.3% only applies to the side that converted (SOL you received from a sell, or tokens you received from a buy).

LP fees can be claimed anytime at zero cost. Unclaimed LP fees at close are included in the 0.3% — effectively dust.

---

## Methodology: Gamma Scalping

crank.money is a form of active liquidity provision. Trade flow routes through your ranges, filling your orders. The Harvester withdraws that liquidity from the market once filled — widening the bandwidth on fill, then closing the aperture by withdrawing your LP.

Meme tokens with low liquidity and fat orders have structural slippage — an acceleration of price toward the outer bands of available liquidity. This acceleration of price is a byproduct of AMM curves, and is called gamma.

crank.money scalps this gamma, turning it into better execution for your trades.

Users are providing discretionary liquidity to the market and withdrawing on fill — imposing adverse selection on passive pools.

---

## Burn $CRANK, Earn $PEGGED.

To support existing NFT communities, MonkeDAO has been integrated into the tokenomics of crank.money.

1. Hold an eligible NFT — SMB Gen2 or SMB Gen3 to launch.
2. Burn $CRANK to that monke.
3. Claim $PEGGED.

- 1M $CRANK minimum per burn.
- 50% of protocol fees are converted to $PEGGED and distributed to burners.
- 50% of protocol fees fund bot operations and builds.
- NFTs are fully tradeable. Weight and unclaimed $PEGGED travel with the NFT.

## WTF is $PEGGED.

50% of Protocol Trade Fees are turned into a SOL Liquid Staking token, as those fees are deposited into three validators: 

- Helius Validator
- Meteora LP Army Validator
- MonkeDAO Validator

The $PEGGED token is Liquid Staked SOL, launched on top of Sanctum. 

APRs on $PEGGED will be around 7%, depending on Solana Staking Yield Rates.

## Gud Fee Tek

crank.money is built on top of Meteora DLMM. This debut harvest strategy is an automation layer which when applied to pump.fun tokens ought to provide users with an advantage over their counterparties. 

DLMM also enables the crank.money to form protocol owned LP positions, which reduce sell pressure on the tokens that users trade on the platform. 

For example, if you are buying $CRANK at lower ranges, the protocol charges a fee on those purchases. That means that the protocol now holds some $CRANK. 

Instead of selling that $CRANK immediately for SOL, a protocol owned LP position opens, and crank.money uses its own tech to convert that $CRANK into SOL as more buy pressure occures. 

Meteroa DLMM is Gud Fee Tek.

---

## FAQ

**Why Meteora DLMM?**
Single-sided bid-ask orders in discrete price bins. crank.money watches those bins, and after they convert, pulls them back into your wallet.

**Why not just use Meteora directly?**
crank.money is an automation cooperative for yield-bearing limit orders. Our programs are a minimalist vault wrapper on DLMM positions. Our LaserStream gRPC subscription provides an economy of scale — one connection monitoring all positions in the wrapper.

crank.money helps pump.fun traders get better buys and sells, and offers an edge to compete with other more sophisticated players in that ecosystem.

**Did you say $CRANK gets burned?**
Yep. The Dev doesn't sell $CRANK -- just burns it.
50% of protocol fees go to burners, so you might consider doing that as well.

**Why Solana Monke Business?**
SMB Gen2 & Gen3 NFTs have great taste, and crank.money will be submitting as a project to the MonkeFoundry Incubator. 

**Does it work with Token-2022 / pump.fun tokens?**
Yes. Runtime detection, V1/V2 CPI branching. Zero additional configuration. Exception: Token-2022 mints with active transfer hooks are not yet supported.

---

*crank.money*


## Project Structure

```
monke-army/
├── programs/           # Anchor workspace: bin-farm, monke-bananas, pegged-bridge
├── bot/                # Crank's Harvester (off-chain infrastructure)
├── public/             # Frontend: Trade / Positions / Rank / Ops / Recon
├── scripts/            # Deploy, build, codama generation, utilities
├── src/generated/      # Codama-generated TypeScript clients
└── ref/dlmm-sdk/       # Cloned Meteora DLMM SDK (CPI source of truth)
```

## Build & Deploy

```bash
npm install
PATH="$HOME/.cargo/bin:$PATH" cargo-build-sbf --manifest-path programs/bin-farm/Cargo.toml
solana program deploy target/deploy/bin_farm.so \
  --program-id 8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia \
  --url mainnet-beta
```

IDL generation: `anchor idl build -p bin_farm` / `-p monke_bananas` / `-p pegged_bridge`. Codama clients: `node scripts/generate-clients.mjs`. Pin `blake3` and `borsh` to 1.5.5 after `cargo update`.

## Run Crank's Harvester

```bash
cp bot/anchor-harvest-bot.env.example bot/.env
# Edit bot/.env — set RPC_URL, GRPC_ENDPOINT, etc.
npm run bot
```

## Run Frontend

```bash
node scripts/build-frontend.mjs && npx serve dist   # local dev
node scripts/build-frontend.mjs                      # production (Vercel)
```

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
| $CRANK Mint | Launching soon on Pump.fun |
| $PEGGED Mint (LST) | `GmqNKeVoKJiF52xRriHXsmmgvTWpkU4UVn2LdPgEiEX1` |
| SPL Stake Pool | `9tkzwSotpYFNWYg7ggunktSqcpykVzzPunsSoNwPacjg` |

## Deployment

| Component | URL |
|-----------|-----|
| Frontend | [crank.money](https://www.crank.money/) |
| Bot Relay | `wss://bot.crank.money` |

## Security

- Program can be upgraded.
- AI Audit using [Adversarial Spec](https://github.com/zscole/adversarial-spec) and several rounds of analysis with Opus 4.6.
- All harvests and sweeps can be cranked by anyone when the bot is stale, preventing fund lock-up.

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
