/**
 * bot/treasury-rescue.ts
 *
 * Permissionless close of abandoned Path B treasury-matched positions.
 *
 * "Abandoned" = the user closed their Path A position but the linked treasury-side
 * position never settled (treasury_close_combined didn't fire — bot crash, addin
 * error, etc.). The proposer's 25% payout sits unsettled.
 *
 * The on-chain `close_position` ix accepts optional settle accounts (added in this
 * change). When passed, it runs settle inline before draining the vault — no
 * governance proposal needed. Keys are bound to the recorded proposer + Config.tax_reserve
 * so a permissionless cranker (the bot, here) can't redirect funds.
 *
 * Wiring: keeper.ts calls `sweepAbandonedTreasuryPositions(deps)` daily. Gated by
 * env `TREASURY_AUTO_SWEEP_ABANDONED=1`. When unset, logs candidates only.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import {
  getConfigPDA,
  getPositionPDA,
  getVaultPDA,
  getPositionSettlePDA,
  resolveMeteoraCPIAccounts,
  deriveATA,
  buildSetupTx,
  signAndSendLegacy,
  confirmAndCheck,
  SPL_MEMO_PROGRAM_ID,
  METEORA_DLMM_PROGRAM_ID,
  type TreasuryPositionRecord,
} from '@crankbot/core-sdk';
import type { Program } from '@coral-xyz/anchor';
import { logger } from './logger';

const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
const NULL_PUBKEY = SYSTEM_PROGRAM;

export interface RescueDeps {
  connection: Connection;
  coreProgram: Program;
  botKeypair: Keypair;
  configPDA: PublicKey;
  feeDest: PublicKey;
  walletService: {
    listOpenTreasuryPositions(): TreasuryPositionRecord[];
    closeTreasuryPosition(
      treasuryPositionPda: string,
      closeProposalPda: string,
      proposerPayoutAmount: bigint,
    ): void;
  };
}

interface AbandonedCandidate {
  match: TreasuryPositionRecord;
  reason: 'user_closed_no_settle' | 'stale_open';
}

/**
 * Treasury matches are abandoned when:
 *  1. status='open' in DB
 *  2. The on-chain user Position account is gone (user closed Path A)
 *  3. The on-chain treasury Position account still exists (treasury never closed)
 *
 * Older entries with no user Position match #2; if both are present the close is
 * still in flight (don't sweep). If both are gone but DB says 'open', the treasury
 * also closed already and the DB is stale (caller should reconcile).
 */
export async function findAbandonedTreasuryPositions(
  deps: RescueDeps,
): Promise<AbandonedCandidate[]> {
  const open = deps.walletService.listOpenTreasuryPositions();
  if (open.length === 0) return [];

  const candidates: AbandonedCandidate[] = [];
  for (const m of open) {
    try {
      const userPositionPda = new PublicKey(m.user_position_pda);
      const treasuryPositionPda = new PublicKey(m.treasury_position_pda);
      const [userInfo, tInfo] = await Promise.all([
        deps.connection.getAccountInfo(userPositionPda),
        deps.connection.getAccountInfo(treasuryPositionPda),
      ]);
      if (!userInfo && tInfo) {
        candidates.push({ match: m, reason: 'user_closed_no_settle' });
      }
    } catch (e) {
      logger.warn(`[rescue] candidate check failed for ${m.treasury_position_pda.slice(0, 8)}…: ${(e as Error).message}`);
    }
  }
  return candidates;
}

/**
 * Build + send the close_position tx for one abandoned match. Settle accounts
 * are populated when on-chain PositionSettle exists, so the proposer + tax cuts
 * pay out atomically. Bot signs as cranker (close_position bot path; no
 * priority_slots gate when caller == Config.bot).
 */
