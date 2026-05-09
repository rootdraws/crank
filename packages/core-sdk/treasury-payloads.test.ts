/**
 * treasury-payloads.test.ts
 *
 * Unit tests for the hand-rolled bin-farm ix builders (record_settle_meta,
 * settle_proposer, close_settle). Verifies discriminators + account layouts
 * match the Rust struct definitions in programs/bin-farm/src/lib.rs.
 *
 * Run: npx vitest run packages/core-sdk/treasury-payloads.test.ts
 */

import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { createHash } from 'crypto';

import {
  buildRecordSettleMetaIx,
  buildSettleProposerIx,
  buildCloseSettleIx,
  composeOpenPayload,
  composeClosePayload,
  __test,
} from './treasury-payloads';
import {
  BIN_FARM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from './constants';
import {
  getConfigPDA,
  getPositionPDA,
  getPositionSettlePDA,
  getUserVaultPDA,
  getVaultPDA,
} from './pda';

function det(tag: number): PublicKey {
  const b = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) b[i] = (tag + i) & 0xff;
  return new PublicKey(b);
}

describe('discriminators match Anchor sha256("global:<name>")[0..8]', () => {
  it('record_settle_meta', () => {
    const expected = createHash('sha256').update('global:record_settle_meta').digest().subarray(0, 8);
    expect(__test.RECORD_SETTLE_META_DISC.equals(expected)).toBe(true);
  });
  it('settle_proposer', () => {
    const expected = createHash('sha256').update('global:settle_proposer').digest().subarray(0, 8);
    expect(__test.SETTLE_PROPOSER_DISC.equals(expected)).toBe(true);
  });
  it('close_settle', () => {
    const expected = createHash('sha256').update('global:close_settle').digest().subarray(0, 8);
    expect(__test.CLOSE_SETTLE_DISC.equals(expected)).toBe(true);
  });
});

describe('buildRecordSettleMetaIx', () => {
  const caller = det(0x10);
  const treasuryVaultOwner = det(0x20);
  const meteoraPosition = det(0x30);
  const tokenXMint = det(0x40);
  const tokenYMint = det(0x50);
  const proposer = det(0x60);

  const ix = buildRecordSettleMetaIx({
    caller, treasuryVaultOwner, meteoraPosition, tokenXMint, tokenYMint, proposer,
  });

  it('targets bin-farm program', () => {
    expect(ix.programId.equals(BIN_FARM_PROGRAM_ID)).toBe(true);
  });

  it('encodes proposer pubkey after discriminator', () => {
    expect(ix.data.length).toBe(8 + 32);
    expect(ix.data.subarray(0, 8).equals(__test.RECORD_SETTLE_META_DISC)).toBe(true);
    expect(ix.data.subarray(8).equals(proposer.toBuffer())).toBe(true);
  });

  it('account layout matches RecordSettleMeta context (9 accounts, ordered)', () => {
    const [config] = getConfigPDA();
    const [position] = getPositionPDA(meteoraPosition);
    const [userVault] = getUserVaultPDA(treasuryVaultOwner);
    const [positionSettle] = getPositionSettlePDA(meteoraPosition);

    expect(ix.keys).toHaveLength(9);
    expect(ix.keys[0].pubkey.equals(caller)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(config)).toBe(true);
    expect(ix.keys[2].pubkey.equals(meteoraPosition)).toBe(true);
    expect(ix.keys[3].pubkey.equals(position)).toBe(true);
    expect(ix.keys[4].pubkey.equals(userVault)).toBe(true);
    expect(ix.keys[5].pubkey.equals(positionSettle)).toBe(true);
    expect(ix.keys[5].isWritable).toBe(true);
    expect(ix.keys[6].pubkey.equals(tokenXMint)).toBe(true);
    expect(ix.keys[7].pubkey.equals(tokenYMint)).toBe(true);
    expect(ix.keys[8].pubkey.equals(SystemProgram.programId)).toBe(true);
  });
});

