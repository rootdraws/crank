# Bot Integration Spec — BANK Token Distribution System

Handoff document for integrating the on-chain programs with the crank.money bot.
Covers all program interactions, the daily epoch cycle, fee indexing, Merkle tree
construction, IPFS pinning, auto-claiming, and bot command specifications.

## Program Overview

| Program | ID | Purpose |
|---------|----|---------| 
| bank-mint | `FjK8AaLTfj8fP8bf88tmwCxu2xyhTXhaSkHGzCEZyczk` | Burn $CRANK → mint $BANK 1:1 |
| gauge-voter | `DRhe2EXWWPM3G9qRUeGmnVWsV4joxQ5pBw2qXPereQrA` | Global-state pool weight voting |
| merkle-distributor | `DWmPoHsRQ4PAff3zY8wuLMpogukmmiCxfFewmB5WQ8kV` | Cumulative $PEGGED distribution via Merkle proofs |
| bin-farm (updated) | `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` | Trading + 40/40/20 fee split |
| pegged-bridge | `7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN` | SOL → stake → $PEGGED routing |

Codama-generated TypeScript clients: run `node scripts/generate-clients.mjs` after
`anchor build`. Clients are output to `src/generated/`.

## PDA Seeds Reference

| PDA | Seeds | Program |
|-----|-------|---------|
| BankConfig | `[b"bank_config"]` | bank-mint |
| GaugeConfig | `[b"gauge_config"]` | gauge-voter |
| PoolGauge | `[b"pool_gauge", lb_pair.key()]` | gauge-voter |
| Distributor | `[b"distributor"]` | merkle-distributor |
| ClaimStatus | `[b"claim_status", distributor.key(), claimant.key()]` | merkle-distributor |
| RoverAuthority | `[b"rover_authority"]` | bin-farm |
| BridgeConfig | `[b"bridge_config"]` | pegged-bridge |
| BridgeVault | `[b"bridge_vault"]` | pegged-bridge |

## Token Addresses

| Token | Mint | Decimals |
|-------|------|----------|
| $CRANK | `Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump` | 6 |
| $BANK | TBD (created at deployment) | 6 |
| $PEGGED (crankSOL) | `GmqNKeVoKJiF52xRriHXsmmgvTWpkU4UVn2LdPgEiEX1` | 9 |

## Revenue Split (bin-farm sweep_rover)

```
40% → revenue_dest (bridge_vault → stake → $PEGGED → Merkle vault) — BANK holders
40% → trader_dest (accumulates for trader rewards) — traders
20% → Config.bot — bot operations
```

The bot must call `set_trader_dest` on the RoverAuthority before the new split
is active. This is a one-time admin instruction.

---

## Daily Epoch Cycle

**Trigger:** Cron at **4:20 PM CST / 22:20 UTC** daily.

### Step 1: Snapshot BANK Holders

```typescript
// Get all BANK token accounts
const bankAccounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
  filters: [
    { dataSize: 165 },
    { memcmp: { offset: 0, bytes: BANK_MINT.toBase58() } },
  ],
});

// Parse: Map<walletPubkey, balance>
const holderBalances = new Map<string, bigint>();
for (const { account } of bankAccounts) {
  const owner = new PublicKey(account.data.slice(32, 64));
  const amount = account.data.readBigUInt64LE(64);
  if (amount > 0n) {
    holderBalances.set(owner.toBase58(), amount);
  }
}
```

**LP Attribution:** Read BANK reserve balance from the CRANK/BANK DAMM v2 pool
and credit it to the protocol wallet.

```typescript
const poolBankReserve = await connection.getTokenAccountBalance(
  CRANK_BANK_POOL_BANK_RESERVE_ATA
);
const lpAttributedBank = BigInt(poolBankReserve.value.amount);

// Credit to protocol wallet
const currentProtocol = holderBalances.get(PROTOCOL_WALLET) ?? 0n;
holderBalances.set(PROTOCOL_WALLET, currentProtocol + lpAttributedBank);
```

Compute total effective supply (sum of all balances including LP-attributed).

### Step 2: Read Trader Activity

Parse `HarvestEvent` logs since the last epoch boundary. The bot should
accumulate these in real-time via gRPC/Laserstream subscription.

