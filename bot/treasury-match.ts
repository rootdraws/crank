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
} from '@solana/spl-token';
import {
  getPositionCounterPDA,
  getMeteoraPositionPDA,
  getPositionPDA,
  getVaultPDA,
  buildAuthorizeTreasuryOpenIx,
  buildAuthorizeTreasuryCloseIx,
  buildWrapCallerSolIx,
  type TreasuryOpenCombinedArgs,
  type TreasuryCloseCombinedArgs,
  NATIVE_MINT,
  CRANK_MINT,
} from '@crankbot/core-sdk';
import type { TreasuryRuntime } from './treasury-runtime';

function formatTokenAmount(raw: bigint, mint: PublicKey): string {
  const isSol = mint.equals(NATIVE_MINT);
  const decimals = isSol ? 9 : 6;
  const symbol = isSol ? 'SOL' : 'CRANK';
  const value = Number(raw) / 10 ** decimals;
  const formatted = value >= 1000
    ? value.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : value.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return `${formatted} ${symbol}`;
}

function tokenSymbol(mint: PublicKey): string {
  return mint.equals(NATIVE_MINT) ? 'SOL' : 'CRANK';
}

function shortWallet(wallet: PublicKey): string {
  const s = wallet.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function proposerLabel(handle: string | undefined, wallet: PublicKey): string {
  return handle ? `@${handle}` : shortWallet(wallet);
}

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
  /** Discord username (no @ prefix). Falls back to short wallet in proposal name when absent. */
  proposerHandle?: string;
  /** Pre-built proposal name (overrides default). Caller has price/mcap context, build the rich title there. */
  proposalName?: string;
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
    // NTP's direct ATA — protocol's canonical (Realms-visible) reserve. Source
    // for the deposit_treasury_token ix that flows working capital into vault.
    const ntpDepositAta = getAssociatedTokenAddressSync(
      depositMint, treasury.nativeTreasuryPda, true, depositTokenProgram,
    );
    const posVaultTokenX = getAssociatedTokenAddressSync(
      args.cpi.tokenXMint, posVault, true, args.cpi.tokenXProgramId,
    );
    const posVaultTokenY = getAssociatedTokenAddressSync(
      args.cpi.tokenYMint, posVault, true, args.cpi.tokenYProgramId,
    );

    // 5. Setup tx — create any missing ATAs (idempotent). Bot pays rent.
    //    NTP's ATA is created here so the bot-as-delegate transfer in
    //    treasury_open_combined has a source.
    const setupSig = await runSetupTx(args.ctx, [
      { ata: ntpDepositAta, owner: treasury.nativeTreasuryPda, mint: depositMint, tokenProgram: depositTokenProgram },
      { ata: treasuryDepositAta, owner: treasury.treasuryUserVault, mint: depositMint, tokenProgram: depositTokenProgram },
      { ata: posVaultTokenX, owner: posVault, mint: args.cpi.tokenXMint, tokenProgram: args.cpi.tokenXProgramId },
      { ata: posVaultTokenY, owner: posVault, mint: args.cpi.tokenYMint, tokenProgram: args.cpi.tokenYProgramId },
    ]);
    if (setupSig) console.log(`[treasury-match] setup tx ${setupSig}`);

    // 6. Marker pattern: 1-2 inner ixs.
    //    - For SOL deposits: wrap only the gap between matchAmount and any
    //      WSOL already sitting in NTP's WSOL ATA (leftover from a prior
    //      consume failure). If existing balance already covers matchAmount,
    //      skip the wrap entirely. Prevents accumulation of orphan WSOL when
    //      consume fails — failures cost at most one wrap, recovered by the
    //      next successful match.
    //    - All sides: authorize_treasury_open mints TradeAuth that the bot
    //      consumes via treasury_open_combined after proposal execute.
    const sideByte = args.side === 'Buy' ? 1 : 0;
    const innerIxs: TransactionInstruction[] = [];
    if (depositMint.equals(NATIVE_MINT)) {
      let existingWsol = 0n;
      try {
        const bal = await args.ctx.connection.getTokenAccountBalance(ntpDepositAta);
        existingWsol = BigInt(bal.value.amount);
      } catch { /* ATA freshly created in setupSig — balance 0 */ }
      const wrapAmount = matchAmount > existingWsol ? matchAmount - existingWsol : 0n;
      if (wrapAmount > 0n) {
        innerIxs.push(buildWrapCallerSolIx({
          caller: treasury.nativeTreasuryPda,
          callerWsolAta: ntpDepositAta,
          amount: wrapAmount,
        }));
      }
    }
    innerIxs.push(buildAuthorizeTreasuryOpenIx({
      caller: treasury.nativeTreasuryPda,
      treasuryVaultOwner: treasury.nativeTreasuryPda,
      lbPair: args.lbPair,
      side: sideByte as 0 | 1,
      amount: matchAmount,
      minBinId: args.minBinId,
      maxBinId: args.maxBinId,
      slippage: args.slippage,
      proposer: args.proposerWallet,
    }));

    // 7. Combined-ix args for the post-execute direct tx.
    const combinedOpenArgs: TreasuryOpenCombinedArgs = {
      bot: args.ctx.botKeypair.publicKey,
      treasuryVaultOwner: treasury.nativeTreasuryPda,
      lbPair: args.cpi.lbPair,
      positionCounter: counterPda,
      meteoraPosition,
      binArrayBitmapExt: args.cpi.binArrayBitmapExt,
      reserveX: args.cpi.reserveX,
      reserveY: args.cpi.reserveY,
      position,
      vault: posVault,
      userVaultDepositAta: treasuryDepositAta,
      vaultTokenX: posVaultTokenX,
      vaultTokenY: posVaultTokenY,
      tokenXProgram: args.cpi.tokenXProgramId,
      tokenYProgram: args.cpi.tokenYProgramId,
      binArrayLower: args.cpi.binArrayLower,
      binArrayUpper: args.cpi.binArrayUpper,
      eventAuthority: args.cpi.eventAuthority,
      dlmmProgram: args.cpi.dlmmProgram,
      tokenXMint: args.cpi.tokenXMint,
      tokenYMint: args.cpi.tokenYMint,
      callerTokenAccount: ntpDepositAta,
      depositTokenMint: depositMint,
      depositTokenProgram,
      // rent_lamports unused on-chain — bot fronts bin-array rent + recovers
      // it via Meteora close + manual close-to-bot in treasury_close_combined.
      rentLamports: 0n,
    };

    // 8. Output mint = the OPPOSITE of deposit (sell deposits X → outputs Y).
    const outputMint = args.side === 'Buy' ? args.cpi.tokenXMint : args.cpi.tokenYMint;

    // 9. Enqueue the OpenJob.
    treasury.orchestrator.enqueue({
      kind: 'open',
      innerIxs,
      combinedOpenArgs,
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
      payoutBps: await readPayoutBps(args.ctx),
      proposalName: args.proposalName ?? (args.side === 'Buy'
        ? `Treasury buy: ${formatTokenAmount(matchAmount, depositMint)} → CRANK · by ${proposerLabel(args.proposerHandle, args.proposerWallet)}`
        : `Treasury sell: ${formatTokenAmount(matchAmount, depositMint)} → SOL · by ${proposerLabel(args.proposerHandle, args.proposerWallet)}`),
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
  /** Treasury position pda (from walletService.getTreasuryPositionByUserPosition). */
  treasuryPositionPda: PublicKey;
  /** The treasury position's meteora_position pubkey. */
  treasuryMeteoraPosition: PublicKey;
  /** The treasury position's lb_pair (must match TradeAuth.lb_pair at consume time). */
  lbPair: PublicKey;
  /** Per-position vault's ATA for the OUTPUT mint. */
  positionVaultOutputAta: PublicKey;
  /** Proposer's ATA for the output mint. */
  proposerOutputAta: PublicKey;
  outputMint: PublicKey;
  /** Token program for the output mint (Token vs Token-2022). */
  outputTokenProgram: PublicKey;
  /** Tax reserve's ATA for output mint, or null when tax routing disabled. */
  taxReserveOutputAta: PublicKey | null;
  /** Pre-resolved Meteora CPI accounts for the position's lb_pair. */
  cpi: {
    binArrayBitmapExt: PublicKey;
    binArrayLower: PublicKey;
    binArrayUpper: PublicKey;
    reserveX: PublicKey;
    reserveY: PublicKey;
    tokenXMint: PublicKey;
    tokenYMint: PublicKey;
    eventAuthority: PublicKey;
    dlmmProgram: PublicKey;
    tokenXProgramId: PublicKey;
    tokenYProgramId: PublicKey;
  };
  /** Per-position vault's token X/Y ATAs and treasury vault's token X/Y ATAs. */
  vaultTokenX: PublicKey;
  vaultTokenY: PublicKey;
  /** NTP's direct token-X ATA (CRANK ATA). Realms-visible residue destination. */
  ntpTokenXAta: PublicKey;
  /** NTP pubkey — passive lamport destination for WSOL ATA close on residue Y. */
  ntpSolAccount: PublicKey;
  feeDest: PublicKey;
  feeDestTokenX: PublicKey;
  feeDestTokenY: PublicKey;
  proposerUserId: string;
  proposerWallet: PublicKey;
  /** Discord username (no @ prefix). Falls back to short wallet in proposal name when absent. */
  proposerHandle?: string;
  /** Pre-built proposal name (overrides default). Caller has price/mcap context, build the rich title there. */
  proposalName?: string;
  userPositionPda: string;
}

/**
 * Marker-pattern close: enqueues a 1-ix proposal (`authorize_treasury_close`)
 * that creates a TradeAuth. After execute, bot consumes via
 * `treasury_close_combined` (settle_proposer + user_close + close_settle inlined).
 */
export function enqueueCloseMatch(args: CloseMatchArgs): void {
  const treasury = args.ctx.treasury;
  if (!treasury) {
    throw new Error('Path B disabled — cannot close a treasury-matched position via this path');
  }

  const markerIx = buildAuthorizeTreasuryCloseIx({
    caller: treasury.nativeTreasuryPda,
    treasuryVaultOwner: treasury.nativeTreasuryPda,
    lbPair: args.lbPair,
    proposer: args.proposerWallet,
  });
  const innerIxs = [markerIx];

  const combinedCloseArgs: TreasuryCloseCombinedArgs = {
    bot: args.ctx.botKeypair.publicKey,
    treasuryVaultOwner: treasury.nativeTreasuryPda,
    meteoraPosition: args.treasuryMeteoraPosition,
    lbPair: args.lbPair,
    binArrayBitmapExt: args.cpi.binArrayBitmapExt,
    binArrayLower: args.cpi.binArrayLower,
    binArrayUpper: args.cpi.binArrayUpper,
    reserveX: args.cpi.reserveX,
    reserveY: args.cpi.reserveY,
    tokenXMint: args.cpi.tokenXMint,
    tokenYMint: args.cpi.tokenYMint,
    eventAuthority: args.cpi.eventAuthority,
    dlmmProgram: args.cpi.dlmmProgram,
    vaultTokenX: args.vaultTokenX,
    vaultTokenY: args.vaultTokenY,
    ntpTokenXAta: args.ntpTokenXAta,
    ntpSolAccount: args.ntpSolAccount,
    feeDest: args.feeDest,
    feeDestTokenX: args.feeDestTokenX,
    feeDestTokenY: args.feeDestTokenY,
    tokenXProgram: args.cpi.tokenXProgramId,
    tokenYProgram: args.cpi.tokenYProgramId,
    outputMint: args.outputMint,
    positionVaultOutputAta: args.positionVaultOutputAta,
    proposerOutputAta: args.proposerOutputAta,
    taxReserveOutputAta: args.taxReserveOutputAta,
    outputTokenProgram: args.outputTokenProgram,
  };

  treasury.orchestrator.enqueue({
    kind: 'close',
    innerIxs,
    combinedCloseArgs,
    userPositionPda: args.userPositionPda,
    treasuryPositionPda: args.treasuryPositionPda.toBase58(),
    proposerUserId: args.proposerUserId,
    proposerWallet: args.proposerWallet.toBase58(),
    proposalName: args.proposalName ?? `Treasury close: position → ${tokenSymbol(args.outputMint)} · by ${proposerLabel(args.proposerHandle, args.proposerWallet)}`,
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
    // Config v2 layout (327B total):
    //   8 disc + 32 authority + 32 pending_authority + 32 bot
    //   + 2 fee_bps + 2 pending_fee_bps + 8 fee_change_at
    //   + 8 total_positions + 8 total_volume + 1 paused + 1 bot_paused + 1 bump
    //   + 8 last_bot_harvest_slot + 2 keeper_tip_bps + 8 priority_slots + 8 total_harvested
    //   + 32 pending_emergency_close + 8 emergency_close_at
    //   + 8 last_bot_close_slot + 8 last_bot_sweep_slot
    //   + 8 gas_lamports + 32 fee_dest
    //   = offset 257 → payout_bps (u16 LE)
    const PAYOUT_BPS_OFFSET = 257;
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
    const MATCH_RATIO_OFFSET = 259; // payout_bps + 2 (Config v2)
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
    // SOL path: read NTP native lamports — that's the Realms-visible balance
    // the marker proposal's wrap_caller_sol will draw from. Reserve covers
    // TradeAuth rent (~0.002 SOL/fire), tx fees, and a safety buffer.
    const lamports = await args.ctx.connection.getBalance(treasury.nativeTreasuryPda);
    const RESERVE_FOR_RENT_AND_GAS = 100_000_000n; // 0.1 SOL
    const available = lamports > Number(RESERVE_FOR_RENT_AND_GAS)
      ? BigInt(lamports) - RESERVE_FOR_RENT_AND_GAS
      : 0n;
    return desired < available ? desired : available;
  }

  // Token path: inventory lives in NTP's direct (Realms-visible) ATA — that's
  // the source the proposal's deposit_treasury_token ix will read from. The
  // vault's ATA is empty between trades by design (CRANK migrates back on
  // close to keep Realms accurate), so reading it would underreport.
  const ntpAta = getAssociatedTokenAddressSync(
    depositMint, treasury.nativeTreasuryPda, true, depositTokenProgram,
  );
  try {
    const bal = await args.ctx.connection.getTokenAccountBalance(ntpAta);
    const available = BigInt(bal.value.amount);
    return desired < available ? desired : available;
  } catch {
    return 0n; // NTP ATA doesn't exist → no inventory yet
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

// Re-export for buy.ts/sell.ts to use without a separate import path.
export { CRANK_MINT };
