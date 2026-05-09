/**
 * bot/treasury-match.ts
 *
 * Path B (treasury-matched) hook for Discord open/close commands. Builds the
 * inner-ix payload, composes it via core-sdk's treasury-payloads helpers, and
 * enqueues the job on the orchestrator.
 *
 * Integration point in buy.ts / sell.ts: after Path A's openPositionV2 confirms
 * and `walletService.savePosition()` runs, fire-and-forget call to
 * `enqueueOpenMatchIfPossible(...)` — does NOT block the user's reply.
 *
 * Integration point in close.ts: when /close detects a treasury match for the
 * user's position, call `enqueueCloseMatch(...)` instead of the user-only path.
 * Awaits completion since closes are atomic + relatively rare.
 *
 * Failure handling:
 *   - No-op silently if ctx.treasury is undefined (Path B disabled).
 *   - No-op silently if treasury inventory is insufficient for the side.
 *   - Setup-tx failures (ATA creation) → log, don't enqueue (drain attempt blocked at ix build).
 *   - Enqueue is replay-detected by orchestrator (payload-hash-keyed in DB).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { BN } from '@coral-xyz/anchor';
import {
  getPositionCounterPDA,
  getMeteoraPositionPDA,
  getPositionPDA,
  getVaultPDA,
  buildRecordSettleMetaIx,
  buildSettleProposerIx,
  buildCloseSettleIx,
  composeOpenPayload,
  composeClosePayload,
  NATIVE_MINT,
  CRANK_MINT,
} from '@crankbot/core-sdk';
import type { TreasuryRuntime } from './treasury-runtime';

// Discord-bot's BotContext (subset we actually need — keep coupling minimal).
export interface MatchContext {
  connection: Connection;
  coreProgram: { methods: Record<string, (...args: unknown[]) => unknown> };
  configPDA: PublicKey;
  botKeypair: Keypair;
  treasury?: TreasuryRuntime;
}

// ─── Open: enqueue treasury match ──────────────────────────────────────────

export interface OpenMatchArgs {
  /** Subset of the discord-bot context we actually need. */
  ctx: MatchContext;
  /** User who triggered the open — payout recipient at close. */
  userId: string;
  proposerWallet: PublicKey;
  /** The user's Path A position pda (used as link key in DB). */
  userPositionPda: PublicKey;
  /** 'Buy' or 'Sell' — same as user's side. Treasury matches in same direction. */
  side: 'Buy' | 'Sell';
  lbPair: PublicKey;
  minBinId: number;
  maxBinId: number;
  /** User's deposit amount in raw u64 of deposit mint. Match scales from this. */
  userAmount: bigint;
  /** Slippage param (matches user's). */
  slippage: number;
  /** Pre-resolved Meteora CPI accounts for the lb_pair (from resolveMeteoraCPIAccounts). */
  cpi: {
    lbPair: PublicKey;
    binArrayBitmapExt: PublicKey;
    reserveX: PublicKey;
    reserveY: PublicKey;
    binArrayLower: PublicKey;
    binArrayUpper: PublicKey;
    eventAuthority: PublicKey;
    dlmmProgram: PublicKey;
    tokenXMint: PublicKey;
    tokenYMint: PublicKey;
    tokenXProgramId: PublicKey;
    tokenYProgramId: PublicKey;
  };
  /** Decimals of the deposit token (X for sell, Y for buy). */
  depositDecimals: number;
}

/**
 * If Path B is enabled and the treasury has inventory for `side`, builds the
 * match payload and enqueues an OpenJob. Fire-and-forget — does NOT throw on
 * Path-B-side errors (logs them).
 *
 * Returns false when nothing was enqueued (Path B disabled, no inventory,
 * setup tx failed, etc.). True when the job was successfully queued.
 */
