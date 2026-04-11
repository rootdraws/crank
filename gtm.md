# crank.money — GTM Strategy

> Post-Discord bot launch. Updated 2026-04-08.

---

## The Pitch

Yield-bearing ranged limit orders via chat bot. Not swaps — DLMM positions that earn LP fees while waiting to fill.

- **0.3% fee on converted output only** (competitors charge 0.5–1% on every swap)
- **80% revenue share** — SOL distributed daily to users via Merkle (competitors share 0%)
- **Permissionless everything** — no fund lock-up, anyone can crank
- **Non-custodial PDA vaults** — user funds on-chain, server compromise can't steal. No wallet connection needed.

Competitors (Trojan, Bonkbot, Banana Gun, Maestro, GMGN, Bloom, MEVX, BankrBot) are swap bots. We're a managed LP product in a chat interface. Different category.

HawkFi is the closest competitor (high-frequency DLMM automation) but has no token economics or revenue-share layer. Fabriq is their analytics partner.

---

## Blockers — Ship Before Selling

These must land before GTM outreach converts to retention:

### 1. Epoch-Computer — End-to-End Test
The 80% revenue share is the headline pitch. The epoch-computer code exists (`bot/epoch-computer.ts`) and has been hardened (2026-04-08): BN precision fix, dynamic rent, harvest logging, claim throttle, 27 unit tests (Merkle proof verification passes), epoch-miss alerting wired into keeper, standalone test script (`scripts/test-epoch.ts`). **Needs live E2E test on mainnet after bin-farm deploy. This is the #1 blocker.**

### 2. Token Metadata
$BANK has zero metadata. Looks like a scam token in Phantom/Solflare. Anyone you onboard will see this immediately. Register Metaplex metadata, host logo on Arweave.

### 3. v2 Polish
Clean documentation, working socials, crank art everywhere. The product needs to look like a product, not a dev build.

### 4. Analytics Dashboard (Discord Channel)
Before pitching to anyone, have real numbers to show. Add a `#crank-stats` channel to the Discord that posts:

- **User count** — total vault PDAs created (from `walletService`)
- **Daily active users** — unique users who ran a command in the last 24h
- **Daily volume** — USD value of positions opened + closed
- **Harvests today** — count + total value harvested
- **Fees generated** — protocol fees (0.3% of converted output)
- **SOL distributed** — cumulative and per-epoch
- **Bot uptime** — from `/api/health`

Post these as a daily summary (automated) and keep a running `/stats` command for on-demand. When Mert asks "do you have traction?" — point at this channel.

---

## Tier 1 — Warm Leads (Relationships Exist)

These people are reachable now. Priority order:

### Mert (Helius)
- Writing angel checks for consumer Solana with non-farmed traction
- Wants a warm intro + loom demo
- **You already pay Helius for LaserStream gRPC**
- MonkeDAO connects you further
- **Action:** Get warm intro (Tony Klor? Simon? LP Army?), record loom demo showing the full /buy → harvest → /close flow with real money

### Eno (Sanctum)
- Sanctum relationship unexplored. INF considered as treasury/partner play.
- They have deep liquidity, partnerships, distribution
- **Action:** Evaluate INF as protocol treasury asset. Pitch if aligned.

### Simon (MonkeDAO)
- MonkeDAO has an incubator program (application pending)
- Shek (MonkeDAO) is running the "DM me for GTM help" meme
- **Action:** MonkeDAO incubator application. Talk to Simon. Talk to Shek.

### LP Army
- LP Army teaches manual DLMM strategies. Crank automates them.
- Content partnership: "here's what LP Army teaches, here's the bot that does it"
- Tony says get on the LP Army partner page (talk to the Swiss lady who handles partnerships)
- Lochie, "cowboy guy" — warm contacts via Tony
- **Action:** Reach out to LP Army partnership contact. Pitch: "we send your community to our bot, they LP better, we both win"

### Metengine & Cleopatra
- Both were DLMM-adjacent and apparently did things wrong
- Tony says learn from their mistakes before repeating them
- **Action:** Research what happened. Don't repeat it.

### Tamar / Sepherim / Shek (Solana Ecosystem)
- All running the "DM me, I'll help you with GTM" playbook
- Sepherim booked 15 meetings from 100+ DMs
- Tamar offers GTM plan, TVL strategy, user acquisition, BD strategy
- **Action:** DM all three. They're literally asking for it.

