# migration.md
# CrankBot — Migration Plan
# MonkeBurn → bCRANK
# Telegram / Discord Native Launch

---

## WHY WE ARE MIGRATING

The existing `monke_bananas` burn program requires users to:
- Own an SMB Gen2 / Gen3 / Goose NFT
- Execute `feed_monke` against that NFT
- Claim via NFT ownership verification

This is not Telegram-first. It is not simple. It requires external wallet interactions that break the custodial model.

The new system:
```
/burn 1m
🦧 u got 1,000,000 bCRANK
```

Everything happens inside the custodial wallet. No NFT required. No external wallet. No delegation.

---

## THE MIGRATION

### Step 1 — Snapshot MonkeBurn state

```
Read all MonkeBurn PDAs from monke_bananas program
Record: wallet → share_weight

Result:
  Root's wallet:  64,585,930 units  (the only burner)
  All others:     0
```

Nobody else burned. Migration is trivial.

### Step 2 — Deploy bCRANK minter contract

New contract. Key mechanic:

```rust
// Max bCRANK supply is dynamic — enforced on-chain at mint time
let crank_supply = token::accessor::supply(&ctx.accounts.crank_mint)?;
let max_bcrank   = 2_000_000_000_000_000u64 - crank_supply; // base units
let bcrank_supply = token::accessor::supply(&ctx.accounts.bcrank_mint)?;

require!(
    bcrank_supply + amount <= max_bcrank,
    ErrorCode::ExceedsMaxSupply
);

// Burn CRANK, mint bCRANK 1:1
token::burn(burn_ctx, amount)?;
token::mint_to(mint_ctx, amount)?;
```

Max bCRANK = 2,000,000,000 - current CRANK supply (live, always accurate)
Currently: 2,000,000,000 - 1,935,414,069 = 64,585,930 bCRANK mintable

As more CRANK burns → CRANK supply shrinks → bCRANK ceiling rises.
The two supplies are inverse. Total never exceeds 2B.

### Step 3 — Airdrop to Root

```
Root burned 64,585,930 CRANK → receives 64,585,930 bCRANK
Sent to Root's custodial bot wallet or designated wallet
One transaction. Done.
```

### Step 4 — Deprecate feed_monke

Close the old burn instruction.
MonkeBurn PDAs become historical artifacts.
Old claim_pegged instruction retired.
Revenue distribution migrates to bCRANK accumulator.

### Step 5 — Launch bot

Single system. Single token. Single mechanic.

---

## THE NEW SYSTEM

### Tokens

```
CRANK     — primary token, burns to mint bCRANK
bCRANK    — transferable, vote weight + rev share claim
$PEGGED   — crankSOL LST, protocol revenue distribution token
```

### Three Pools

```
CRANK/SOL      — primary market, price discovery, degen entry
CRANK/PEGGED   — protocol recycling loop
bCRANK/PEGGED  — governance weight priced in protocol revenue
```

### bCRANK Properties

- Transferable (not soulbound)
- 1:1 mint ratio against CRANK burn
- Dynamic max supply = 2B - current CRANK supply
- Holding bCRANK = vote weight + pro-rata rev share
- Price on secondary = market's expectation of future protocol revenue

### Revenue Distribution

```
Protocol fees → 50% pool emissions (directed by bCRANK vote weight)
             → 50% rev share (pro-rata by bCRANK balance)

Total weight = total bCRANK supply
Each holder's share = their bCRANK balance / total bCRANK supply
```

No MonkeBurn. No NFT. No PDAs. Just bCRANK balance.

### Protocol-Owned bCRANK

Root burns CRANK at the protocol level:
```
Protocol burns CRANK
→ receives bCRANK
→ assigns vote weight to anchor pools
→ deploys as LP position in those pools
→ earns trading fees while vote persists
→ vote unchanged until Root reassigns
```

Protocol weight is never idle. It votes and earns simultaneously.
Communities vote around the protocol anchor with their own bCRANK.

---

## THE BOT COMMANDS

```
TRADING
/buy              — interactive or inline
/buy TOKEN HIGH to LOW AMOUNT QUOTE
/sell             — interactive or inline
/sell TOKEN LOW to HIGH AMOUNT QUOTE
/positions        — list open positions
/close ID         — close specific position
                  — auto-close when fully filled

WALLET
/start            — create custodial wallet
/balance          — show all balances
/deposit          — show deposit address
/withdraw         — sweep to external wallet

BURN & VOTE
/burn AMOUNT      — burn CRANK, receive bCRANK
/pools            — list covered pools + APR
/vote POOL        — vote 100% to one pool
/vote POOL1 PCT1 POOL2 PCT2

EARNINGS
/claim            — claim all pending $PEGGED

INFO
/help
```

---

## THE INTERACTIVE BUY FLOW