export async function enqueueOpenMatchIfPossible(args: OpenMatchArgs): Promise<boolean> {
  const treasury = args.ctx.treasury;
  if (!treasury) return false;

  try {
    // 1. Determine match amount via on-chain Config + treasury inventory.
    const matchAmount = await computeMatchAmount(args);
    if (matchAmount === 0n) {
      console.log(`[treasury-match] skipped: 0 match amount for ${args.side} ${args.lbPair.toBase58().slice(0, 8)}…`);
      return false;
    }

    // 2. Read treasury position counter for this lb_pair.
    const [counterPda] = getPositionCounterPDA(treasury.treasuryUserVault, args.lbPair);
    const counter = await readCounter(args.ctx.connection, counterPda);

    // 3. Derive treasury position PDAs.
    const [meteoraPosition] = getMeteoraPositionPDA(treasury.treasuryUserVault, args.lbPair, counter);
    const [position] = getPositionPDA(meteoraPosition);
    const [posVault] = getVaultPDA(meteoraPosition);

    // 4. Resolve treasury ATAs that the open ix will touch.
    const depositMint = args.side === 'Buy' ? args.cpi.tokenYMint : args.cpi.tokenXMint;
    const depositTokenProgram = args.side === 'Buy' ? args.cpi.tokenYProgramId : args.cpi.tokenXProgramId;
    const treasuryDepositAta = getAssociatedTokenAddressSync(
      depositMint, treasury.treasuryUserVault, true, depositTokenProgram,
    );
    const posVaultTokenX = getAssociatedTokenAddressSync(
      args.cpi.tokenXMint, posVault, true, args.cpi.tokenXProgramId,
    );
    const posVaultTokenY = getAssociatedTokenAddressSync(
      args.cpi.tokenYMint, posVault, true, args.cpi.tokenYProgramId,
    );

    // 5. Setup tx — create any missing ATAs (idempotent). Bot pays rent.
    //    Mirrors the Path A buildSetupTx pattern but for treasury-side ATAs.
    const setupSig = await runSetupTx(args.ctx, [
      { ata: treasuryDepositAta, owner: treasury.treasuryUserVault, mint: depositMint, tokenProgram: depositTokenProgram },
      { ata: posVaultTokenX, owner: posVault, mint: args.cpi.tokenXMint, tokenProgram: args.cpi.tokenXProgramId },
      { ata: posVaultTokenY, owner: posVault, mint: args.cpi.tokenYMint, tokenProgram: args.cpi.tokenYProgramId },
    ]);
    if (setupSig) console.log(`[treasury-match] setup tx ${setupSig}`);

    // 6. Build treasury open_position_v2 ix via Anchor coreProgram.methods.
    //    Same call as Path A's user open, but user_vault = treasury_user_vault.
    const rentLamports = await estimateRentLamports(args.ctx.connection, counter);
    const openIx = await buildTreasuryOpenIx(args, {
      counterPda, meteoraPosition, position, posVault,
      treasuryDepositAta, posVaultTokenX, posVaultTokenY,
      matchAmount, rentLamports,
    });

    // 7. Compose with record_settle_meta. caller = NTP because the proposal
    // executes via SPL Governance invoke_signed, which can only sign for the
    // realm's owned PDAs (= NTP). Bot is NOT a valid caller after PR-2.
    const innerIxs = composeOpenPayload(openIx, {
      caller: treasury.nativeTreasuryPda,
      treasuryVaultOwner: treasury.nativeTreasuryPda,
      meteoraPosition,
      tokenXMint: args.cpi.tokenXMint,
      tokenYMint: args.cpi.tokenYMint,
      proposer: args.proposerWallet,
    });

    // 8. Output mint = the OPPOSITE of deposit (sell deposits X → outputs Y).
    const outputMint = args.side === 'Buy' ? args.cpi.tokenXMint : args.cpi.tokenYMint;

    // 9. Enqueue the OpenJob.
    treasury.orchestrator.enqueue({
      kind: 'open',
      innerIxs,
      userPositionPda: args.userPositionPda.toBase58(),
      proposerUserId: args.userId,
      proposerWallet: args.proposerWallet.toBase58(),
      meteoraPosition: meteoraPosition.toBase58(),
      treasuryVault: treasury.treasuryUserVault.toBase58(),
      lbPair: args.lbPair.toBase58(),
      side: args.side,
      minBinId: args.minBinId,
      maxBinId: args.maxBinId,
      matchedAmount: matchAmount,
      outputMint: outputMint.toBase58(),
      // Read snapshot from on-chain Config — orchestrator persists this on the
      // TreasuryPositionRecord so close-time math knows the rate at open.
      payoutBps: await readPayoutBps(args.ctx),
      proposalName: `match-${args.side.toLowerCase()}-${meteoraPosition.toBase58().slice(0, 8)}`,
    });

    console.log(`[treasury-match] enqueued ${args.side} match: ${matchAmount} of ${depositMint.toBase58().slice(0, 8)}… for user ${args.userId}`);
    return true;
  } catch (e: unknown) {
    console.error(`[treasury-match] enqueue failed:`, e instanceof Error ? e.message : e);
    return false;
  }
}

