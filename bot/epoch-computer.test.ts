/**
 * epoch-computer.test.ts
 *
 * Unit tests for epoch distribution logic — Merkle tree, share computation,
 * proof verification. No RPC, no chain dependency.
 *
 * The proof verification test is the most critical: if it passes, on-chain
 * claim() will succeed because it uses the same keccak256 + sorted pair hashing.
 *
 * Run: npx vitest run bot/epoch-computer.test.ts
 */

import { describe, it, expect } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import {
  solanaKeccak256, hashLeaf, hashPair, buildMerkleTree,
  computeShares,
  reconcileEntitlementsAgainstOnChain,
  type EpochState, type UserShare,
} from './epoch-computer';

// ═══ HELPERS ═══

/** Create a deterministic PublicKey from a seed number. */
function pubkey(n: number): PublicKey {
  const buf = Buffer.alloc(32);
  buf.writeUInt32LE(n);
  return new PublicKey(buf);
}

/** Mock WalletService data shape for computeShares. */
function mockWalletService(opts: {
  harvests?: any[];
  users?: Record<string, any>;
  vaultIndex?: Record<string, string>;
}): any {
  return {
    data: {
      harvests: opts.harvests || [],
      users: opts.users || {},
      vaultIndex: opts.vaultIndex || {},
      pubkeyIndex: {},
    },
  };
}

/**
 * Replay a Merkle proof against the root (mirrors on-chain claim() logic).
 * This is the same algorithm as solana_program::keccak::hashv in merkle-distributor.
 */
function verifyProof(leaf: Buffer, proof: Buffer[], root: Buffer): boolean {
  let current = leaf;
  for (const node of proof) {
    if (Buffer.compare(current, node) <= 0) {
      current = solanaKeccak256(current, node);
    } else {
      current = solanaKeccak256(node, current);
    }
  }
  return Buffer.compare(current, root) === 0;
}

// ═══ TESTS ═══

