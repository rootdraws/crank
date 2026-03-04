# Phantom / Blowfish Escalation — monke.army

**To:** Joey (Phantom Customer Happiness) / Phantom Security & Trust Team
**From:** Kyle Jacobs (rootdraws@gmail.com)
**Date:** March 2026
**Site:** https://www.monke.army
**Phantom Portal App ID:** `89b27865-826e-439c-93c3-80464b758b51`

---

## The Issue

Users see **"Request Blocked — this site could be malicious"** when approving LP position transactions on monke.army. However, other transactions on the **same domain, same SDK, same `signAndSendTransaction` path** pass without issue.

This is not a domain-level block. It is **per-transaction Blowfish risk scoring**.

## Proof: Same Domain, Different Outcomes

All transactions use:
- Phantom Connect Browser SDK (`@phantom/browser-sdk`)
- `phantomSDK.solana.signAndSendTransaction(tx)`
- Legacy `solanaWeb3.Transaction` (not versioned)
- Same RPC, same fee payer, same wallet

| Transaction | Program | Result |
|---|---|---|
| `feedMonke` (burn 1M BANANAS) | `monke_bananas` | **PASSES** |
| `feedGoose` (burn 1M BANANAS) | `monke_bananas` | **PASSES** |
| `openPositionV2` (create LP) | `bin_farm` | **BLOCKED** |
| `userClose` (close LP) | `bin_farm` | **BLOCKED** |
| `harvestBins` (harvest LP) | `bin_farm` | **BLOCKED** |
| `claimFees` (claim LP fees) | `bin_farm` | **BLOCKED** |

The burn transactions pass because Blowfish recognizes `spl_token::burn` as a known-safe CPI pattern (tokens destroyed, not redirected). The LP transactions are flagged because Blowfish doesn't recognize our program and interprets token movement to program-owned vaults as potential drain behavior.

## What Our Programs Actually Do

**`bin_farm` (`8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia`)** — Automated LP position management on Meteora DLMM. Users deposit tokens into program-owned vaults; the program CPIs into Meteora DLMM (`LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`) to manage concentrated liquidity positions. When positions are closed, tokens are returned to the user minus a protocol fee.

**`monke_bananas` (`myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH`)** — Reward distribution for SMB NFT holders. Burns BANANAS tokens and distributes SOL/$PEGGED rewards.

**`pegged_bridge` (`7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN`)** — Bridges SOL to a Sanctum SPL stake pool, minting $PEGGED LST.

All three are **Anchor programs** deployed as BPF upgradeable programs on Solana mainnet. Open source.

## What Blowfish Sees That Triggers the Block

When Blowfish simulates an `openPositionV2` transaction, the simulation output shows:

1. **`SystemProgram.transfer`** — SOL wrapping for WSOL deposit. Blowfish interprets this as "user sends SOL to unknown address."
2. **`createAssociatedTokenAccount` for program-owned PDAs** — Vault ATAs where the owner is a PDA, not the user. Blowfish interprets this as "user pays rent for someone else's account."
3. **Token transfer to vault PDA** — User's tokens flow into a vault the user doesn't own. Blowfish interprets this as potential drain.
4. **CPI chain: `bin_farm` → Meteora DLMM** — Two unregistered programs in a CPI chain.
5. **Partial signature from generated keypair** — The Meteora position account is a keypair (Meteora's design), so the tx arrives at Phantom pre-signed by an unknown key.

Each of these is an independent risk signal. Combined in one transaction, they exceed Blowfish's block threshold.

The burn transaction has **none** of these signals — it's `spl_token::burn` (tokens destroyed to void), single CPI depth, no SOL transfer, no third-party account creation.

## What We Changed (deployed today)

We restructured all LP transactions to separate infrastructure setup from program execution:

### Before: `createPosition` (up to 10 instructions in one TX)

```
1. ComputeBudget.setComputeUnitLimit(400k)
2. ComputeBudget.setComputeUnitPrice(100k)
3. DLMM.initializeBinArray           ← user pays rent for DLMM account
4. DLMM.initializeBinArray           ← user pays rent for DLMM account
5. AToken.createIdempotent(user)      ← user deposit ATA
6. System.transfer (SOL→WSOL)        ← "user sends X SOL"
7. Token.syncNative
8. AToken.createIdempotent(vault)     ← ATA for non-user PDA
9. AToken.createIdempotent(vault)     ← ATA for non-user PDA
10. bin_farm.openPositionV2           ← CPI into unregistered program
+ partialSign(positionKeypair)        ← external signer
```

### After: Split into Setup TX + Execute TX

**Setup TX** (standard SPL/System ops only — should pass Blowfish):
```
1. ComputeBudget.setComputeUnitLimit(200k)
2. ComputeBudget.setComputeUnitPrice(100k)
3. AToken.createIdempotent(user)
4. AToken.createIdempotent(vault)
5. AToken.createIdempotent(vault)
6. DLMM.initializeBinArray
7. DLMM.initializeBinArray
8. System.transfer (SOL→WSOL)
9. Token.syncNative
```

**Execute TX** (3 instructions — structurally identical to the burn TX that passes):
```
1. ComputeBudget.setComputeUnitLimit(400k)
2. ComputeBudget.setComputeUnitPrice(100k)
3. bin_farm.openPositionV2
+ partialSign(positionKeypair)
```

Note: The Setup TX is **skipped entirely** when all accounts already exist (common case for returning users). They see a single wallet popup with just 3 instructions.

### Before: `closePosition` / `harvestBins` (up to 7 instructions)

```
1. ComputeBudget.setComputeUnitLimit(400k)
2. ComputeBudget.setComputeUnitPrice(100k)
3. AToken.createIdempotent(user)       ← user token X ATA
4. AToken.createIdempotent(user)       ← user token Y ATA
5. AToken.createIdempotent(rover)      ← ATA for non-user PDA
6. AToken.createIdempotent(rover)      ← ATA for non-user PDA
7. bin_farm.userClose / harvestBins    ← CPI into unregistered program
```

### After: Split into Setup TX + Execute TX

**Execute TX** (3 instructions):
```
1. ComputeBudget.setComputeUnitLimit(400k)
2. ComputeBudget.setComputeUnitPrice(100k)
3. bin_farm.userClose / bin_farm.harvestBins
```

### Reference: `feedMonke` burn TX (passes Blowfish today, 3 instructions)

```
1. ComputeBudget.setComputeUnitLimit(200k)
2. ComputeBudget.setComputeUnitPrice(100k)
3. monke_bananas.feedMonke
```

All execute TXs now match this 3-instruction pattern.

## What We Need From Phantom / Blowfish

1. **Register our program IDs with Blowfish's transaction decoder.** Once Blowfish can decode `bin_farm` instructions, it will understand that `openPositionV2` is a legitimate LP deposit (not a drain) and `userClose` returns tokens to the user (not steals them).

   - `8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia` — bin_farm (LP position management)
   - `myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH` — monke_bananas (reward distribution)
   - `7oHSUPzkPDDtxjXcvjRYKHmSjoBigJ4HUvPRRhf1SCgN` — pegged_bridge (SOL→LST bridge)

2. **Fix Phantom Portal program indexing.** When we submit these addresses in the Portal contract verification flow, it says "Address is not a smart contract." These are live, deployed BPF upgradeable programs on Solana mainnet. Something in the indexer doesn't recognize them.

3. **We can provide:**
   - Anchor IDLs for all three programs (JSON, machine-readable instruction definitions)
   - Open-source code (GitHub: https://github.com/rootdraws/monke-army)
   - Test transaction signatures on mainnet for each instruction type
   - Any additional documentation Blowfish needs to build decoders

## Summary

The block is per-transaction Blowfish scoring, not domain-level. Our restructured transactions now have the same 3-instruction shape as the burn TX that already passes. But the real fix is Blowfish program registration so it can decode our instructions and understand the semantics (LP deposit, not drain).

We're building legitimate DeFi tooling for Solana NFT communities (MonkeDAO, GooseDAO). Our users can't use the product because of this block. Happy to jump on a call or provide any additional information to get this resolved.

— Kyle