```typescript
interface FeeRecord {
  timestamp: number;
  lbPair: string;     // Pool address
  owner: string;      // Custody wallet
  feeAmount: bigint;  // Fees paid (lamports)
}

// Accumulated since last epoch:
// Map<lbPair, Map<owner, totalFees>>
const feesByPool: Map<string, Map<string, bigint>>;
```

`HarvestEvent` fields used:
- `owner: Pubkey` — the custody wallet that owns the position
- `lb_pair: Pubkey` — the Meteora DLMM pool address
- `fee_amount: u64` — fees paid on this harvest

### Step 3: Read the Gauge Dial

```typescript
const gaugeAccounts = await connection.getProgramAccounts(GAUGE_VOTER_PROGRAM, {
  filters: [{ memcmp: { offset: 0, bytes: POOL_GAUGE_DISCRIMINATOR } }],
});

// Map<lbPair, weightBps>
const poolWeights = new Map<string, number>();
for (const { account } of gaugeAccounts) {
  const gauge = decodePoolGauge(account.data);
  if (gauge.enabled) {
    poolWeights.set(gauge.lbPair.toBase58(), Number(gauge.weightBps));
  }
}
```

### Step 4: Compute Per-Wallet Rewards

```typescript
// Read current balances from the two accumulation accounts
const holderPot = await getTokenBalance(HOLDER_PEGGED_ATA);  // 40% share
const traderPot = await getTokenBalance(TRADER_PEGGED_ATA);  // 40% share

const rewards = new Map<string, bigint>(); // wallet -> epoch reward

// --- BANK Holder 40% ---
const totalEffectiveSupply = [...holderBalances.values()].reduce((a, b) => a + b, 0n);
for (const [wallet, balance] of holderBalances) {
  const holderReward = (balance * holderPot) / totalEffectiveSupply;
  rewards.set(wallet, (rewards.get(wallet) ?? 0n) + holderReward);
}

// --- Trader 40% ---
for (const [lbPair, userFees] of feesByPool) {
  const weightBps = poolWeights.get(lbPair) ?? 0;
  if (weightBps === 0) continue;

  const poolTotalFees = [...userFees.values()].reduce((a, b) => a + b, 0n);
  if (poolTotalFees === 0n) continue;

  for (const [wallet, fees] of userFees) {
    const traderReward = (BigInt(weightBps) * fees * traderPot) / (10000n * poolTotalFees);
    rewards.set(wallet, (rewards.get(wallet) ?? 0n) + traderReward);
  }
}

// Apply minimum threshold — skip dust payouts
const MIN_REWARD = 1000n; // configurable
for (const [wallet, amount] of rewards) {
  if (amount < MIN_REWARD) rewards.delete(wallet);
}
```

### Step 5: Build Unified Merkle Tree

Each leaf: `keccak256(index || wallet || cumulative_amount)`.

```typescript
import { keccak256 } from '@noble/hashes/sha3';

interface MerkleLeaf {
  index: number;
  wallet: string;
  cumulativeAmount: bigint; // previous cumulative + this epoch's reward
}

// Load previous cumulative amounts from last epoch's tree
const previousTree = loadPreviousTree(); // from IPFS or local DB

const leaves: MerkleLeaf[] = [];
let index = 0;
for (const [wallet, epochReward] of rewards) {
  const prevCumulative = previousTree.get(wallet) ?? 0n;
  leaves.push({
    index: index++,
    wallet,
    cumulativeAmount: prevCumulative + epochReward,
  });
}

// Also include wallets from previous tree that didn't earn this epoch
// (their cumulative stays the same — they can still claim)
for (const [wallet, cumAmount] of previousTree) {
  if (!rewards.has(wallet)) {
    leaves.push({ index: index++, wallet, cumulativeAmount: cumAmount });
  }
}

// Build tree
const tree = buildMerkleTree(leaves);
const root: Uint8Array = tree.root; // 32 bytes
```

### Step 6: Pin to IPFS

```typescript
const treeJson = {
  epoch: currentEpoch,
  timestamp: Date.now(),
  root: Buffer.from(root).toString('hex'),
  totalAmount: totalEpochReward.toString(),
  leaves: leaves.map(l => ({
    index: l.index,
    wallet: l.wallet,
    cumulativeAmount: l.cumulativeAmount.toString(),
    // Transparency breakdown (not used on-chain, for verification only)
    holderReward: holderRewards.get(l.wallet)?.toString() ?? '0',
    traderReward: traderRewards.get(l.wallet)?.toString() ?? '0',
  })),
};

const cid = await ipfsPin(JSON.stringify(treeJson));
// Store locally: epoch -> { root, cid, treeJson }
```