// ─── Close: build atomic close payload + enqueue ───────────────────────────

export interface CloseMatchArgs {
  ctx: MatchContext;
  /**
   * Optional: the user's Path A close ix to bundle atomically. v1 omits this
   * (user's close runs as separate Path A tx); future versions can include it
   * for atomic user+treasury close in one governance proposal.
   */
  userUserCloseIx?: TransactionInstruction;
  /** Treasury position pda (from walletService.getTreasuryPositionByUserPosition). */
  treasuryPositionPda: PublicKey;
  /** The treasury position's meteora_position pubkey. */
  treasuryMeteoraPosition: PublicKey;
  /** The treasury position's user_close ix — caller builds via coreProgram.methods.userClose
   *  with caller=bot, user_vault=treasury_user_vault. */
  treasuryUserCloseIx: TransactionInstruction;
  /** Per-position vault's ATA for the OUTPUT mint (read for settle_proposer). */
  positionVaultOutputAta: PublicKey;
  /** Proposer's ATA for the output mint. */
  proposerOutputAta: PublicKey;
  outputMint: PublicKey;
  /** Token program for the output mint. Default Token. */
  tokenProgram?: PublicKey;
  proposerUserId: string;
  userPositionPda: string;
}

/**
 * Build the close payload (settle_proposer + treasury_user_close + close_settle
 * + user_user_close, in that order) and enqueue. Throws if Path B is disabled
 * (caller should fall back to the user-only close path).
 */
export function enqueueCloseMatch(args: CloseMatchArgs): void {
  const treasury = args.ctx.treasury;
  if (!treasury) {
    throw new Error('Path B disabled — cannot close a treasury-matched position via this path');
  }

  // caller = NTP for both settle ixs; PR-2 forces them through governance.
  const settleArgs = {
    caller: treasury.nativeTreasuryPda,
    treasuryVaultOwner: treasury.nativeTreasuryPda,
    meteoraPosition: args.treasuryMeteoraPosition,
    positionVaultOutputAta: args.positionVaultOutputAta,
    proposerOutputAta: args.proposerOutputAta,
    outputMint: args.outputMint,
    tokenProgram: args.tokenProgram,
  };
  const closeSettleArgs = {
    caller: treasury.nativeTreasuryPda,
    treasuryVaultOwner: treasury.nativeTreasuryPda,
    meteoraPosition: args.treasuryMeteoraPosition,
  };

  const innerIxs = composeClosePayload(
    settleArgs,
    args.treasuryUserCloseIx,
    closeSettleArgs,
    args.userUserCloseIx,
  );

  treasury.orchestrator.enqueue({
    kind: 'close',
    innerIxs,
    userPositionPda: args.userPositionPda,
    treasuryPositionPda: args.treasuryPositionPda.toBase58(),
    proposerUserId: args.proposerUserId,
    proposalName: `close-${args.treasuryMeteoraPosition.toBase58().slice(0, 8)}`,
  });
}

// ─── Internal helpers ──────────────────────────────────────────────────────

async function readCounter(connection: Connection, counterPda: PublicKey): Promise<number> {
  try {
    const info = await connection.getAccountInfo(counterPda);
    if (!info || info.data.length < 16) return 0;
    return Number(
      new DataView(info.data.buffer, info.data.byteOffset).getBigUint64(8, true),
    );
  } catch {
    return 0;
  }
}