```
/buy

Bot: 🌐 fetching price...

     SOL — $89.43
     24h: ▲ 3.2%

     What are you buying?
     [/pools]

> SOL

Bot: Your range? (high to low, below $89.43)

> 100 to 74

🦧 monke need to buy below current price.
   ex: /buy SOL 84 to 74 1000 USDC

> 84 to 74

Bot: How much USDC?

> 1000

Bot: ✅ BUY SOL — $74 to $84
     [░░░░░░░░░░░░░░░░░░░░] waiting
     Current: $89.43 (above range)
     Depositing: 1,000 USDC
     APR: 21.4%
```

### One-liner (chad mode)

```
/buy SOL 84 to 74 1000 USDC
→ fetches current price silently
→ validates range
→ executes
→ confirms
```

### Validation errors (orangutan voice, always with example)

```
🦧 monke need to buy below current price.
   ex: /buy SOL 84 to 74 1000 USDC

🦧 monke need to sell above current price.
   ex: /sell SOL 94 to 105 10 SOL

🦧 not enough SOL in wallet.
   /deposit to add funds.

🦧 range too tight for this pool.
   ex: /buy SOL 84 to 74 1000 USDC
```

### Dynamic suggestions

When range crosses current price, bot computes suggestion:
```typescript
const nearPct = randomBetween(5, 10);
const farPct  = randomBetween(15, 20);
const high = current * (1 - nearPct / 100);
const low  = current * (1 - farPct  / 100);
// format in pool's display mode (price, mc, or pct)
```

---

## POSITIONS DISPLAY

```
/positions

📊 Positions (3)

① BUY BUTT — 10kmc to 20kmc
  [░░░░░░░░░░░░▓▓▓▓▓▓▓▓] 47% filled
  Harvested: 842,000 BUTT
  Deposited: 10 SOL · 3d ago

② BUY SOL — $74 to $84
  [░░░░░░░░░░░░░░░░░░░░] waiting
  Current: $97.43 (above range)
  Deposited: 1,000 USDC · 1h ago

③ SELL CRANK — 50mmc to 120mmc
  [░░░░░░░░░░░░░░░░░░░░] waiting
  Current: 34mmc (below range)
  Deposited: 500,000 CRANK · 6h ago
```

Fill bar direction:
- Buy side: fills right to left (price drops through range)
- Sell side: fills left to right (price rises through range)

Auto-close: when all bins filled, bot closes position, notifies user, no command needed.

---

## INPUT MODES

### Price
```
/buy SOL 84 to 74 1000 USDC
/buy BUTT .0000008 to .0000004 10 SOL
```

### Market Cap
```
/buy CRANK 45mmc to 22mmc 2 SOL
/buy BUTT 20kmc to 10kmc 5 SOL
/buy WIF 2bmc to 1.5bmc 100 USDC
```

MC suffixes:
```
kmc  = thousands    (20kmc = $20,000)
mmc  = millions     (15mmc = $15,000,000)
bmc  = billions     (2bmc  = $2,000,000,000)
mc   = bare         (45mc  = $45)
```

Supply fetched live via `getTokenSupply(mint)` — never hardcoded.
Bot reflects back whatever mode the user typed.

---

## PRICE SOURCES (set in curator.md per pool)

```yaml
priceSource:
  type: pyth    # Pyth feed address — liquid pairs (SOL, BTC, ETH)
  type: pool    # read active_id from LbPair — protocol-native pairs
  type: jupiter # Jupiter price API — long tail tokens
```

Root sets price source at pool registration.
No price source configured = bot refuses to open interactive flow.

---

## MONKEDAO / MONKEYFOUNDRY

The migration honors all existing burn history.
Root's 64M CRANK burn is fully migrated to bCRANK.
SMB NFTs are not required for the new system.

The MonkeDAO relationship is a distribution partnership:
- CrankBot seeks grant / incubator support
- SMB holders are a natural early adopter community
- bCRANK can be distributed to SMB holders as an onboarding mechanism
- The protocol generates yield that benefits aligned holders

This is a partnership conversation, not an architecture constraint.

---

## WHAT GETS BUILT

### New Contracts
- bCRANK minter (burn CRANK → mint bCRANK, dynamic max supply)
- Updated revenue distributor (bCRANK balance → $PEGGED claims)

### Bot
- Telegram adapter (grammy) — primary
- Discord adapter (discord.js) — secondary
- Shared command logic
- Custodial wallet service
- Interactive + inline command flows
- Push notifications (harvest, close, fill milestones)

### Deprecated
- feed_monke instruction
- claim_pegged (NFT-gated)
- MonkeBurn PDA system

### Preserved
- bin_farm program (position open/close/harvest) — unchanged
- pegged_bridge program — unchanged
- sweep_rover / rover_authority — unchanged
- Helius LaserStream harvester — unchanged