### Step 7: Upload Merkle Root On-Chain

```typescript
import { getNewEpochInstruction } from '../src/generated/merkle-distributor';

const ix = getNewEpochInstruction({
  distributor: DISTRIBUTOR_PDA,
  authority: botKeypair.publicKey,
  mint: PEGGED_MINT,
  vault: DISTRIBUTOR_VAULT_ATA,
  funderAta: BOT_PEGGED_ATA,
  tokenProgram: TOKEN_PROGRAM_ID,
}, {
  merkleRoot: Array.from(root),
  epochAmount: totalEpochReward,
  ipfsCid: cid,
});

await sendTransaction(ix);
```

### Step 8: Notify All Recipients

Fire immediately after root is confirmed on-chain — before claiming.

```
📢 Epoch 42 rewards ready!
You got PEGGED! = 0.25
```

Notification fires for every wallet in the tree that earned > 0 this epoch.

### Step 9: Auto-Claim for Custody Wallets

```typescript
import { getClaimInstruction } from '../src/generated/merkle-distributor';

for (const leaf of leaves) {
  const proof = tree.getProof(leaf.index);
  const claimStatus = deriveClaimStatusPDA(DISTRIBUTOR_PDA, leaf.wallet);

  // Check if already claimed this amount
  const existing = await fetchClaimStatus(claimStatus);
  if (existing && existing.cumulativeClaimed >= leaf.cumulativeAmount) continue;

  // Check user has SOL for tx fee
  const userBalance = await connection.getBalance(new PublicKey(leaf.wallet));
  if (userBalance < 10_000) {
    notify(leaf.wallet, "Top up SOL to claim your PEGGED");
    continue;
  }

  const ix = getClaimInstruction({
    payer: new PublicKey(leaf.wallet), // user's SOL pays
    distributor: DISTRIBUTOR_PDA,
    mint: PEGGED_MINT,
    vault: DISTRIBUTOR_VAULT_ATA,
    claimant: new PublicKey(leaf.wallet),
    claimantAta: getAssociatedTokenAddress(PEGGED_MINT, new PublicKey(leaf.wallet)),
    claimStatus,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }, {
    index: leaf.index,
    cumulativeAmount: leaf.cumulativeAmount,
    proof: proof.map(p => Array.from(p)),
  });

  // Sign with custody wallet keypair (bot controls these)
  await sendTransaction(ix, custodyKeypair(leaf.wallet));
}
```

---

## Fee Indexing

### Real-Time Event Listener

The bot should subscribe to `bin-farm` program logs via gRPC/Laserstream
and extract `HarvestEvent` data as it happens.

```typescript
// Schema for accumulated fee records
interface FeeEpochStore {
  epochStart: number;       // Unix timestamp of epoch boundary
  records: FeeRecord[];     // All HarvestEvents since epochStart
}

// On each HarvestEvent:
feeStore.records.push({
  timestamp: event.timestamp,
  lbPair: event.lbPair.toBase58(),
  owner: event.owner.toBase58(),
  feeAmount: BigInt(event.feeAmount),
});

// At epoch time: aggregate and reset
const aggregated = aggregateByPoolAndOwner(feeStore.records);
feeStore.records = [];
feeStore.epochStart = Date.now();
```

### Epoch Metadata

```typescript
interface EpochMetadata {
  epoch: number;
  timestamp: number;
  merkleRoot: string;     // hex
  ipfsCid: string;
  totalAmount: string;    // base units
  holderPot: string;
  traderPot: string;
  leafCount: number;
}

// Store: epoch -> EpochMetadata (SQLite, JSON file, or in-memory)
```

---

## Missed Epoch Handling

If the bot goes down and misses the 4:20 PM CST trigger:
- **No $PEGGED is lost.** Funds sit in the holder/trader accumulation accounts.
- On next successful run, the epoch covers the full period since the last root.
- Rewards are computed normally — just a larger window.

**Alerting:** If the cron doesn't fire within 10 minutes of schedule, send a
Telegram ping to admin: "Epoch distribution missed — bot may be down."

---

## Bot Commands

### /burn \<amount\>

Calls `burn_and_mint` on `bank-mint`. User specifies amount of $CRANK to burn.