describe('buildSettleProposerIx', () => {
  const caller = det(0x10);
  const treasuryVaultOwner = det(0x20);
  const meteoraPosition = det(0x30);
  const positionVaultOutputAta = det(0x40);
  const proposerOutputAta = det(0x50);
  const outputMint = det(0x60);

  const ix = buildSettleProposerIx({
    caller, treasuryVaultOwner, meteoraPosition,
    positionVaultOutputAta, proposerOutputAta, outputMint,
  });

  it('encodes only the discriminator (no args)', () => {
    expect(ix.data.length).toBe(8);
    expect(ix.data.equals(__test.SETTLE_PROPOSER_DISC)).toBe(true);
  });

  it('account layout matches SettleProposer context (10 accounts, ordered)', () => {
    const [config] = getConfigPDA();
    const [userVault] = getUserVaultPDA(treasuryVaultOwner);
    const [positionSettle] = getPositionSettlePDA(meteoraPosition);
    const [vault] = getVaultPDA(meteoraPosition);

    expect(ix.keys).toHaveLength(10);
    expect(ix.keys[0].pubkey.equals(caller)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(config)).toBe(true);
    expect(ix.keys[2].pubkey.equals(userVault)).toBe(true);
    expect(ix.keys[3].pubkey.equals(positionSettle)).toBe(true);
    expect(ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[4].pubkey.equals(vault)).toBe(true);
    expect(ix.keys[5].pubkey.equals(meteoraPosition)).toBe(true);
    expect(ix.keys[6].pubkey.equals(positionVaultOutputAta)).toBe(true);
    expect(ix.keys[6].isWritable).toBe(true);
    expect(ix.keys[7].pubkey.equals(proposerOutputAta)).toBe(true);
    expect(ix.keys[7].isWritable).toBe(true);
    expect(ix.keys[8].pubkey.equals(outputMint)).toBe(true);
    expect(ix.keys[9].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });
});

describe('buildCloseSettleIx', () => {
  const caller = det(0x10);
  const treasuryVaultOwner = det(0x20);
  const meteoraPosition = det(0x30);

  const ix = buildCloseSettleIx({ caller, treasuryVaultOwner, meteoraPosition });

  it('encodes only the discriminator', () => {
    expect(ix.data.length).toBe(8);
    expect(ix.data.equals(__test.CLOSE_SETTLE_DISC)).toBe(true);
  });

  it('account layout matches CloseSettle context (5 accounts)', () => {
    const [config] = getConfigPDA();
    const [userVault] = getUserVaultPDA(treasuryVaultOwner);
    const [positionSettle] = getPositionSettlePDA(meteoraPosition);

    expect(ix.keys).toHaveLength(5);
    expect(ix.keys[0].pubkey.equals(caller)).toBe(true);
    expect(ix.keys[1].pubkey.equals(config)).toBe(true);
    expect(ix.keys[2].pubkey.equals(userVault)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(true);
    expect(ix.keys[3].pubkey.equals(positionSettle)).toBe(true);
    expect(ix.keys[3].isWritable).toBe(true);
    expect(ix.keys[4].pubkey.equals(meteoraPosition)).toBe(true);
  });
});

describe('composers', () => {
  const treasuryVaultOwner = det(0x20);
  const meteoraPosition = det(0x30);
  const proposer = det(0x60);
  const fakeTreasuryOpenIx = {
    programId: BIN_FARM_PROGRAM_ID,
    keys: [],
    data: Buffer.alloc(0),
  };
  const fakeTreasuryCloseIx = { ...fakeTreasuryOpenIx };
  const fakeUserCloseIx = { ...fakeTreasuryOpenIx };

  it('composeOpenPayload appends record_settle_meta after caller-supplied open ix', () => {
    const ixs = composeOpenPayload(fakeTreasuryOpenIx as never, {
      caller: det(0x10), treasuryVaultOwner, meteoraPosition,
      tokenXMint: det(0x40), tokenYMint: det(0x50), proposer,
    });
    expect(ixs).toHaveLength(2);
    expect(ixs[0]).toBe(fakeTreasuryOpenIx);
    expect(ixs[1].data.subarray(0, 8).equals(__test.RECORD_SETTLE_META_DISC)).toBe(true);
  });

  it('composeClosePayload orders settle → treasury_close → close_settle → user_close', () => {
    const settleArgs = {
      caller: det(0x10), treasuryVaultOwner, meteoraPosition,
      positionVaultOutputAta: det(0x40), proposerOutputAta: det(0x50), outputMint: det(0x60),
    };
    const closeSettleArgs = { caller: det(0x10), treasuryVaultOwner, meteoraPosition };
    const ixs = composeClosePayload(
      settleArgs,
      fakeTreasuryCloseIx as never,
      closeSettleArgs,
      fakeUserCloseIx as never,
    );
    expect(ixs).toHaveLength(4);
    expect(ixs[0].data.subarray(0, 8).equals(__test.SETTLE_PROPOSER_DISC)).toBe(true);
    expect(ixs[1]).toBe(fakeTreasuryCloseIx);
    expect(ixs[2].data.subarray(0, 8).equals(__test.CLOSE_SETTLE_DISC)).toBe(true);
    expect(ixs[3]).toBe(fakeUserCloseIx);
  });
});