### Luminaries (Solana Content Collective)
- 50+ creators, one mission: amplify Solana builders
- Run by molu (@molusol)
- **Action:** Get on their radar. They distribute stories for free.

### Superteam
- Solana Foundation's global builder network
- Instagrants up to $10k, Earn payouts
- Tony Catoff is a scout (has referral link)
- **Action:** Join via Tony's referral. Apply for instagrant.

---

## Tier 2 — First Communities to Onboard

### GSD (gsd.crank.money)
- Already listed in curator.json as a pool
- c10 is an early $GSD holder, followed by the dev
- Launch plan already exists:
  1. Build gsd.crank.money landing page
  2. Test mobile frontend
  3. Record video demo (nice suit)
  4. Share in GSD X community + Telegram
  5. c10 distributes to lead holders
- Active on Bags.fm with engaged dev team
- **Action:** Execute the plan. This is community #1.

### Godmode
- Active on Bags.fm alongside GSD
- BagsApp team actively engaging with their devs
- **Action:** After GSD proves the playbook, approach Godmode as community #2.

### Bags.fm Ecosystem Generally
- Bags has a hackathon (can't enter without launching a token there — would fracture $CRANK)
- But can serve Bags communities as infrastructure
- Business incorporation now live on Bags — real ecosystem forming
- **Action:** Don't compete. Serve. List Bags community tokens, build demos, be their DLMM layer.

---

## Tier 3 — Distribution & Content

### LP Army Content Series
- Create content showing crank.money automating LP Army strategies
- "LP Army teaches the strategy, crank.money executes it"
- Natural audience: people who already understand DLMM but are tired of manual management

### Solana Foundation Amplification
- Vibhu: "If you're building on Solana, our firehose is yours to use"
- 300+ ecosystem companies amplified since Jan 1
- Multiple handles: @Solana, @capitalmarkets, @solanapayments, @x402
- Podcasts, events, livestreams, clips
- **Action:** Get known to the foundation. Luminaries + Superteam are the entry points.

### Academic Content / Credibility
- arxiv.org has a library of IL hedging / LP strategy research
- Could produce content referencing academic work — differentiate from "ape bot" competitors
- Useful for pitching to sophisticated LPs and funds

### Video Demo
- Loom for Mert (angel pitch)
- Polished demo for GSD community (suit video)
- General product demo for socials
- **Action:** Record one good demo, cut it three ways

---

## Tier 4 — Product Expansion & Partnerships

### Dexter / x402 Integration
- Nurrish introduced Branch (Dexter)
- x402 micropayments angle: pay-per-call, no wallet connection needed
- Ties into custody wallet value prop
- **Action:** Look at Dexter SDK, build demo, share with BranchM. ~2 week timeline discussed.

### Blockchain_Bil
- Needs a crank-specific demo + mobile frontend
- **Action:** Build demo, share

### Until / DeFiTuna
- Composability exploration
- **Action:** Evaluate what integration looks like

### LP Bot Skill / API Layer
- lpAgent and others are vibe-coding LP bots using APIs
- Lots of LP bots being built right now
- Instead of competing: offer crank.money's harvester as a skill/API they plug into
- **Action:** Evaluate exposing harvester + position management as an API/skill for other bots

### Sole Pool Fee Extraction
- If you're the only DLMM pool for a token, you set the bin step (fee tier)
- Arb bots just pay whatever you set — temporary monopoly on price discovery
- Window of fat fees on fresh/low-liquidity tokens before market competes you down
- **Action:** When onboarding new communities, be the first pool. Set favorable bin step.

---

## Tier 5 — Longer-Term Plays

### Bittensor Subnet — Intelligence Layer (Seby)

**The deal (confirmed 2026-03-29):**
- Seby's investors fund subnet acquisition (existing subnet via auction)
- Seby's devs build v1 of the subnet
- Investors + Seby take a share of TAO emissions, set up validators
- Dev costs come from emissions
- Root's job: build the business that drives real value to the alpha token

**The model:**

Miners compete to build quant strategies for DLMM market making. Crank.money
is the execution layer — it runs the strategies on-chain via Meteora DLMM
positions. Miners are scored on real P&L, not backtests.

**Tokenomics integration:**
- Subnet has its own alpha token (new Bittensor token, not $CRANK)
- Alpha token wraps and bridges to Solana
- Wrapped alpha token burns into $BANK (new burn path alongside $CRANK → $BANK)
- Two deflationary inputs, one governance/yield token
- $BANK holders vote (via gauge-voter) on which mining agents get more rebates
- Governance = "which intelligence does the protocol run"

**The flywheel:**
1. Miners compete to build LP strategies
2. Strategies execute on crank.money → generate real fees (0.3% on output)
3. $BANK holders vote on which agents get rebates (gauge-voter)
4. Miners earn TAO emissions + voted rebates
5. Alpha token wraps to Solana → burns into $BANK
6. More $BANK = more voting power over agent selection
7. Better-voted agents attract better miners → better strategies → more fees → loop

**Why it works:**
- Revenue is real (0.3% on actual conversions, not emissions-dependent)
- Execution layer already exists and runs
- gauge-voter already does weighted voting — extending to agent weights is same pattern
- Two deflationary burn paths into $BANK ($CRANK + alpha) competing for same supply cap
- If emissions go to zero, the bot still runs and fees still flow

**What Root gets:** dev resources, emissions-funded budget, freedom to build,
likely better comp than current income. Intelligence layer on top of existing infra.

**Action:** Continue with Seby. Ship epoch-computer + analytics first (proves
the business generates real revenue). Then the subnet pitch writes itself.

### Scaling Plan — Community Onboarding Cadence

**Phase 1: Hands-on (now)**
Build it out. GSD first, prove the playbook. Every community onboarding is
manual — Root does the demo, the listing, the config, the relationship.

**Phase 2: Repeatable (target: 1 community/week)**
- GSD → Bags.fm communities (50+) → PumpFun communities (50+)
- Same template each time: list pool in curator.json, deploy subdomain,
  record demo video (Root in a suit), share in community X/Telegram/Discord
- Weekly cadence minimum

**Phase 3: Agentic maintenance**
Once the onboarding playbook is proven and communities are live, the
maintenance grind becomes agent work (local model or paid API):
- Monitor pool health per community (volume, arb activity, sync status)
- Refresh supply numbers in curator.json
- Flag dead pools (no volume in X days → remove listing)
- Alert when new tokens hit volume thresholds on PumpFun/Bags (prospect list)
- Post daily stats to community channels
- Enforce "communities earn their spot" rule automatically

**What stays human:**
- Weekly demo video (trust moment, the face of the project)
- Relationship with community leads
- Strategic decisions on who gets onboarded
- Creative building (subnet, new features, protocol upgrades)

**Phase 4: CEO / BD hire**
When the revenue supports it (or from subnet emissions budget), bring on
someone to run the community sales motion full-time. Root focuses on
subnet intelligence layer and protocol engineering.

### Telegram Adapter
- Core-SDK is platform-agnostic (user_id: "discord:123" or "tg:789")
- ~300-400 lines to build
- Opens up Telegram communities (larger TAM for trading bots)
- **Action:** After Discord is proven and polished

### Nansen Data Enrichment
- Nansen hackathon + agent API
- Smart money signals, wallet profiling, token screening
- MCP integration trendy right now
- Build commitment — not a priority, but a differentiation angle

### PumpSwap Sync Bot
- Keeps Meteora DLMM in sync with PumpSwap price
- Without it, positions sit unfilled on quiet pools
- Infrastructure, not GTM — but affects user experience
- **Action:** Build as infrastructure. Evaluate if self-funding via arb profit.

### Perpolator (Permissionless Perps)
- "PumpFun for perpetuals" — Toly follows, 35K MC
- Future composability angle: could crank.money wrap perp positions?
- Very long-term, not a GTM priority

---

## Competitor Landscape

### Swap Bots (different category — they swap, we LP)

| Bot | Type | Fee | Rev Share | Unique Angle |
|-----|------|-----|-----------|--------------|
| Trojan | Swap bot | ~0.5-1% | 0% | Speed, UX |
| Bonkbot | Swap bot | ~0.5-1% | 0% | Telegram native |
| Banana Gun | Swap bot | ~0.5-1% | Token buyback | Sniper, MEV |
| Maestro | Swap bot | ~1% | 0% | Multi-chain |
| GMGN | Swap/analytics | Varies | 0% | Smart money tracking |
| BankrBot | Text-based trading | TBD | TBD | X post execution, agent CLI, Hyperliquid |

### LP Automation (same category — direct competitors)

| Player | Status | Traction | Model | What They Don't Do |
|--------|--------|----------|-------|--------------------|
| **MetEngine** | C3 accelerator, 2nd Place DeFi Breakout ($20K) | $26M vol, 2K users, $400K fees | Copy-LP via Telegram (mirror top wallets, 5 sizing strategies) | No community treasury, no Merkle distro, no B2B |
| **HawkFi** | Live, rebranding from Hawksight | $50M TVL, $9.4M all-time fees, $5.8B vol | Vault-based auto-rebalance (Meteora DLMM + Orca CLMM) | No community treasury, no Merkle distro, no B2B |
| **LP Agent** | Live on The Grid | Unknown | AI chatbot for pool discovery + rebalancing | No community dimension, no distribution |
| **Maiker.fun** | Early access (The Grid) | Unknown | Concentrated liquidity vaults | Vault model, individual deposits |
| **crank.money** | **Live, hackathon mode** | **Production bot, 5 on-chain programs** | **Community LP-as-a-Service + Merkle fee distribution** | **The only one doing B2B community treasury LP** |

### Colosseum Hackathon Context (Copilot deep dive, 2026-04-07)
- 10+ LP automation projects across Breakout and Cypherpunk hackathons — ALL B2C individual LP tools
- MetEngine is the benchmark: $26M vol + C3 accelerator. To compete, need working epoch distributions or community traction.
- Zero projects do community LP-as-a-Service with Merkle distribution. The segment is open.
- 55 yield aggregators indexed on The Grid for Solana. Crowded for individual LP, open for community LP.

---

## Key Relationships

| Contact | Connection | Action |
|---------|------------|--------|
| Helius (Mert) | Angel checks, LaserStream customer | Warm intro for funding |
| MonkeDAO (Simon) | Incubator, Shek — GTM help | Incubator application |
| LP Army | Lochie, partnership page, content collab | Partner page listing |
| Sanctum (Eno) | INF as potential treasury/partner play | Evaluate, pitch if aligned |

---

## Analytics — What to Track and Show

### Discord `#crank-stats` Channel (Daily Automated Post)
```
--- crank.money daily stats ---
Users:          42 custody wallets
Active today:   7 users
Volume:         $12,340 (opened + closed)
Harvests:       23 (total: $890 harvested)
Fees earned:    $2.67 protocol / $8.90 user LP fees
SOL dist:       0.12 SOL (epoch #14)
Uptime:         99.8% (last 7d)
```

### `/stats` Slash Command (On-Demand)
Same data, available to any user in the Discord.

### What These Numbers Unlock
- **Mert pitch:** "Here's our traction — X users, $Y volume, Z harvests per day"
- **Community pitches:** "GSD pool did $X volume in week 1"
- **Superteam/grant applications:** Real metrics, not promises
- **LP Army content:** "Users averaged X% better than manual LP"

### Implementation
- Bot already has relay endpoints (`/api/stats`, `/api/positions`, `/api/fees`)
- `walletService` tracks user count, positions, harvest totals
- Add a daily cron that posts formatted stats to `#crank-stats`
- Add `/stats` command to the bot (16th command)
- Track volume: log USD value of every `/buy` and `/close` (DexScreener price at execution time)

---

## Action Priority (Hackathon Sequence — April 2026)

**Phase A — Ship quietly (first half of hackathon):**
1. ~~**PDA vault migration**~~ — **DONE (2026-04-08).** Non-custodial vaults, 8 new instructions, gas model, all commands updated.
2. **Epoch E2E test** — code hardened + 27 unit tests + test script ready. Run `scripts/test-epoch.ts` after bin-farm deploy.
3. **$BANK metadata** — register Metaplex metadata so token stops looking like a scam
4. **Web rebrand** — reposition as "community-first market making tool"

**Phase B — Go public (second half of hackathon):**
5. **Activate @libraryofCrank** — turn on the CRM X agent, start tribal engagement
6. **LP Army demos** — AlekssRG (rated 10), satsmonkes, cryptattttone. They understand DLMM, they're warm.
7. **Record demo video** — "how this tool benefits your community"
8. **Build analytics** — `#crank-stats` channel + `/stats` command (show real numbers)

**Post-hackathon:**
9. **DM warm leads** — Mert, Eno, Simon, Shek, Tamar, Sepherim
10. **LP Army partnership** — partner page + content series
11. **Superteam + Luminaries** — grants + distribution
12. **Dexter/x402 integration** — SDK eval + demo for BranchM
