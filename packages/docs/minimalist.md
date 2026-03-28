# minimalist.md
# CrankBot — What This Actually Is

---

## The Product

veDEX automated limit order trading cooperative.
Telegram and Discord native.
Self-contained.

---

## The One Paragraph

CrankBot is a cooperative trading tool that lives in Telegram and Discord.
You open a range. The protocol fills it automatically as price moves through.
You earn yield while you wait. The bot notifies you when you fill.
Burn CRANK to earn a share of every position opened by anyone on the protocol.
Vote to direct emissions to the pools your community trades in.
No browser required. No wallet connect. No leaving the app you're already in.

---

## What Already Exists (Do Not Rebuild)

```
The Protocol          — deployed, working, battle-tested
The Harvester Bot     — running in production, Helius gRPC, real-time
The Revenue System    — MonkeBurn, $PEGGED, sweep, bridge, all live
The Math              — bin/price conversion, PDA derivation, account resolution
```

## What Is Being Built

```
The front door        — the chat interface where Monkes walk in
```

That's it.

---

## The Stack

```
packages/
  core-sdk/      — extracted from app.js, already written
  shared/        — command logic, shared between Telegram and Discord
  telegram-bot/  — grammy adapter
  discord-bot/   — discord.js slash commands (stub)
```

Same custodial wallet works across both platforms.
Same command logic runs on both adapters.
One backend. Two front doors.

---

## The Commands

```
/start                        — create wallet, get deposit address
/balance                      — show balances

/crankbuy  SOL 84 to 74 1000 USDC
/cranksell BUTT 45mc to 90mc 500000 BUTT
/crankarb  ezSOL -0.5% to -1.5% 10 SOL

/positions                    — list open positions
/close ID                     — close a position
/withdraw TOKEN AMOUNT ADDR   — sweep to external wallet

/listpools                    — covered pools + APR
/vote SOL                     — vote 100% to SOL pool
/vote SOL 50 CRANK 50         — split vote

/crank burn 1m                — burn CRANK, receive bCRANK
/crank balance                — show CRANK and bCRANK balances

/myemissions                  — show claimable $PEGGED
/claim                        — claim all pending emissions

/delegate WALLET              — link external wallet's burn weight
```

---

## The Revenue Loop

```
User opens position
→ bins fill
→ 0.3% fee on harvest
→ 50% to bCRANK + MonkeBurn holders (pro-rata by weight)
→ 50% directed by vote weight to pool emissions
→ traders in voted pools earn $PEGGED
→ $PEGGED = crankSOL LST, earns staking yield while it sits
```

---

## The Weight System

Two ways to hold weight. Same accumulator. Same distribution.

```
MonkeBurn.share_weight    — burn CRANK against SMB NFT (existing)
bCRANK balance            — burn CRANK in-app, receive transferable token (new)

Total weight = sum(MonkeBurn.share_weight) + bCRANK total supply
Distribution = pro-rata across both groups from one pool
```

---

## The Tribal Model

Communities want their token covered.
Coverage = LaserStream slot + emissions from vote weight.
To get coverage: burn CRANK, accumulate bCRANK, vote for your pool.
Communities that generate volume earn more emissions.
Emissions attract more traders.
More traders generate more volume.
More volume grows the fee pool everyone shares.

The bot is the cooperative infrastructure.
The communities are the members.
Competing for coverage, not against each other.

---

## The Distribution Play

```
Telegram    — Monkes already here
Discord     — community servers, tribal, slash commands, social proof
MonkeDAO    — SMB NFT integration, grant / Foundry / Helius subsidy angle
pump.fun    — MC display mode makes degen UX natural
```

No browser app required for any of this to work.

---

## What The Frontend Is

Buggy. Deprioritized. A power user tool for Root.
Not the product. Not the front door. Not the priority.
The bot is the product.

---

## The Build Order

```
1. core-sdk extraction        — copy from app.js, add types (done)
2. wallet-service             — custodial keypair + SQLite (done)
3. signer                     — 10 lines replacing Phantom (done)
4. /start + /balance          — wallet creation and funding
5. /crankbuy + /cranksell     — position opening (the core)
6. notifier                   — harvest events → push notifications
7. /positions + /close        — position management
8. /withdraw                  — sweep to external wallet
9. /listpools + /vote         — emissions direction
10. /crank burn + bCRANK      — in-app burn mechanic
11. /myemissions + /claim     — rev share claims
12. Discord adapter           — same logic, new adapter
```

Steps 1-3 are written.
Steps 4-8 are the prototype.
Steps 9-12 are the cooperative layer.

Ship 4-8 first. That's a working product.
Everything after that is the flywheel.