async function readPayoutBps(ctx: MatchContext): Promise<number> {
  // Read Config.payout_bps directly from chain. Falls back to 2000 if read fails
  // (default at deploy). Snapshot at enqueue time, NOT at execute — close-time
  // payout uses the per-position PositionSettle's snapshot anyway, so this is
  // just for DB record-keeping.
  try {
    const info = await ctx.connection.getAccountInfo(ctx.configPDA);
    if (!info) return 2000;
    // Config layout: 8 disc + 32 authority + 32 pending_authority + 32 bot
    //   + 2 fee_bps + 2 pending_fee_bps + 8 fee_change_at
    //   + 8 total_positions + 8 total_volume + 1 paused + 1 bot_paused + 1 bump
    //   + 8 last_bot_harvest_slot + 2 keeper_tip_bps + 8 priority_slots + 8 total_harvested
    //   + 32 pending_emergency_close + 8 emergency_close_at
    //   + 8 last_bot_close_slot + 8 last_bot_sweep_slot
    //   + 8 gas_lamports + 32 fee_dest
    //   = offset 220 → payout_bps (u16 LE)
    const PAYOUT_BPS_OFFSET = 220;
    if (info.data.length < PAYOUT_BPS_OFFSET + 2) return 2000;
    return info.data.readUInt16LE(PAYOUT_BPS_OFFSET);
  } catch {
    return 2000;
  }
}

async function readMatchRatioBps(ctx: MatchContext): Promise<number> {
  try {
    const info = await ctx.connection.getAccountInfo(ctx.configPDA);
    if (!info) return 10000;
    const MATCH_RATIO_OFFSET = 222; // payout_bps + 2
    if (info.data.length < MATCH_RATIO_OFFSET + 2) return 10000;
    return info.data.readUInt16LE(MATCH_RATIO_OFFSET);
  } catch {
    return 10000;
  }
}

async function computeMatchAmount(args: OpenMatchArgs): Promise<bigint> {
  const matchRatioBps = await readMatchRatioBps(args.ctx);
  if (matchRatioBps === 0) return 0n;

  // Desired amount based on user's amount + match ratio.
  const desired = (args.userAmount * BigInt(matchRatioBps)) / 10_000n;

  // Cap at treasury inventory of the deposit mint. For sells, treasury sends
  // the BASE token (X = CRANK typically); for buys, the QUOTE (Y = SOL/USDC).
  const treasury = args.ctx.treasury!;
  const depositMint = args.side === 'Buy' ? args.cpi.tokenYMint : args.cpi.tokenXMint;
  const depositTokenProgram = args.side === 'Buy' ? args.cpi.tokenYProgramId : args.cpi.tokenXProgramId;

  if (depositMint.equals(NATIVE_MINT)) {
    // SOL path: cap at native lamports balance minus rent + buffer.
    const lamports = await args.ctx.connection.getBalance(treasury.treasuryUserVault);
    const RESERVE_FOR_RENT_AND_GAS = 100_000_000n; // 0.1 SOL
    const available = lamports > Number(RESERVE_FOR_RENT_AND_GAS)
      ? BigInt(lamports) - RESERVE_FOR_RENT_AND_GAS
      : 0n;
    return desired < available ? desired : available;
  }

  // Token path: read the treasury vault's ATA balance for the deposit mint.
  const treasuryAta = getAssociatedTokenAddressSync(
    depositMint, treasury.treasuryUserVault, true, depositTokenProgram,
  );
  try {
    const bal = await args.ctx.connection.getTokenAccountBalance(treasuryAta);
    const available = BigInt(bal.value.amount);
    return desired < available ? desired : available;
  } catch {
    return 0n; // ATA doesn't exist → no inventory yet
  }
}

