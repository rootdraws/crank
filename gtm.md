# crank.money — GTM Strategy

> Revenue before visibility. One community at a time. Nobody needs to know what we're building until they're already using it.

---

## The Product

Yield-bearing ranged limit orders via chat bot. Not swaps — DLMM positions that earn LP fees while waiting to fill.

- **0.3% fee on converted output only** (competitors charge 0.5–1% on every swap)
- **80% revenue share** — SOL distributed daily to users via Merkle (competitors share 0%)
- **Permissionless everything** — no fund lock-up, anyone can crank
- **Non-custodial PDA vaults** — user funds on-chain, server compromise can't steal

Competitors (Trojan, Bonkbot, Banana Gun, Maestro, GMGN, Bloom, MEVX, BankrBot) are swap bots. HawkFi and MetEngine are the closest — LP automation — but neither does community treasury LP with Merkle distribution. That segment is open.

---

## Blockers — Build Before Anything Else

### 1. $BANK Token Metadata
$BANK has zero metadata. Looks like a scam token in Phantom. Fix before onboarding anyone. Register Metaplex metadata, host logo on Arweave.

### 2. Analytics (Operational, Not Marketing)
Track real numbers for ourselves — not to pitch, but to know what's working and what's broken.

- `/stats` slash command — user count, volume, harvests, fees, uptime
- `#crank-stats` Discord channel — daily automated post
- Track USD volume on every `/buy` and `/close`
- Track daily active users

When the numbers are good enough that someone asks to see them, they already exist.

### 3. UX Polish
`/sell` deposit flow needs clarity after token enable. Buy/sell at boundary auto-nudges (no more rejection errors). These are the things that make someone stay vs leave after their first session.

---

## The Playbook

### How a community gets onboarded

1. Find a community with an active token and engaged holders
2. List their pool(s) in `curator.json` — bin step, mints, supply, display mode
3. Add LaserStream subscription for the new LbPair(s)
4. Test with a small position — verify harvest/close cycle works
5. Introduce to one or two people in the community. Let them try it.
6. If they like it, they tell others. If they don't, learn why and fix it.
7. Move to the next community.

No landing pages. No demo videos. No announcements. The product is the pitch.

### What this looks like at scale

- 1 community: prove the model works, earn first real fees
- 5 communities: repeatable playbook, each onboard takes a day
- 20 communities: operational knowledge is the moat, fee revenue is real
- 50+ communities: someone notices, tries to clone it, but you have relationships and a year of edge-case knowledge they don't

### What stays quiet

- How the harvester works
- Keeper sequencing details
- Fee rover economics
- The byte-level gRPC parsing
- Basically everything in CLAUDE.md

Show the *what* (limit orders that earn fees). Keep the *how*.

---

## Pipeline

### Now: GSD (Community #1)
- Already in `curator.json`
- c10 is an early holder, followed by the dev
- Active on Bags.fm with engaged team
- **Action:** Introduce to a couple holders. Let them open positions. See what happens.

### Next: Bags.fm Ecosystem
- Godmode, then other active Bags communities
- Same playbook each time
- Don't enter Bags hackathon (would fracture $CRANK). Serve their communities as infrastructure.

### After That: Organic Discovery
- Communities that hear about it from GSD/Godmode/Bags users
- PumpFun communities with active tokens and volume
- Anyone who asks

### Sole Pool Advantage
When onboarding a new community token, be the first DLMM pool if none exists. You set the bin step (fee tier). Arb bots pay whatever you set. Temporary monopoly on price discovery until market competes you down. Fat fee window on fresh/low-liquidity tokens.

---

## Relationships

These people exist. Don't pitch them. Let results speak.

| Contact | Why They Matter | When to Engage |
|---------|----------------|----------------|
| Mert (Helius) | Angel checks, you're already a LaserStream customer | When you have 5+ communities and real fee numbers |
| Simon (MonkeDAO) | Incubator program, GTM network | When you have traction worth incubating |
| LP Army | They teach manual DLMM, you automate it | When a community user publishes results organically |
| Eno (Sanctum) | INF as treasury asset, deep liquidity | When protocol treasury is worth discussing |
| Tamar / Sepherim / Shek | Solana ecosystem GTM help | When you need distribution, not before |
| Superteam | Grants up to $10k | When you have metrics for the application |
| Luminaries | Content amplification | When there's something to amplify |

The pattern: build first, engage when you have something they can't ignore.

---

## Competitor Landscape

### Swap Bots (Different Category)

| Bot | Type | Fee | Rev Share |
|-----|------|-----|-----------|
| Trojan | Swap bot | ~0.5-1% | 0% |
| Bonkbot | Swap bot | ~0.5-1% | 0% |
| Banana Gun | Swap bot | ~0.5-1% | Token buyback |
| Maestro | Swap bot | ~1% | 0% |
| GMGN | Swap/analytics | Varies | 0% |
| BankrBot | Text-based trading | TBD | TBD |

### LP Automation (Direct Competitors)

| Player | Traction | Model | What They Don't Do |
|--------|----------|-------|--------------------|
| MetEngine | $26M vol, 2K users, $400K fees | Copy-LP via Telegram | No community treasury, no Merkle distro, no B2B |
| HawkFi | $50M TVL, $9.4M fees, $5.8B vol | Vault-based auto-rebalance | No community treasury, no Merkle distro, no B2B |
| LP Agent | Unknown | AI chatbot for pool discovery | No community dimension |
| Maiker.fun | Unknown | Concentrated liquidity vaults | Individual deposits only |

Nobody does community LP-as-a-Service with Merkle distribution.

---

## Long-Term

### Bittensor Subnet (Seby)

**The deal (confirmed 2026-03-29):**
- Seby's investors fund subnet acquisition
- Seby's devs build v1
- Emissions fund dev costs
- Root builds the business that drives real value to the alpha token

**The model:** Miners compete to build quant strategies for DLMM market making. Crank.money is the execution layer. Miners scored on real P&L. Alpha token wraps to Solana, burns into $BANK alongside $CRANK. Two deflationary inputs, one governance token. $BANK holders vote on which mining agents get rebates.

**When to pursue:** When fee revenue proves the business model. The subnet pitch writes itself once real numbers exist.

### Telegram Adapter
Core-SDK is platform-agnostic. ~300-400 lines. Opens up Telegram communities (larger TAM for trading bots). Build after Discord is proven with multiple communities.

### Dexter / x402 Integration
x402 micropayments, pay-per-call harvester API. Evaluate when there's bandwidth. Not a priority.

### ~~PumpSwap Sync Bot~~ — REMOVED
Jupiter routes buys through DLMM organically. Pools track within ~2 bins without intervention.

---

## Scaling Phases

**Phase 1: Hands-on (now)**
Every onboard is manual. Root does the listing, the config, the relationship. Learn what works.

**Phase 2: Repeatable (1 community/week)**
Same template each time. List pool, test cycle, introduce to a few holders, move on. No marketing.

**Phase 3: Agentic maintenance**
Agent handles: pool health monitoring, supply refreshes, dead pool flagging, prospect identification, daily stats posting. Human handles: relationships, strategic decisions, new features.

**Phase 4: Hire**
When revenue supports it — someone to run community sales full-time. Root focuses on protocol engineering and subnet intelligence layer.
