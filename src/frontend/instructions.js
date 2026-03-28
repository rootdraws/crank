// ============================================================
// instructions.js — On-chain instruction helpers + Codama re-exports
// Extracted from public/app.js (Phase 1 structural extraction)
// ============================================================

import { state } from './state.js';
import {
  CONFIG,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  binIdToBinArrayIndex,
  deriveBinArrayPDA,
  deriveEventAuthorityPDA,
  deriveBitmapExtPDA,
  METEORA_DLMM_PROGRAM,
} from './constants.js';
import { toEncodedAccount } from './wallet.js';
import { parseLbPairFull } from './pages/trade.js';

// ============================================================
// CODAMA-GENERATED CLIENTS — re-exported for consumer modules
// ============================================================

export {
  getOpenPositionV2InstructionAsync,
  getUserCloseInstructionAsync,
  getClaimFeesInstruction,
  getHarvestBinsInstructionAsync,
  getSweepRoverInstructionAsync,
  decodePosition, decodeConfig,
  BIN_FARM_PROGRAM_ADDRESS, Side,
} from '../../src/generated/bin-farm/index.js';

export {
  getFeedMonkeInstructionAsync,
  getFeedGooseInstructionAsync,
  getClaimInstructionAsync,
  getClaimPeggedInstructionAsync,
  getDepositSolInstructionAsync,
  getDepositPeggedInstructionAsync,
  getSetPeggedMintInstructionAsync,
  decodeMonkeBurn, decodeMonkeState,
  MONKE_BANANAS_PROGRAM_ADDRESS,
} from '../../src/generated/monke-bananas/index.js';

export {
  getStakeAndForwardInstructionAsync,
} from '../../src/generated/pegged-bridge/index.js';

// Local import for loadOnChainFeeBps
import { decodeConfig as _decodeConfig, BIN_FARM_PROGRAM_ADDRESS as _BIN_FARM_PROGRAM_ADDRESS } from '../../src/generated/bin-farm/index.js';

// ============================================================
// FEE BPS — read from on-chain Config
// ============================================================

export async function loadOnChainFeeBps() {
  try {
    if (!state.connection) return;
    const [configPDA] = solanaWeb3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('config')],
      new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
    );
    const accountInfo = await state.connection.getAccountInfo(configPDA);
    if (accountInfo && accountInfo.data.length >= 138) {
      const decoded = _decodeConfig(toEncodedAccount(configPDA, accountInfo.data, _BIN_FARM_PROGRAM_ADDRESS));
      const feeBps = decoded.data.feeBps;
      if (feeBps > 0 && feeBps <= 1000) {
        CONFIG.FEE_BPS = feeBps;
        console.log('On-chain fee_bps loaded:', feeBps);
      }
    }
  } catch {
    // Fall back to config.json value silently
  }
}

// ============================================================
// BIN ARRAY HELPERS
// ============================================================

/**
 * Build Meteora initializeBinArray instruction.
 * Discriminator from IDL: [35, 86, 19, 185, 78, 212, 75, 211]
 */