export async function closeAbandonedTreasuryPosition(
  deps: RescueDeps,
  match: TreasuryPositionRecord,
): Promise<string> {
  const bot = deps.botKeypair;
  const meteoraPosition = new PublicKey(match.meteora_position);
  const lbPair = new PublicKey(match.lb_pair);
  const treasuryUserVault = new PublicKey(match.treasury_vault);
  const proposerWallet = new PublicKey(match.proposer_wallet);
  const outputMint = new PublicKey(match.output_mint);

  const cpi = await resolveMeteoraCPIAccounts(
    deps.connection, lbPair, match.min_bin_id, match.max_bin_id,
  );

  const [positionPDA] = getPositionPDA(meteoraPosition);
  const [posVaultPDA] = getVaultPDA(meteoraPosition);
  const [positionSettlePDA] = getPositionSettlePDA(meteoraPosition);

  const vaultTokenX = deriveATA(cpi.tokenXMint, posVaultPDA, cpi.tokenXProgramId, true);
  const vaultTokenY = deriveATA(cpi.tokenYMint, posVaultPDA, cpi.tokenYProgramId, true);
  // owner_token_x/y on close_position: must be owned by position.user_vault = treasury_user_vault
  const ownerTokenX = deriveATA(cpi.tokenXMint, treasuryUserVault, cpi.tokenXProgramId, true);
  const ownerTokenY = deriveATA(cpi.tokenYMint, treasuryUserVault, cpi.tokenYProgramId, true);
  const feeDest = deps.feeDest;
  const feeDestTokenX = deriveATA(cpi.tokenXMint, feeDest, cpi.tokenXProgramId, true);
  const feeDestTokenY = deriveATA(cpi.tokenYMint, feeDest, cpi.tokenYProgramId, true);

  const outputTokenProgram = outputMint.equals(cpi.tokenXMint)
    ? cpi.tokenXProgramId
    : cpi.tokenYProgramId;
  const proposerOutputAta = getAssociatedTokenAddressSync(
    outputMint, proposerWallet, false, outputTokenProgram,
  );

  // Resolve tax_reserve and its ATA from on-chain Config (live, not cached).
  // Same offset used in close.ts for treasury close — Config v2 layout.
  let taxReserveOutputAta: PublicKey | null = null;
  try {
    const configInfo = await deps.connection.getAccountInfo(deps.configPDA);
    if (configInfo) {
      const TAX_RESERVE_OFFSET = 295;
      if (configInfo.data.length >= TAX_RESERVE_OFFSET + 32) {
        const taxReserveBytes = configInfo.data.subarray(TAX_RESERVE_OFFSET, TAX_RESERVE_OFFSET + 32);
        const taxReserve = new PublicKey(taxReserveBytes);
        if (!taxReserve.equals(NULL_PUBKEY)) {
          taxReserveOutputAta = getAssociatedTokenAddressSync(
            outputMint, taxReserve, true, outputTokenProgram,
          );
        }
      }
    }
  } catch (e) {
    logger.warn(`[rescue] tax_reserve resolve failed: ${(e as Error).message}`);
  }

  // Pre-create proposer + tax_reserve + fee_dest ATAs idempotently. Bot pays rent.
  const setupOps: Array<{ ata: PublicKey; owner: PublicKey; mint: PublicKey; tokenProgram: PublicKey }> = [
    { ata: ownerTokenX, owner: treasuryUserVault, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
    { ata: ownerTokenY, owner: treasuryUserVault, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
    { ata: feeDestTokenX, owner: feeDest, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
    { ata: feeDestTokenY, owner: feeDest, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
    { ata: proposerOutputAta, owner: proposerWallet, mint: outputMint, tokenProgram: outputTokenProgram },
  ];
  if (taxReserveOutputAta) {
    // tax_reserve is a PDA on Realms side; pass `allowOwnerOffCurve=true` not needed here
    // since we're just creating its ATA via SPL ATA program (owner is whatever).
  }
  const setupTx = await buildSetupTx(deps.connection, bot.publicKey, setupOps);
  if (setupTx) {
    await signAndSendLegacy(setupTx, bot, deps.connection);
  }

  // Tax-reserve ATA needs separate handling because its owner is a PDA
  // (Config.tax_reserve, not derived from a user wallet). buildSetupTx assumes
  // wallet-owned ATAs. Use createAssociatedTokenAccountIdempotentInstruction.
  if (taxReserveOutputAta) {
    const taxAtaInfo = await deps.connection.getAccountInfo(taxReserveOutputAta);
    if (!taxAtaInfo) {
      // Read tax_reserve owner pubkey
      const configInfo = await deps.connection.getAccountInfo(deps.configPDA);
      if (configInfo) {
        const TAX_RESERVE_OFFSET = 295;
        const taxReserve = new PublicKey(configInfo.data.subarray(TAX_RESERVE_OFFSET, TAX_RESERVE_OFFSET + 32));
        const ix = createAssociatedTokenAccountIdempotentInstruction(
          bot.publicKey, taxReserveOutputAta, taxReserve, outputMint, outputTokenProgram,
        );
        const tx = new Transaction().add(ix);
        tx.feePayer = bot.publicKey;
        tx.recentBlockhash = (await deps.connection.getLatestBlockhash()).blockhash;
        tx.sign(bot);
        await deps.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      }
    }
  }

  // Build the close_position ix with optional settle accounts populated.
  const accounts: Record<string, PublicKey> = {
    bot: bot.publicKey,
    config: deps.configPDA,
    userVault: treasuryUserVault,
    position: positionPDA,
    vault: posVaultPDA,
    meteoraPosition,
    lbPair: cpi.lbPair,
    binArrayBitmapExt: cpi.binArrayBitmapExt,
    binArrayLower: cpi.binArrayLower,
    binArrayUpper: cpi.binArrayUpper,
    reserveX: cpi.reserveX,
    reserveY: cpi.reserveY,
    tokenXMint: cpi.tokenXMint,
    tokenYMint: cpi.tokenYMint,
    eventAuthority: cpi.eventAuthority,
    dlmmProgram: cpi.dlmmProgram,
    vaultTokenX,
    vaultTokenY,
    ownerTokenX,
    ownerTokenY,
    feeDest,
    feeDestTokenX,
    feeDestTokenY,
    tokenXProgram: cpi.tokenXProgramId,
    tokenYProgram: cpi.tokenYProgramId,
    memoProgram: SPL_MEMO_PROGRAM_ID,
    positionSettle: positionSettlePDA,
    proposerOutputAta,
    systemProgram: SYSTEM_PROGRAM,
  };
  if (taxReserveOutputAta) {
    accounts.taxReserveOutputAta = taxReserveOutputAta;
  }

  const closeIx = await deps.coreProgram.methods
    .closePosition()
    .accounts(accounts)
    .instruction();

  // Bitmap ext must be writable for Meteora CPI
  if (!cpi.binArrayBitmapExt.equals(METEORA_DLMM_PROGRAM_ID)) {
    for (const k of closeIx.keys) {
      if (k.pubkey.equals(cpi.binArrayBitmapExt)) k.isWritable = true;
    }
  }

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    closeIx,
  );
  tx.feePayer = bot.publicKey;
  const bh = await deps.connection.getLatestBlockhash();
  tx.recentBlockhash = bh.blockhash;
  tx.sign(bot);
  const sig = await deps.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await confirmAndCheck(deps.connection, sig, bh.blockhash, bh.lastValidBlockHeight);

  // Reconcile DB: mark closed. Real payout amount needs tx-log parsing — skip
  // for now and write 0n (cosmetic; real payout already on-chain via settle).
  deps.walletService.closeTreasuryPosition(match.treasury_position_pda, sig, 0n);

  return sig;
}

/**
 * Daily sweep entry point. Set TREASURY_AUTO_SWEEP_ABANDONED=1 to actually fire
 * closes; otherwise logs candidates only (safe-default).
 */
export async function sweepAbandonedTreasuryPositions(deps: RescueDeps): Promise<void> {
  const candidates = await findAbandonedTreasuryPositions(deps);
  if (candidates.length === 0) {
    logger.info('  [rescue] no abandoned treasury positions');
    return;
  }

  const live = process.env.TREASURY_AUTO_SWEEP_ABANDONED === '1';
  logger.info(
    `  [rescue] ${candidates.length} abandoned candidate(s) (mode=${live ? 'live' : 'log-only'})`,
  );
  for (const c of candidates) {
    const tag = c.match.treasury_position_pda.slice(0, 8);
    logger.info(`    [rescue] ${tag}… reason=${c.reason} proposer=${c.match.proposer_wallet.slice(0, 8)}…`);
    if (!live) continue;
    try {
      const sig = await closeAbandonedTreasuryPosition(deps, c.match);
      logger.info(`    [rescue] ✓ closed ${tag}… sig=${sig.slice(0, 12)}…`);
    } catch (e) {
      logger.warn(`    [rescue] ✗ failed ${tag}…: ${(e as Error).message?.slice(0, 200)}`);
    }
  }
}
