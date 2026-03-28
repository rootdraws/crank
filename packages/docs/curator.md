# curator.md
# CrankBot Pool Configuration
# Maintained by Root. Read by the bot at startup.
# This file is the intelligence layer. The bot is dumb. You are not.

---

## WHAT THIS FILE IS

CrankBot doesn't guess which pool to use, what display format to show,
or how large a range can fit in a single position. You tell it.

When you add a token pair to coverage, you fill out a pool entry below.
The bot reads this file and routes commands accordingly.
No pool entry = no coverage. The bot will say "not found."

---

## COMMAND SYNTAX (what Monkes type)

### Buy side — accumulating a token on the way down

```
/crankbuy TOKEN HIGH to LOW AMOUNT QUOTE
```

Examples:
```
/crankbuy SOL 84 to 74 1000 USDC
/crankbuy BUTT 22mc to 11mc 5 SOL
/crankbuy CRANK 45mc to 22mc 2 SOL
/crankbuy ezSOL -0.5% to -1.5% 10 SOL
```

Reading:
- TOKEN  — what they're accumulating
- HIGH   — upper bound of range (closer to current price)
- LOW    — lower bound of range (further from current price)
- AMOUNT — how much QUOTE to deposit
- QUOTE  — the token they're spending

The range goes high → low because they're buying on the way DOWN.
"Buy SOL between $84 and $74" means: as price falls through that range, fill me up.

### Sell side — exiting a token on the way up

```
/cranksell TOKEN LOW to HIGH AMOUNT QUOTE
```

Examples:
```
/cranksell BUTT 45mc to 90mc 500000 BUTT
/cranksell CRANK 50mc to 120mc 1000000 CRANK
/cranksell SOL 98 to 115 10 SOL
```

Reading:
- TOKEN  — what they're selling
- LOW    — lower bound of range (closer to current price)
- HIGH   — upper bound of range (further from current price, their target exit)
- AMOUNT — how much TOKEN to deposit
- QUOTE  — the token they receive on fill

The range goes low → high because they're selling on the way UP.
"Sell BUTT between 45mc and 90mc" means: as price rises through that range, sell me out.

### Arb / peg — relative range commands (future)

```
/crankarb TOKEN -1% to 0% AMOUNT QUOTE
```

Used for LST/peg arb. Range is relative to the peg price.
"-1% to 0%" means "buy when token is at 0% to 1% discount to its reference."

---

## DISPLAY MODES

Three ways a range can be expressed. You set this per pool.

### price
User types actual token prices in dollars.
```
/crankbuy SOL 84 to 74 1000 USDC
```
Use for: liquid pairs where price is intuitive (SOL, BTC, ETH, JUP).

### mc
User types market cap with M/K/B suffix.
```
/crankbuy BUTT 22mc to 11mc 5 SOL
```
Bot converts: price = mc / supply. Supply is specified by you (see pool entry).
Use for: memecoins, pump.fun tokens, anything where price notation is hostile UX.

### pct
User types percentage offset from a reference price.
```
/crankarb ezSOL -0.5% to -1.5% 10 SOL
```
Bot converts: price = reference_price × (1 + pct/100).
Use for: LST arb, stable pairs, anything priced relative to another asset.

---

## SUPPLY NOTE — READ THIS BEFORE ADDING MC POOLS

**Never let the bot fetch supply automatically.**

Reasons:
- Some tokens have burned supply — total supply ≠ circulating supply
- Some tokens have minted more after launch
- Pump.fun default is 1B with 6 decimals BUT tokens like CRANK are 1.9B
- You want control over when supply updates, not a stale cache

**Always specify supply manually in the pool entry.**
Update it when you know supply has materially changed.
The bot uses your number, not the chain's number.

CRANK supply: 1,900,000,000 (1.9B)
Standard pump.fun supply: 1,000,000,000 (1B) — verify before assuming

---

## BIN STEP AND RANGE COVERAGE

Each DLMM pool has a fixed bin step. The maximum range a single position
can cover is (1 + binStep/10000)^70 - 1. Reference:

```
binStep = 1    → max single position covers ~0.7%
binStep = 5    → max single position covers ~4.1%
binStep = 10   → max single position covers ~9.7%
binStep = 20   → max single position covers ~15.6%  (MIN for rover positions)
binStep = 50   → max single position covers ~41.6%
binStep = 80   → max single position covers ~75.2%
binStep = 100  → max single position covers ~100.5%
binStep = 200  → max single position covers ~296%
```