```typescript
const ix = getBurnAndMintInstruction({
  user: custodyWallet,
  config: BANK_CONFIG_PDA,
  crankMint: CRANK_MINT,
  bankMint: BANK_MINT,
  userCrankAta: getUserCrankAta(custodyWallet),
  userBankAta: getUserBankAta(custodyWallet),
  crankTokenProgram: TOKEN_PROGRAM_ID,
  bankTokenProgram: TOKEN_PROGRAM_ID,
}, { amount: parsedAmount });
```

### /vote \<pool\> [\<weight\>]

Calls `vote` on `gauge-voter`. User allocates their BANK voting weight.

Examples:
- `/vote crank` → 100% to CRANK/SOL pool
- `/vote crank 60 sol 40` → 60% CRANK/SOL, 40% SOL/USDC

```typescript
const allocations = parseVoteCommand(userInput);
// allocations: [{ lbPair, weightBps }]

const poolGaugeAccounts = allocations.map(a =>
  derivePoolGaugePDA(a.lbPair)
);

const ix = getVoteInstruction({
  voter: custodyWallet,
  config: GAUGE_CONFIG_PDA,
  bankMint: BANK_MINT,
  userBankAta: getUserBankAta(custodyWallet),
  tokenProgram: TOKEN_PROGRAM_ID,
}, {
  desiredAllocations: allocations,
}, {
  remainingAccounts: poolGaugeAccounts, // pass as remaining_accounts
});
```

### /gauge or /weights

Read-only. Fetches all `PoolGauge` PDAs and displays current weights.

```
Pool Weights:
CRANK/SOL  ████████████████████  70.0%
SOL/USDC   ████████              30.0%
```

### /balance

Shows user's $PEGGED balance + unclaimed amount from current Merkle tree.

```typescript
const peggedBalance = await getTokenBalance(userPeggedAta);
const claimStatus = await fetchClaimStatus(deriveClaimStatusPDA(DISTRIBUTOR_PDA, wallet));
const treeEntry = currentTree.find(l => l.wallet === wallet);
const unclaimed = treeEntry
  ? treeEntry.cumulativeAmount - (claimStatus?.cumulativeClaimed ?? 0n)
  : 0n;
```

```
$PEGGED Balance: 1.250000000
Unclaimed:       0.470000000
```

### /verify \<epoch\>

Fetches tree JSON from IPFS, verifies against on-chain root.

```typescript
const treeJson = await ipfsFetch(epochMetadata.ipfsCid);
const recomputedRoot = buildMerkleTree(treeJson.leaves).root;
const onChainRoot = (await fetchDistributor(DISTRIBUTOR_PDA)).merkleRoot;
const valid = Buffer.from(recomputedRoot).equals(Buffer.from(onChainRoot));
```

```
Epoch 42 verification: ✓ VALID
Root: 0xabc123...
IPFS: QmXyz...
Leaves: 147
Total: 12.500000000 PEGGED
```

---

## Data Durability

- **IPFS:** Each epoch's full Merkle tree JSON is pinned to IPFS.
  Content-addressed and immutable. Serves as both transparency layer and backup.
- **Local store:** SQLite or JSON files for fast access to current state:
  - `epochs/` — one file per epoch with metadata + tree
  - `fees/` — accumulated HarvestEvent records
  - `claims/` — local cache of claim statuses
- **Reconstruction:** Even if local DB is lost, full state can be rebuilt from:
  - IPFS trees (all historical leaves + cumulative amounts)
  - On-chain event logs (HarvestEvents, BurnAndMintEvents, VoteEvents)
  - On-chain Distributor state (current epoch, root)
  - On-chain ClaimStatus PDAs (per-user claimed amounts)

---

## Deployment Sequence

1. **Deploy `bank-mint` program** → get program ID
2. **Create $BANK mint** (deployer as initial authority, 6 decimals)
3. **Mint migration credit** to deployer wallet (`2B - current_crank_supply`)
4. **Transfer mint authority** to BankConfig PDA
5. **Call `bank-mint::initialize`**
6. **Deploy `gauge-voter` program** → call `initialize` with BANK mint
7. **Add initial pools** via `gauge-voter::add_pool` (e.g., CRANK/SOL)
8. **Deploy `merkle-distributor` program** → call `initialize` with $PEGGED mint
9. **Call `bin-farm::set_trader_dest`** with trader accumulation wallet
10. **Call `pegged-bridge::update_config`** to reroute $PEGGED to distributor vault
    (or bot-controlled intermediate)