describe('solanaKeccak256', () => {
  it('produces 32-byte output', () => {
    const h = solanaKeccak256(Buffer.from('test'));
    expect(h.length).toBe(32);
  });

  it('is deterministic', () => {
    const a = solanaKeccak256(Buffer.from('hello'));
    const b = solanaKeccak256(Buffer.from('hello'));
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('produces keccak-256 (not sha3-256)', () => {
    // Known keccak-256 of "test"
    const expected = '9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658';
    const actual = solanaKeccak256(Buffer.from('test')).toString('hex');
    expect(actual).toBe(expected);
  });
});

describe('hashLeaf', () => {
  it('hashes index (u64 LE) + wallet (32 bytes) + amount (u64 LE)', () => {
    const wallet = pubkey(1);
    const leaf = hashLeaf(0n, wallet, 1000000n);
    expect(leaf.length).toBe(32);

    // Verify manually: build the same buffer
    const indexBuf = Buffer.alloc(8);
    indexBuf.writeBigUInt64LE(0n);
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(1000000n);
    const expected = solanaKeccak256(indexBuf, wallet.toBuffer(), amountBuf);
    expect(Buffer.compare(leaf, expected)).toBe(0);
  });

  it('different indices produce different hashes', () => {
    const wallet = pubkey(1);
    const a = hashLeaf(0n, wallet, 1000n);
    const b = hashLeaf(1n, wallet, 1000n);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it('different amounts produce different hashes', () => {
    const wallet = pubkey(1);
    const a = hashLeaf(0n, wallet, 1000n);
    const b = hashLeaf(0n, wallet, 2000n);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });
});

describe('hashPair', () => {
  it('sorts by buffer comparison (smaller first)', () => {
    const a = Buffer.alloc(32, 0x01);
    const b = Buffer.alloc(32, 0x02);
    const ab = hashPair(a, b);
    const ba = hashPair(b, a);
    expect(Buffer.compare(ab, ba)).toBe(0); // commutative
  });

  it('handles equal inputs', () => {
    const a = Buffer.alloc(32, 0x05);
    const result = hashPair(a, a);
    expect(result.length).toBe(32);
    // hash(a, a) since a <= a
    const expected = solanaKeccak256(a, a);
    expect(Buffer.compare(result, expected)).toBe(0);
  });
});

describe('buildMerkleTree', () => {
  it('returns zero root for empty leaves', () => {
    const { root, proofs } = buildMerkleTree([]);
    expect(root).toEqual(Buffer.alloc(32));
    expect(proofs).toEqual([]);
  });

  it('returns leaf itself as root for single leaf', () => {
    const leaf = hashLeaf(0n, pubkey(1), 100n);
    const { root, proofs } = buildMerkleTree([leaf]);
    expect(Buffer.compare(root, leaf)).toBe(0);
    expect(proofs).toEqual([[]]);
  });

  it('builds correct root for 2 leaves', () => {
    const leaf0 = hashLeaf(0n, pubkey(1), 100n);
    const leaf1 = hashLeaf(1n, pubkey(2), 200n);
    const { root } = buildMerkleTree([leaf0, leaf1]);
    const expected = hashPair(leaf0, leaf1);
    expect(Buffer.compare(root, expected)).toBe(0);
  });

  it('pads to power of 2 for 3 leaves', () => {
    const leaves = [
      hashLeaf(0n, pubkey(1), 100n),
      hashLeaf(1n, pubkey(2), 200n),
      hashLeaf(2n, pubkey(3), 300n),
    ];
    const { root, proofs } = buildMerkleTree(leaves);
    expect(root.length).toBe(32);
    expect(proofs.length).toBe(3);
    // 3 leaves → padded to 4 → 2 levels → proof depth = 2
    expect(proofs[0].length).toBe(2);
    expect(proofs[1].length).toBe(2);
    expect(proofs[2].length).toBe(2);
  });

  it('is deterministic', () => {
    const leaves = [
      hashLeaf(0n, pubkey(1), 100n),
      hashLeaf(1n, pubkey(2), 200n),
      hashLeaf(2n, pubkey(3), 300n),
    ];
    const r1 = buildMerkleTree(leaves);
    const r2 = buildMerkleTree(leaves);
    expect(Buffer.compare(r1.root, r2.root)).toBe(0);
  });
});

describe('Merkle proof verification (critical)', () => {
  it('every leaf proof verifies against root — 2 leaves', () => {
    const leaves = [
      hashLeaf(0n, pubkey(1), 100n),
      hashLeaf(1n, pubkey(2), 200n),
    ];
    const { root, proofs } = buildMerkleTree(leaves);
    for (let i = 0; i < leaves.length; i++) {
      expect(verifyProof(leaves[i], proofs[i], root)).toBe(true);
    }
  });

  it('every leaf proof verifies against root — 3 leaves (padded)', () => {
    const leaves = [
      hashLeaf(0n, pubkey(1), 100n),
      hashLeaf(1n, pubkey(2), 200n),
      hashLeaf(2n, pubkey(3), 300n),
    ];
    const { root, proofs } = buildMerkleTree(leaves);
    for (let i = 0; i < leaves.length; i++) {
      expect(verifyProof(leaves[i], proofs[i], root)).toBe(true);
    }
  });

  it('every leaf proof verifies against root — 10 leaves', () => {
    const leaves = Array.from({ length: 10 }, (_, i) =>
      hashLeaf(BigInt(i), pubkey(i + 1), BigInt((i + 1) * 1_000_000))
    );
    const { root, proofs } = buildMerkleTree(leaves);
    for (let i = 0; i < leaves.length; i++) {
      expect(verifyProof(leaves[i], proofs[i], root)).toBe(true);
    }
  });

  it('every leaf proof verifies against root — 100 leaves', () => {
    const leaves = Array.from({ length: 100 }, (_, i) =>
      hashLeaf(BigInt(i), pubkey(i + 1), BigInt((i + 1) * 500_000))
    );
    const { root, proofs } = buildMerkleTree(leaves);
    for (let i = 0; i < leaves.length; i++) {
      expect(verifyProof(leaves[i], proofs[i], root)).toBe(true);
    }
  });

  it('wrong leaf does NOT verify', () => {
    const leaves = [
      hashLeaf(0n, pubkey(1), 100n),
      hashLeaf(1n, pubkey(2), 200n),
    ];
    const { root, proofs } = buildMerkleTree(leaves);
    const fakeLeaf = hashLeaf(0n, pubkey(99), 100n);
    expect(verifyProof(fakeLeaf, proofs[0], root)).toBe(false);
  });

  it('wrong amount does NOT verify', () => {
    const leaves = [
      hashLeaf(0n, pubkey(1), 100n),
      hashLeaf(1n, pubkey(2), 200n),
    ];
    const { root, proofs } = buildMerkleTree(leaves);
    const fakeLeaf = hashLeaf(0n, pubkey(1), 999n); // different amount
    expect(verifyProof(fakeLeaf, proofs[0], root)).toBe(false);
  });

  it('proof from JSON roundtrip (number[][] → Buffer[]) still verifies', () => {
    const leaves = [
      hashLeaf(0n, pubkey(1), 100n),
      hashLeaf(1n, pubkey(2), 200n),
      hashLeaf(2n, pubkey(3), 300n),
    ];
    const { root, proofs } = buildMerkleTree(leaves);

    // Simulate JSON serialization (how epoch-computer stores proofs)
    for (let i = 0; i < leaves.length; i++) {
      const jsonProof = proofs[i].map(p => Array.from(p));
      const json = JSON.stringify(jsonProof);
      const parsed = JSON.parse(json) as number[][];

      // Reconstruct buffers (how claimForUser deserializes)
      const restored = parsed.map((p: number[]) => Buffer.from(p));
      expect(verifyProof(leaves[i], restored, root)).toBe(true);
    }
  });
});

describe('computeShares', () => {
  it('returns empty when no harvests', () => {
    const ws = mockWalletService({ harvests: [] });
    const state: EpochState = { lastEpoch: 0, cumulativeEntitlements: {}, lastProcessedHarvestIndex: 0, lastEpochTimestamp: 0 };
    const shares = computeShares(ws, 1000000n, state);
    expect(shares).toEqual([]);
  });

  it('returns empty when all fee_taken = 0', () => {
    const vaultPda = pubkey(10).toBase58();
    const ws = mockWalletService({
      harvests: [{ fee_taken: '0', vault_pda: vaultPda }],
      users: { user1: { vault_pda: vaultPda } },
      vaultIndex: { [vaultPda]: 'user1' },
    });
    const state: EpochState = { lastEpoch: 0, cumulativeEntitlements: {}, lastProcessedHarvestIndex: 0, lastEpochTimestamp: 0 };
    const shares = computeShares(ws, 1000000n, state);
    expect(shares).toEqual([]);
  });

  it('single user gets 100%', () => {
    const vaultPda = pubkey(10).toBase58();
    const ws = mockWalletService({
      harvests: [{ fee_taken: '5000', vault_pda: vaultPda }],
      users: { user1: { vault_pda: vaultPda } },
      vaultIndex: { [vaultPda]: 'user1' },
    });
    const state: EpochState = { lastEpoch: 0, cumulativeEntitlements: {}, lastProcessedHarvestIndex: 0, lastEpochTimestamp: 0 };
    const shares = computeShares(ws, 1000000n, state);
    expect(shares.length).toBe(1);
    expect(shares[0].share).toBe(1000000n);
    expect(shares[0].wallet).toBe(vaultPda);
  });

  it('distributes proportionally to fees', () => {
    const vault1 = pubkey(10).toBase58();
    const vault2 = pubkey(11).toBase58();
    const ws = mockWalletService({
      harvests: [
        { fee_taken: '3000', vault_pda: vault1 },
        { fee_taken: '7000', vault_pda: vault2 },
      ],
      users: {
        user1: { vault_pda: vault1 },
        user2: { vault_pda: vault2 },
      },
      vaultIndex: {
        [vault1]: 'user1',
        [vault2]: 'user2',
      },
    });
    const state: EpochState = { lastEpoch: 0, cumulativeEntitlements: {}, lastProcessedHarvestIndex: 0, lastEpochTimestamp: 0 };
    const shares = computeShares(ws, 10_000_000n, state);
    expect(shares.length).toBe(2);

    // vault1 has 30% fees, vault2 has 70%
    const s1 = shares.find(s => s.wallet === vault1)!;
    const s2 = shares.find(s => s.wallet === vault2)!;
    expect(s1.share).toBe(3_000_000n); // 30% of 10M
    // Last user gets remainder: 10M - 3M = 7M
    expect(s1.share + s2.share).toBe(10_000_000n); // no rounding loss
  });

  it('skips harvests before lastProcessedHarvestIndex', () => {
    const vault1 = pubkey(10).toBase58();
    const ws = mockWalletService({
      harvests: [
        { fee_taken: '5000', vault_pda: vault1 }, // index 0 — already processed
        { fee_taken: '3000', vault_pda: vault1 }, // index 1 — new
      ],
      users: { user1: { vault_pda: vault1 } },
      vaultIndex: { [vault1]: 'user1' },
    });
    const state: EpochState = { lastEpoch: 0, cumulativeEntitlements: {}, lastProcessedHarvestIndex: 1, lastEpochTimestamp: 0 };
    const shares = computeShares(ws, 1000000n, state);
    expect(shares.length).toBe(1);
    expect(shares[0].feesGenerated).toBe(3000n); // only the new harvest
  });

  it('handles missing userId gracefully (skips)', () => {
    const vault1 = pubkey(10).toBase58();
    const unknownVault = pubkey(99).toBase58();
    const ws = mockWalletService({
      harvests: [
        { fee_taken: '5000', vault_pda: vault1 },
        { fee_taken: '3000', vault_pda: unknownVault }, // no mapping
      ],
      users: { user1: { vault_pda: vault1 } },
      vaultIndex: { [vault1]: 'user1' },
    });
    const state: EpochState = { lastEpoch: 0, cumulativeEntitlements: {}, lastProcessedHarvestIndex: 0, lastEpochTimestamp: 0 };
    const shares = computeShares(ws, 1000000n, state);
    expect(shares.length).toBe(1);
    expect(shares[0].wallet).toBe(vault1);
    expect(shares[0].share).toBe(1000000n); // gets 100% since unknown vault skipped
  });

  it('aggregates multiple harvests for same user', () => {
    const vault1 = pubkey(10).toBase58();
    const ws = mockWalletService({
      harvests: [
        { fee_taken: '2000', vault_pda: vault1 },
        { fee_taken: '3000', vault_pda: vault1 },
      ],
      users: { user1: { vault_pda: vault1 } },
      vaultIndex: { [vault1]: 'user1' },
    });
    const state: EpochState = { lastEpoch: 0, cumulativeEntitlements: {}, lastProcessedHarvestIndex: 0, lastEpochTimestamp: 0 };
    const shares = computeShares(ws, 1000000n, state);
    expect(shares.length).toBe(1);
    expect(shares[0].feesGenerated).toBe(5000n);
  });

  // ═══ GAUGE-WEIGHTED DISTRIBUTION ═══

  it('gauge weights: scales each user fee by weight_bps/10000', () => {
    const vault1 = pubkey(10).toBase58();
    const poolA = pubkey(100).toBase58(); // weight 6000 bps = 60%
    const poolB = pubkey(200).toBase58(); // weight 4000 bps = 40%
    const ws = mockWalletService({
      harvests: [
        { fee_taken: '1000', vault_pda: vault1, lb_pair: poolA },
        { fee_taken: '1000', vault_pda: vault1, lb_pair: poolB },
      ],
      users: { user1: { vault_pda: vault1 } },
      vaultIndex: { [vault1]: 'user1' },
    });
    const state: EpochState = { lastEpoch: 0, cumulativeEntitlements: {}, lastProcessedHarvestIndex: 0, lastEpochTimestamp: 0 };
    const gauges = { [poolA]: 6000n, [poolB]: 4000n };
    const shares = computeShares(ws, 10000n, state, gauges);
    expect(shares.length).toBe(1);
    // 1000 × 0.6 + 1000 × 0.4 = 600 + 400 = 1000 weighted fee
    expect(shares[0].feesGenerated).toBe(1000n);
    expect(shares[0].share).toBe(10000n); // sole user gets everything
  });

  it('gauge weights: zero-weight pool excluded from distribution', () => {
    const vault1 = pubkey(10).toBase58();
    const vault2 = pubkey(11).toBase58();
    const poolA = pubkey(100).toBase58(); // 10000 bps
    const poolB = pubkey(200).toBase58(); // 0 bps (not voted for)
    const ws = mockWalletService({
      harvests: [
        { fee_taken: '1000', vault_pda: vault1, lb_pair: poolA }, // gauged
        { fee_taken: '1000', vault_pda: vault2, lb_pair: poolB }, // ungaugeed
      ],
      users: { user1: { vault_pda: vault1 }, user2: { vault_pda: vault2 } },
      vaultIndex: { [vault1]: 'user1', [vault2]: 'user2' },
    });
    const state: EpochState = { lastEpoch: 0, cumulativeEntitlements: {}, lastProcessedHarvestIndex: 0, lastEpochTimestamp: 0 };
    const gauges = { [poolA]: 10000n, [poolB]: 0n };
    const shares = computeShares(ws, 10000n, state, gauges);
    expect(shares.length).toBe(1);
    expect(shares[0].wallet).toBe(vault1);
    expect(shares[0].share).toBe(10000n);
  });

  it('gauge weights: harvest on pool not in map excluded', () => {
    const vault1 = pubkey(10).toBase58();
    const poolA = pubkey(100).toBase58();
    const poolUnregistered = pubkey(999).toBase58();
    const ws = mockWalletService({
      harvests: [
        { fee_taken: '1000', vault_pda: vault1, lb_pair: poolA },
        { fee_taken: '5000', vault_pda: vault1, lb_pair: poolUnregistered },
      ],
      users: { user1: { vault_pda: vault1 } },
      vaultIndex: { [vault1]: 'user1' },
    });
    const state: EpochState = { lastEpoch: 0, cumulativeEntitlements: {}, lastProcessedHarvestIndex: 0, lastEpochTimestamp: 0 };
    const gauges = { [poolA]: 10000n }; // poolUnregistered not in map
    const shares = computeShares(ws, 10000n, state, gauges);
    expect(shares.length).toBe(1);
    // Only poolA harvest counts: 1000 × 1.0 = 1000
    expect(shares[0].feesGenerated).toBe(1000n);
  });

  it('gauge weights: splits proportional across users by weighted fee', () => {
    const vault1 = pubkey(10).toBase58();
    const vault2 = pubkey(11).toBase58();
    const poolA = pubkey(100).toBase58(); // 8000 bps
    const poolB = pubkey(200).toBase58(); // 2000 bps
    const ws = mockWalletService({
      harvests: [
        { fee_taken: '1000', vault_pda: vault1, lb_pair: poolA }, // 800 weighted
        { fee_taken: '1000', vault_pda: vault2, lb_pair: poolB }, // 200 weighted
      ],
      users: { user1: { vault_pda: vault1 }, user2: { vault_pda: vault2 } },
      vaultIndex: { [vault1]: 'user1', [vault2]: 'user2' },
    });
    const state: EpochState = { lastEpoch: 0, cumulativeEntitlements: {}, lastProcessedHarvestIndex: 0, lastEpochTimestamp: 0 };
    const gauges = { [poolA]: 8000n, [poolB]: 2000n };
    const shares = computeShares(ws, 10000n, state, gauges);
    expect(shares.length).toBe(2);
    const byWallet = Object.fromEntries(shares.map(s => [s.wallet, s]));
    expect(byWallet[vault1].feesGenerated).toBe(800n);
    expect(byWallet[vault2].feesGenerated).toBe(200n);
    // vault1: 800/1000 × 10000 = 8000; vault2: remainder 2000
    expect(byWallet[vault1].share + byWallet[vault2].share).toBe(10000n);
    expect(byWallet[vault1].share).toBe(8000n);
  });

  it('gauge weights: all-zero weights → empty shares (no distribution)', () => {
    const vault1 = pubkey(10).toBase58();
    const poolA = pubkey(100).toBase58();
    const ws = mockWalletService({
      harvests: [{ fee_taken: '1000', vault_pda: vault1, lb_pair: poolA }],
      users: { user1: { vault_pda: vault1 } },
      vaultIndex: { [vault1]: 'user1' },
    });
    const state: EpochState = { lastEpoch: 0, cumulativeEntitlements: {}, lastProcessedHarvestIndex: 0, lastEpochTimestamp: 0 };
    const gauges = { [poolA]: 0n };
    const shares = computeShares(ws, 10000n, state, gauges);
    expect(shares.length).toBe(0);
  });

  it('empty gauge map → falls back to flat (backward compat)', () => {
    const vault1 = pubkey(10).toBase58();
    const ws = mockWalletService({
      harvests: [{ fee_taken: '1000', vault_pda: vault1, lb_pair: pubkey(100).toBase58() }],
      users: { user1: { vault_pda: vault1 } },
      vaultIndex: { [vault1]: 'user1' },
    });
    const state: EpochState = { lastEpoch: 0, cumulativeEntitlements: {}, lastProcessedHarvestIndex: 0, lastEpochTimestamp: 0 };
    const shares = computeShares(ws, 10000n, state, {}); // empty map → flat
    expect(shares.length).toBe(1);
    expect(shares[0].feesGenerated).toBe(1000n);
  });
});

// ═══ RECONCILE ENTITLEMENTS (v2-H-04) ═══

/**
 * Build a minimal claim_status account buffer: 8-byte discriminator + u64 LE
 * cumulative_claimed at offset 8. That's all the reconciler reads.
 */
function claimStatusBuffer(cumulativeClaimed: bigint): { data: Buffer } {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(cumulativeClaimed, 8);
  return { data: buf };
}

/** Minimal Connection stub — only implements getMultipleAccountsInfo. */
function mockConnection(responses: (ReturnType<typeof claimStatusBuffer> | null)[]): any {
  let callCount = 0;
  return {
    getMultipleAccountsInfo: async (pdas: PublicKey[]) => {
      // Return up to pdas.length slices of responses, starting from callCount cursor.
      const start = callCount;
      callCount += pdas.length;
      return responses.slice(start, start + pdas.length);
    },
  };
}

describe('reconcileEntitlementsAgainstOnChain', () => {
  const distPDA = pubkey(9999);
  const distProgId = pubkey(8888);

  it('no drift: returns input unchanged when on-chain <= local for every wallet', async () => {
    const w1 = pubkey(1).toBase58();
    const w2 = pubkey(2).toBase58();
    const entitlements = { [w1]: '1000', [w2]: '2000' };
    const conn = mockConnection([
      claimStatusBuffer(1000n),  // w1: onChain = local
      claimStatusBuffer(1500n),  // w2: onChain < local
    ]);
    const result = await reconcileEntitlementsAgainstOnChain(
      conn, distPDA, distProgId, entitlements, 'SOL',
    );
    expect(result).toEqual(entitlements);
  });

  it('drift: bumps local up to on-chain claimed when on-chain > local', async () => {
    const w1 = pubkey(1).toBase58();
    const w2 = pubkey(2).toBase58();
    const entitlements = { [w1]: '500', [w2]: '2000' };
    const conn = mockConnection([
      claimStatusBuffer(1000n),  // w1: onChain > local → bump to 1000
      claimStatusBuffer(1500n),  // w2: onChain < local → no bump
    ]);
    const result = await reconcileEntitlementsAgainstOnChain(
      conn, distPDA, distProgId, entitlements, 'SOL',
    );
    expect(result[w1]).toBe('1000');
    expect(result[w2]).toBe('2000');
  });

  it('no claim_status account: treats as 0 claimed, no bump', async () => {
    const w1 = pubkey(1).toBase58();
    const entitlements = { [w1]: '500' };
    const conn = mockConnection([null]); // getMultipleAccountsInfo returns null for uninit accounts
    const result = await reconcileEntitlementsAgainstOnChain(
      conn, distPDA, distProgId, entitlements, 'SOL',
    );
    expect(result[w1]).toBe('500');
  });

  it('empty entitlements: short-circuits without RPC call', async () => {
    let called = false;
    const conn = {
      getMultipleAccountsInfo: async () => { called = true; return []; },
    };
    const result = await reconcileEntitlementsAgainstOnChain(
      conn, distPDA, distProgId, {}, 'SOL',
    );
    expect(result).toEqual({});
    expect(called).toBe(false);
  });

  it('batches >100 wallets across multiple RPC calls', async () => {
    // Build 150 wallets, all with onChain = local + 10 (so all get bumped).
    const entitlements: Record<string, string> = {};
    const responses: ReturnType<typeof claimStatusBuffer>[] = [];
    for (let i = 0; i < 150; i++) {
      const w = pubkey(i + 1).toBase58();
      entitlements[w] = '100';
      responses.push(claimStatusBuffer(110n));
    }
    let batchCount = 0;
    let totalAddresses = 0;
    const conn = {
      getMultipleAccountsInfo: async (pdas: PublicKey[]) => {
        batchCount += 1;
        const slice = responses.slice(totalAddresses, totalAddresses + pdas.length);
        totalAddresses += pdas.length;
        return slice;
      },
    };
    const result = await reconcileEntitlementsAgainstOnChain(
      conn, distPDA, distProgId, entitlements, 'BANK',
    );
    expect(batchCount).toBe(2); // 150 / 100 = ceil 2
    expect(Object.keys(result).length).toBe(150);
    for (const w of Object.keys(result)) {
      expect(result[w]).toBe('110');
    }
  });

  it('truncated claim_status data: treats as 0, no bump', async () => {
    const w1 = pubkey(1).toBase58();
    const entitlements = { [w1]: '500' };
    // Return an account with only 10 bytes (< 16 required) — reconciler must skip.
    const conn = mockConnection([{ data: Buffer.alloc(10) }]);
    const result = await reconcileEntitlementsAgainstOnChain(
      conn, distPDA, distProgId, entitlements, 'SOL',
    );
    expect(result[w1]).toBe('500');
  });
});