function buildInitBinArrayIx(lbPairPubkey, binArrayPDA, funderPubkey, arrayIndex, dlmmProgramId) {
  const disc = new Uint8Array([35, 86, 19, 185, 78, 212, 75, 211]);
  const argBuf = new ArrayBuffer(8);
  new DataView(argBuf).setBigInt64(0, BigInt(arrayIndex), true);
  const data = new Uint8Array(disc.length + 8);
  data.set(disc, 0);
  data.set(new Uint8Array(argBuf), disc.length);

  return new solanaWeb3.TransactionInstruction({
    programId: dlmmProgramId,
    keys: [
      { pubkey: lbPairPubkey, isSigner: false, isWritable: false },
      { pubkey: binArrayPDA, isSigner: false, isWritable: true },
      { pubkey: funderPubkey, isSigner: true, isWritable: true },
      { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Check bin arrays for the given range and return init instructions for any missing ones.
 */
export async function ensureBinArraysExist(lbPairPubkey, minBinId, maxBinId, funder, dlmmProgramId) {
  const conn = state.connection;
  const indices = new Set();
  indices.add(binIdToBinArrayIndex(minBinId));
  indices.add(binIdToBinArrayIndex(maxBinId));
  const sorted = [...indices].sort((a, b) => a - b);

  const ixs = [];
  for (const idx of sorted) {
    const pda = deriveBinArrayPDA(lbPairPubkey, idx, dlmmProgramId);
    const info = await conn.getAccountInfo(pda);
    if (!info) {
      ixs.push(buildInitBinArrayIx(lbPairPubkey, pda, funder, idx, dlmmProgramId));
    }
  }
  return ixs;
}

// ============================================================
// METEORA CPI ACCOUNTS
// ============================================================

/**
 * Resolve all Meteora CPI accounts needed for open_position.
 * Reads LbPair on-chain for reserves/mints/program flags.
 */
export async function resolveMeteoraCPIAccounts(poolAddress, minBinId, maxBinId) {
  const lbPairPubkey = new solanaWeb3.PublicKey(poolAddress);
  const dlmmProgramId = new solanaWeb3.PublicKey(METEORA_DLMM_PROGRAM);
  const conn = state.connection;

  const pool = await parseLbPairFull(poolAddress);

  const lowerIdx = binIdToBinArrayIndex(minBinId);
  const upperIdx = binIdToBinArrayIndex(maxBinId);
  const binArrayLower = deriveBinArrayPDA(lbPairPubkey, lowerIdx, dlmmProgramId);
  const binArrayUpper = deriveBinArrayPDA(lbPairPubkey, upperIdx, dlmmProgramId);

  const eventAuthority = deriveEventAuthorityPDA(dlmmProgramId);

  const bitmapExtPDA = deriveBitmapExtPDA(lbPairPubkey, dlmmProgramId);
  let binArrayBitmapExt;
  try {
    const bitmapInfo = await conn.getAccountInfo(bitmapExtPDA);
    binArrayBitmapExt = bitmapInfo ? bitmapExtPDA : dlmmProgramId;
  } catch {
    binArrayBitmapExt = dlmmProgramId;
  }

  return {
    lbPair: lbPairPubkey,
    binArrayBitmapExt,
    binArrayLower,
    binArrayUpper,
    reserveX: pool.reserveX,
    reserveY: pool.reserveY,
    tokenXMint: pool.tokenXMint,
    tokenYMint: pool.tokenYMint,
    eventAuthority,
    dlmmProgram: dlmmProgramId,
    tokenXProgramId: pool.tokenXProgramFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    tokenYProgramId: pool.tokenYProgramFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
  };
}

// ============================================================
// MINT DECIMALS
// ============================================================

/** Read mint decimals at runtime (works without wallet connection) */
export const DECIMALS_CACHE = {};
export async function getMintDecimals(mintAddress) {
  if (!mintAddress) return 9;
  if (DECIMALS_CACHE[mintAddress] !== undefined) return DECIMALS_CACHE[mintAddress];
  try {
    const conn = state.connection || new solanaWeb3.Connection(
      CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed'
    );
    const pubkey = new solanaWeb3.PublicKey(mintAddress);
    const info = await conn.getParsedAccountInfo(pubkey);
    const dec = info.value?.data?.parsed?.info?.decimals ?? 9;
    DECIMALS_CACHE[mintAddress] = dec;
    return dec;
  } catch {
    return 9;
  }
}

// ============================================================
// BID-ASK PREVIEW
// ============================================================

export function computeBidAskPreview(amount, minBin, maxBin, activeBin) {
  const numBins = maxBin - minBin + 1;
  if (numBins <= 0 || amount <= 0) return new Map();

  // BidAsk: linear ramp — weight increases with distance from active bin
  const weights = [];
  let totalWeight = 0;
  for (let bin = minBin; bin <= maxBin; bin++) {
    const dist = Math.abs(bin - activeBin);
    const w = Math.max(1, dist);
    weights.push({ bin, w });
    totalWeight += w;
  }

  const preview = new Map();
  for (const { bin, w } of weights) {
    const share = (w / totalWeight) * amount;
    preview.set(bin, share);
  }
  return preview;
}