async function runSetupTx(
  ctx: MatchContext,
  atas: { ata: PublicKey; owner: PublicKey; mint: PublicKey; tokenProgram: PublicKey }[],
): Promise<string | null> {
  const ixs: TransactionInstruction[] = [];
  for (const a of atas) {
    const info = await ctx.connection.getAccountInfo(a.ata);
    if (info) continue;
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        ctx.botKeypair.publicKey,
        a.ata,
        a.owner,
        a.mint,
        a.tokenProgram,
      ),
    );
  }
  if (ixs.length === 0) return null;
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }))
    .add(...ixs);
  tx.feePayer = ctx.botKeypair.publicKey;
  return await sendAndConfirmTransaction(ctx.connection, tx, [ctx.botKeypair], {
    commitment: 'confirmed',
  });
}

async function estimateRentLamports(connection: Connection, counter: number): Promise<BN> {
  // Conservative estimate matching Path A's `rentLamports` calculation in buy.ts.
  // Position (~146B) + Vault (~41B) + MeteoraPositionV2 (~8328B) [+ Counter (~25B) if first].
  const counterExists = counter > 0;
  const [position, vault, meteoraPos, counterRent] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(8 + 138),
    connection.getMinimumBalanceForRentExemption(8 + 33),
    connection.getMinimumBalanceForRentExemption(8328),
    counterExists ? Promise.resolve(0) : connection.getMinimumBalanceForRentExemption(8 + 17),
  ]);
  return new BN(position + vault + meteoraPos + counterRent);
}

async function buildTreasuryOpenIx(
  args: OpenMatchArgs,
  resolved: {
    counterPda: PublicKey;
    meteoraPosition: PublicKey;
    position: PublicKey;
    posVault: PublicKey;
    treasuryDepositAta: PublicKey;
    posVaultTokenX: PublicKey;
    posVaultTokenY: PublicKey;
    matchAmount: bigint;
    rentLamports: BN;
  },
): Promise<TransactionInstruction> {
  const treasury = args.ctx.treasury!;
  const sideEnum = args.side === 'Buy' ? { buy: {} } : { sell: {} };

  // Build via Anchor coreProgram.methods — same call signature as Path A.
  // The user_vault is swapped to the treasury vault; everything else mirrors.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = args.ctx.coreProgram.methods as any;
  const ix: TransactionInstruction = await methods
    .openPositionV2(
      new BN(resolved.matchAmount.toString()),
      args.minBinId,
      args.maxBinId,
      sideEnum,
      args.slippage,
      resolved.rentLamports,
    )
    .accounts({
      bot: args.ctx.botKeypair.publicKey,
      userVault: treasury.treasuryUserVault,
      config: args.ctx.configPDA,
      lbPair: args.cpi.lbPair,
      positionCounter: resolved.counterPda,
      meteoraPosition: resolved.meteoraPosition,
      binArrayBitmapExt: args.cpi.binArrayBitmapExt,
      reserveX: args.cpi.reserveX,
      reserveY: args.cpi.reserveY,
      position: resolved.position,
      vault: resolved.posVault,
      userVaultDepositAta: resolved.treasuryDepositAta,
      vaultTokenX: resolved.posVaultTokenX,
      vaultTokenY: resolved.posVaultTokenY,
      tokenXProgram: args.cpi.tokenXProgramId,
      tokenYProgram: args.cpi.tokenYProgramId,
      systemProgram: new PublicKey('11111111111111111111111111111111'),
      binArrayLower: args.cpi.binArrayLower,
      binArrayUpper: args.cpi.binArrayUpper,
      eventAuthority: args.cpi.eventAuthority,
      dlmmProgram: args.cpi.dlmmProgram,
      tokenXMint: args.cpi.tokenXMint,
      tokenYMint: args.cpi.tokenYMint,
    })
    .instruction();

  // Bitmap-ext writability flip — mirrors Path A's buy.ts:460-471.
  // Meteora's AddLiquidityByStrategy2 requires it writable; IDL marks read-only.
  if (!args.cpi.binArrayBitmapExt.equals(args.cpi.dlmmProgram)) {
    for (const k of ix.keys) {
      if (k.pubkey.equals(args.cpi.binArrayBitmapExt)) k.isWritable = true;
    }
  }

  return ix;
}

// Re-export for buy.ts/sell.ts to use without a separate import path.
export { CRANK_MINT };