**Key implication:** If a Monke asks for a range wider than a pool's max,
the bot auto-splits into multiple positions.

You control whether auto-split is allowed per pool via `splitStrategy`.

---

## POOL ENTRY SCHEMA

```yaml
- id: "sol-usdc-tight"        # unique internal ID — never shown to users
  label: "SOL/USDC"           # what shows in /pools list and confirmation messages
  address: "<lbpair_address>" # Meteora LbPair account address (mainnet)
  binStep: 1                  # verified from on-chain lb_pair.bin_step
  
  # Tokens
  tokenX: SOL                 # symbol
  tokenY: USDC                # symbol
  mintX: So11111111111111111111111111111111111111112
  mintY: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  decimalsX: 9
  decimalsY: 6
  
  # Display
  displayMode: price          # price | mc | pct
  # supply: not needed for price mode
  # pegToken: not needed for price mode
  
  # Routing
  splitStrategy: auto         # auto = split silently | reject = error + suggestion
  maxRangePct: 0.7            # computed: (1+0.0001)^70 - 1 ≈ 0.007 → 0.7%
  
  # Command routing
  # Which TOKEN aliases route here?
  # When user types /crankbuy SOL ... USDC, bot picks this pool.
  buyToken: SOL               # token being accumulated
  quoteToken: USDC            # token being spent
  
  # Human notes (not read by bot)
  notes: >
    Tight 1-step pool. Best for surgical entries within a narrow band.
    Max ~0.7% range per position. Auto-splits for wider ranges.
    Preferred pool for professional SOL accumulation.
```

---

## ACTIVE POOL REGISTRY

### Tier 1 — Always Covered

---

#### SOL/USDC — Tight

```yaml
- id: "sol-usdc-tight"
  label: "SOL/USDC"
  address: "REPLACE_WITH_REAL_ADDRESS"
  binStep: 1
  tokenX: SOL
  tokenY: USDC
  mintX: So11111111111111111111111111111111111111112
  mintY: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  decimalsX: 9
  decimalsY: 6
  displayMode: price
  splitStrategy: auto
  maxRangePct: 0.7
  buyToken: SOL
  quoteToken: USDC
  notes: >
    Primary SOL accumulation pool.
    /crankbuy SOL 84 to 74 1000 USDC
    Auto-splits for wide ranges.
```

---

#### SOL/USDC — Wide

```yaml
- id: "sol-usdc-wide"
  label: "SOL/USDC wide"
  address: "REPLACE_WITH_REAL_ADDRESS"
  binStep: 80
  tokenX: SOL
  tokenY: USDC
  mintX: So11111111111111111111111111111111111111112
  mintY: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  decimalsX: 9
  decimalsY: 6
  displayMode: price
  splitStrategy: reject
  maxRangePct: 75.2
  buyToken: SOL
  quoteToken: USDC
  routingNote: >
    Only used when tight pool can't cover the requested range in ≤3 positions.
    Bot routes here automatically for wide ranges (>5%).
    User is notified: "Using wide pool for this range."
  notes: >
    Swing trading pool. Single position covers up to 75% range.
    /crankbuy SOL 90 to 50 1000 USDC → routes here, single position.
```

---

#### CRANK/SOL

```yaml
- id: "crank-sol"
  label: "CRANK/SOL"
  address: "REPLACE_WITH_REAL_ADDRESS"
  binStep: 100
  tokenX: CRANK
  tokenY: SOL
  mintX: Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump
  mintY: So11111111111111111111111111111111111111112
  decimalsX: 6
  decimalsY: 9
  displayMode: mc
  supply: 1900000000          # 1.9B — verified. NOT 1B. Update if supply changes.
  splitStrategy: auto
  maxRangePct: 100.5
  buyToken: CRANK
  quoteToken: SOL
  notes: >
    Protocol token. 1.9B supply — not standard pump.fun 1B.
    MC display: /crankbuy CRANK 45mc to 22mc 2 SOL
    Single position covers 2x range comfortably at binStep=100.
```

---

### Tier 2 — Vote Weight Required

*(Add pools here as communities earn coverage)*

---

### Template — Copy This When Adding a New Pool

