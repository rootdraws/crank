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
});