11. **Create CRANK/BANK + CRANK/PEGGED DAMM v2 pools** on Meteora, lock liquidity
12. **Configure bot** with all program IDs, PDAs, pool addresses
13. **Start epoch cron** at 4:20 PM CST

---

## Account Layouts

### BankConfig (bank-mint)

| Field | Type | Offset |
|-------|------|--------|
| authority | Pubkey | 8 |
| pending_authority | Pubkey | 40 |
| crank_mint | Pubkey | 72 |
| bank_mint | Pubkey | 104 |
| total_burned | u64 | 136 |
| paused | bool | 144 |
| bump | u8 | 145 |

### GaugeConfig (gauge-voter)

| Field | Type | Offset |
|-------|------|--------|
| authority | Pubkey | 8 |
| pending_authority | Pubkey | 40 |
| bank_mint | Pubkey | 72 |
| pool_count | u16 | 104 |
| paused | bool | 106 |
| bump | u8 | 107 |

### PoolGauge (gauge-voter)

| Field | Type | Offset |
|-------|------|--------|
| lb_pair | Pubkey | 8 |
| weight_bps | u64 | 40 |
| enabled | bool | 48 |
| bump | u8 | 49 |

### Distributor (merkle-distributor)

| Field | Type | Offset |
|-------|------|--------|
| authority | Pubkey | 8 |
| pending_authority | Pubkey | 40 |
| mint | Pubkey | 72 |
| vault | Pubkey | 104 |
| current_epoch | u64 | 136 |
| merkle_root | [u8; 32] | 144 |
| total_amount_funded | u64 | 176 |
| total_amount_claimed | u64 | 184 |
| paused | bool | 192 |
| bump | u8 | 193 |
| ipfs_cid | String | 194 |

### ClaimStatus (merkle-distributor)

| Field | Type | Offset |
|-------|------|--------|
| cumulative_claimed | u64 | 8 |
| last_claim_epoch | u64 | 16 |

### RoverAuthority (bin-farm, updated)

| Field | Type | Offset |
|-------|------|--------|
| revenue_dest | Pubkey | 8 |
| total_rover_positions | u64 | 40 |
| bump | u8 | 48 |
| pending_revenue_dest | Pubkey | 49 |
| revenue_dest_change_at | i64 | 81 |
| trader_dest | Pubkey | 89 |
| _reserved | [u8; 32] | 121 |

---

## Events to Index

### HarvestEvent (bin-farm)

```rust
pub struct HarvestEvent {
    pub position: Pubkey,
    pub owner: Pubkey,       // custody wallet
    pub lb_pair: Pubkey,     // pool address
    pub harvester: Pubkey,
    pub bin_ids: Vec<i32>,
    pub token_x_amount: u64,
    pub token_y_amount: u64,
    pub fee_amount: u64,     // <-- fees paid, the metric for trader rewards
    pub keeper_tip: u64,
    pub total_harvested: u64,
}
```

### RoverSweptEvent (bin-farm, updated)

```rust
pub struct RoverSweptEvent {
    pub amount: u64,
    pub holder_share: u64,   // 40%
    pub trader_share: u64,   // 40%
    pub operator_share: u64, // 20%
    pub holder_dest: Pubkey,
    pub trader_dest: Pubkey,
    pub bot: Pubkey,
    pub timestamp: i64,
}
```

### BurnAndMintEvent (bank-mint)

```rust
pub struct BurnAndMintEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub crank_supply_post_burn: u64,
    pub bank_supply_post_mint: u64,
}
```

### VoteEvent (gauge-voter)

```rust
pub struct VoteEvent {
    pub voter: Pubkey,
    pub balance: u64,
    pub total_supply: u64,
}
```

### NewEpochEvent (merkle-distributor)

```rust
pub struct NewEpochEvent {
    pub epoch: u64,
    pub merkle_root: [u8; 32],
    pub epoch_amount: u64,
    pub total_funded: u64,
    pub ipfs_cid: String,
}
```

### ClaimEvent (merkle-distributor)

```rust
pub struct ClaimEvent {
    pub claimant: Pubkey,
    pub index: u64,
    pub cumulative_amount: u64,
    pub claimed_this_tx: u64,
    pub epoch: u64,
}
```
