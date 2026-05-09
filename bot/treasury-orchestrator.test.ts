/**
 * treasury-orchestrator.test.ts
 *
 * Tests pure-function surfaces of the orchestrator (no RPC):
 *   - payload hashing (determinism + sensitivity to ix mutations)
 *   - enqueue replay detection via WalletService.findProposalByPayloadHash
 *
 * Run: npx vitest run bot/treasury-orchestrator.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  Connection,
} from '@solana/web3.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { WalletService, SPL_MEMO_PROGRAM_ID } from '@crankbot/core-sdk';
import {
  TreasuryOrchestrator,
  __test,
  type OpenJob,
} from './treasury-orchestrator';

const { hashPayload } = __test;

function memoIx(text: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: SPL_MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(text, 'utf8'),
  });
}

function fakeOpenJob(text: string): OpenJob {
  return {
    kind: 'open',
    innerIxs: [memoIx(text)],
    userPositionPda: 'user-pos',
    proposerUserId: 'discord:1',
    proposerWallet: 'wallet-pubkey',
    meteoraPosition: 'mp',
    treasuryVault: 'tv',
    lbPair: 'lb',
    side: 'Sell',
    minBinId: 1,
    maxBinId: 10,
    matchedAmount: 1_000n,
    outputMint: 'mint',
    payoutBps: 2000,
    proposalName: text,
  };
}

function tmpService(): { service: WalletService; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'orch-'));
  const service = new WalletService(join(dir, 'store.json'));
  return {
    service,
    cleanup: () => {
      service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('hashPayload', () => {
  it('produces a stable hex digest', () => {
    const ix = memoIx('hello');
    const a = hashPayload([ix]);
    const b = hashPayload([ix]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when ix data changes', () => {
    expect(hashPayload([memoIx('a')])).not.toBe(hashPayload([memoIx('b')]));
  });

  it('changes when ix order changes', () => {
    const ix1 = memoIx('one');
    const ix2 = memoIx('two');
    expect(hashPayload([ix1, ix2])).not.toBe(hashPayload([ix2, ix1]));
  });

  it('changes when account meta flags change', () => {
    const pk = Keypair.generate().publicKey;
    const a = new TransactionInstruction({
      programId: SPL_MEMO_PROGRAM_ID,
      keys: [{ pubkey: pk, isSigner: false, isWritable: false }],
      data: Buffer.from('x'),
    });
    const b = new TransactionInstruction({
      programId: SPL_MEMO_PROGRAM_ID,
      keys: [{ pubkey: pk, isSigner: true, isWritable: false }],
      data: Buffer.from('x'),
    });
    expect(hashPayload([a])).not.toBe(hashPayload([b]));
  });
});

describe('TreasuryOrchestrator.enqueue', () => {
  it('enqueues a fresh job', () => {
    const { service, cleanup } = tmpService();
    try {
      const orch = new TreasuryOrchestrator({
        connection: new Connection('http://stub'),
        bot: Keypair.generate(),
        walletService: service,
        realm: PublicKey.default,
        governance: PublicKey.default,
        tokenOwnerRecord: PublicKey.default,
        councilMint: PublicKey.default,
        buildValidatorContext: () => ({
          botPubkey: PublicKey.default,
          nativeTreasuryPda: PublicKey.default,
          treasuryUserVault: PublicKey.default,
          knownPoolAddresses: new Set(),
        }),
      });
      orch.enqueue(fakeOpenJob('one'));
      expect(orch.pendingCount()).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('skips duplicate payload-hash already executed', () => {
    const { service, cleanup } = tmpService();
    try {
      const job = fakeOpenJob('one');
      const payloadHash = hashPayload(job.innerIxs);
      service.recordProposalLifecycle({
        proposal_pda: 'fake-pda',
        kind: 'open',
        status: 'executed',
        payload_hash: payloadHash,
      });
      const orch = new TreasuryOrchestrator({
        connection: new Connection('http://stub'),
        bot: Keypair.generate(),
        walletService: service,
        realm: PublicKey.default,
        governance: PublicKey.default,
        tokenOwnerRecord: PublicKey.default,
        councilMint: PublicKey.default,
        buildValidatorContext: () => ({
          botPubkey: PublicKey.default,
          nativeTreasuryPda: PublicKey.default,
          treasuryUserVault: PublicKey.default,
          knownPoolAddresses: new Set(),
        }),
      });
      orch.enqueue(job);
      expect(orch.pendingCount()).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('re-enqueues if previous attempt failed', () => {
    const { service, cleanup } = tmpService();
    try {
      const job = fakeOpenJob('one');
      const payloadHash = hashPayload(job.innerIxs);
      service.recordProposalLifecycle({
        proposal_pda: 'fake-pda',
        kind: 'open',
        status: 'failed',
        payload_hash: payloadHash,
      });
      const orch = new TreasuryOrchestrator({
        connection: new Connection('http://stub'),
        bot: Keypair.generate(),
        walletService: service,
        realm: PublicKey.default,
        governance: PublicKey.default,
        tokenOwnerRecord: PublicKey.default,
        councilMint: PublicKey.default,
        buildValidatorContext: () => ({
          botPubkey: PublicKey.default,
          nativeTreasuryPda: PublicKey.default,
          treasuryUserVault: PublicKey.default,
          knownPoolAddresses: new Set(),
        }),
      });
      orch.enqueue(job);
      expect(orch.pendingCount()).toBe(1);
    } finally {
      cleanup();
    }
  });
});

describe('TreasuryOrchestrator.reconcile', () => {
  it('marks stale (>5min, no execute_sig) proposals as failed', async () => {
    const { service, cleanup } = tmpService();
    try {
      // Inject a record with created_at in the past via raw lifecycle update
      service.recordProposalLifecycle({
        proposal_pda: 'stale-pda',
        kind: 'open',
        status: 'pending',
        payload_hash: 'a'.repeat(64),
        created_at: Date.now() - 6 * 60_000,
      });
      const orch = new TreasuryOrchestrator({
        connection: new Connection('http://stub'),
        bot: Keypair.generate(),
        walletService: service,
        realm: PublicKey.default,
        governance: PublicKey.default,
        tokenOwnerRecord: PublicKey.default,
        councilMint: PublicKey.default,
        buildValidatorContext: () => ({
          botPubkey: PublicKey.default,
          nativeTreasuryPda: PublicKey.default,
          treasuryUserVault: PublicKey.default,
          knownPoolAddresses: new Set(),
        }),
      });
      await orch.reconcile();
      expect(service.getProposal('stale-pda')?.status).toBe('failed');
    } finally {
      cleanup();
    }
  });

  it('leaves fresh pending proposals alone', async () => {
    const { service, cleanup } = tmpService();
    try {
      service.recordProposalLifecycle({
        proposal_pda: 'fresh-pda',
        kind: 'open',
        status: 'pending',
        payload_hash: 'b'.repeat(64),
        created_at: Date.now(),
      });
      const orch = new TreasuryOrchestrator({
        connection: new Connection('http://stub'),
        bot: Keypair.generate(),
        walletService: service,
        realm: PublicKey.default,
        governance: PublicKey.default,
        tokenOwnerRecord: PublicKey.default,
        councilMint: PublicKey.default,
        buildValidatorContext: () => ({
          botPubkey: PublicKey.default,
          nativeTreasuryPda: PublicKey.default,
          treasuryUserVault: PublicKey.default,
          knownPoolAddresses: new Set(),
        }),
      });
      await orch.reconcile();
      expect(service.getProposal('fresh-pda')?.status).toBe('pending');
    } finally {
      cleanup();
    }
  });
});