```yaml
- id: "TOKEN-QUOTE"
  label: "TOKEN/QUOTE"
  address: "LBPAIR_ADDRESS_HERE"
  binStep: 0                  # READ FROM ON-CHAIN. Check lb_pair.bin_step at offset 80.
  tokenX: TOKEN
  tokenY: QUOTE
  mintX: MINT_ADDRESS_HERE
  mintY: MINT_ADDRESS_HERE
  decimalsX: 0                # READ FROM MINT ACCOUNT
  decimalsY: 0
  
  displayMode: price          # price | mc | pct
  # supply: 0                 # REQUIRED for mc mode. Specify manually. Verify on-chain.
  # pegToken: ""              # REQUIRED for pct mode. Symbol of reference asset.
  
  splitStrategy: auto         # auto | reject
  maxRangePct: 0              # COMPUTE: (1 + binStep/10000)^70 - 1, as percentage
  
  buyToken: TOKEN
  quoteToken: QUOTE
  
  notes: ""
```

---

## ROUTING LOGIC (how bot resolves commands to pools)

When a Monke types `/crankbuy SOL 84 to 74 1000 USDC`:

```
1. Find all approved pools where buyToken=SOL AND quoteToken=USDC
2. Parse the range: 84 → 74 (price mode)
3. Compute required bins for each candidate pool:
     tight (binStep=1): requires 1000 bins → needs split
     wide  (binStep=80): requires 1 bin range → single position
4. Pick the pool that covers the range in fewest positions:
     - 1 position → use it
     - 2-3 positions → auto-split if splitStrategy=auto
     - >3 positions → prefer a wider bin step pool instead
5. If tight pool requires split and wide pool covers it:
     → route to wide pool silently (Monke doesn't need to know)
6. If no single pool covers it and splitStrategy=reject on all candidates:
     → error + suggestion
```

When two pools could both work (both cover range in 1 position):
- Prefer lower binStep (more precise execution, tighter fills)

When a Monke types `/crankbuy BUTT 22mc to 11mc 5 SOL`:

```
1. Find pool where buyToken=BUTT AND quoteToken=SOL
2. displayMode=mc → fetch supply from pool entry (NOT from chain)
3. Convert: price_high = 22,000,000 / supply
            price_low  = 11,000,000 / supply
4. Compute bins from prices
5. Continue same routing logic
```

---

## CONFIRMATION MESSAGE FORMATS

### price mode
```
✅ BUY SOL — $74.00 to $84.00

[░░░░░░░░░░░░░░░░░░░░] waiting
Current price: $97.43 (above range)

Depositing: 1,000 USDC
APR: 21.4% (LP 9.2% + Emissions 12.2%)
```

### mc mode
```
✅ BUY CRANK — 22M to 45M

[░░░░░░░░░░░░░░░░░░░░] waiting
Current: 67M (above range)

Depositing: 2 SOL
APR: 34.1% (LP 18.3% + Emissions 15.8%)
```

### pct mode (arb)
```
✅ ARB ezSOL — -1.5% to -0.5% below SOL

[░░░░░░░░░░░░░░░░░░░░] waiting
Current: +0.02% (above range)

Depositing: 10 SOL
APR: 8.4% (LP fees only)
```

---

## SPLIT CONFIRMATION (when auto-split is triggered)

When a range requires multiple positions, user sees this BEFORE txs are sent:

```
SOL/USDC — range requires 3 positions

  Pos 1: $84.00 → $83.42  (334 USDC)
  Pos 2: $83.42 → $82.84  (333 USDC)
  Pos 3: $82.84 → $74.00  (333 USDC)

Total: 1,000 USDC · 3 transactions

Confirm? Reply Y to proceed.
```

User must confirm before multi-tx opens.
Single positions proceed without confirmation prompt.

---

## ADDING A POOL — CHECKLIST FOR ROOT

Before adding a new pool entry, verify:

- [ ] LbPair address is correct (check on Meteora app or Solscan)
- [ ] binStep read from on-chain account (offset 80, u16 LE) — do not trust frontend display
- [ ] decimalsX and decimalsY read from respective mint accounts
- [ ] mintX and mintY are the actual mints (not wrapped versions)
- [ ] For mc mode: supply verified against on-chain mint.supply ÷ 10^decimals — write it down
- [ ] maxRangePct computed: ((1 + binStep/10000)^70 - 1) × 100
- [ ] Pool has been live for >48h (new pools can have thin liquidity at launch)
- [ ] LaserStream subscription updated to watch this pool's lbPair address
- [ ] Vote weight exists to justify the LaserStream cost (or it's Tier 1)

---

## REMOVING A POOL

Remove from this file + remove from LaserStream subscription + remove from approved pools set in bot config.

Positions already open on that pool continue to be monitored and harvested.
New positions cannot be opened on removed pools.
