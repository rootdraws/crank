// --- CONFIG + loadConfig (lines 46-73) ---

export const CONFIG = {
  RPC_URL: 'https://api.mainnet-beta.solana.com',
  FEE_BPS: 30,
  CORE_PROGRAM_ID: '8FJyoK7UKhYB8qd8187oVWFngQ5ZoVPbNWXSUeZSdgia',
  MONKE_BANANAS_PROGRAM_ID: 'myA2F4S7trnQUiksrrB1prR3k95d8znEXZXwHkZw5ZH',
  BANANAS_MINT: 'Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump',
  SMB_COLLECTION: 'SMBtHCCC6RYRutFEPb4gZqeBLUZbMNhRKaMKZZLHi7W',
  BIRDEYE_API_KEY: '',
  DEFAULT_POOL: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  GOOSE_PIXEL_COLLECTION: '6ubyyuUz3EVFwZrBh3C2ezSXXfyjxP4jhemLPyGgdL6Y',
  GOOSE_DAO_COLLECTION: 'XkH2QVN9AKNi1AGnaEYdEHCHxFjTjs8BdbTJfcRW2rY',
  MPL_CORE_PROGRAM_ID: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
  DEBUG: false,
};

export async function loadConfig() {
  try {
    const resp = await fetch('/config.json');
    if (resp.ok) {
      const json = await resp.json();
      Object.assign(CONFIG, json);
    }
  } catch {
    // Use hardcoded defaults (dev mode)
  }
  window.CONFIG = CONFIG;
}

// --- PDA derivation functions (lines 528-609) ---

export function getConfigPDA() {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('config')],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

export function getPositionPDA(meteoraPosition) {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('position'), meteoraPosition.toBytes()],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

export function getVaultPDA(meteoraPosition) {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('vault'), meteoraPosition.toBytes()],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

export function getPositionCounterPDA(user, lbPair) {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('pos_counter'), user.toBytes(), lbPair.toBytes()],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

export function getMeteoraPosiitonPDA(user, lbPair, count) {
  const countBuf = new Uint8Array(8);
  new DataView(countBuf.buffer).setBigUint64(0, BigInt(count), true);
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('meteora_pos'), user.toBytes(), lbPair.toBytes(), countBuf],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

export function getRoverAuthorityPDA() {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('rover_authority')],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

/** PDA derivation — monke_bananas program */
export function getMonkeStatePDA() {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('monke_state')],
    new solanaWeb3.PublicKey(CONFIG.MONKE_BANANAS_PROGRAM_ID)
  );
}

export function getMonkeBurnPDA(nftMint) {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('monke_burn'), nftMint.toBytes()],
    new solanaWeb3.PublicKey(CONFIG.MONKE_BANANAS_PROGRAM_ID)
  );
}

export function getDistPoolPDA() {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('dist_pool')],
    new solanaWeb3.PublicKey(CONFIG.MONKE_BANANAS_PROGRAM_ID)
  );
}

export function getProgramVaultPDA() {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('program_vault')],
    new solanaWeb3.PublicKey(CONFIG.MONKE_BANANAS_PROGRAM_ID)
  );
}

/** PDA derivation — Metaplex Token Metadata */
export const METAPLEX_PROGRAM_ID = new solanaWeb3.PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

export function getMetadataPDA(nftMint) {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('metadata'), METAPLEX_PROGRAM_ID.toBytes(), nftMint.toBytes()],
    METAPLEX_PROGRAM_ID
  );
}

// --- PRECISION + computePendingClaim (lines 612-619) ---

export const PRECISION = 1_000_000_000_000n;

/** Compute pending SOL claim for a MonkeBurn given MonkeState accumulator */
export function computePendingClaim(burn, monkeState) {
  if (!burn || !monkeState || burn.shareWeight === 0n) return 0n;
  const pending = (burn.shareWeight * monkeState.accumulatedSolPerShare / PRECISION) - burn.rewardDebt;
  return pending > 0n ? pending : 0n;
}

// --- Token program constants (lines 621-627) ---

export const TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new solanaWeb3.PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SPL_MEMO_PROGRAM_ID = new solanaWeb3.PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const SYSVAR_RENT_PUBKEY = new solanaWeb3.PublicKey('SysvarRent111111111111111111111111111111111');
export const NATIVE_MINT = new solanaWeb3.PublicKey('So11111111111111111111111111111111111111112');

// --- ATA/system helpers (lines 630-687) ---

export function getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve = false, tokenProgramId = TOKEN_PROGRAM_ID) {
  const [ata] = solanaWeb3.PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgramId.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

/** Build create-ATA-idempotent instruction (won't fail if ATA already exists) */
export function createAssociatedTokenAccountIx(payer, ata, owner, mint, tokenProgramId = TOKEN_PROGRAM_ID) {
  return new solanaWeb3.TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([1]),
  });
}


/** SPL Token SyncNative instruction (index 17) — syncs WSOL ATA balance after SOL transfer */
export function createSyncNativeIx(nativeAccount) {
  return new solanaWeb3.TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: nativeAccount, isSigner: false, isWritable: true }],
    data: new Uint8Array([17]),
  });
}

/** Build SystemProgram transfer without Buffer dependency */
export function buildSystemTransferIx(from, to, lamports) {
  const amount = typeof lamports === 'bigint' ? lamports : BigInt(lamports);
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // transfer instruction index = 2
  view.setBigUint64(4, amount, true);
  return new solanaWeb3.TransactionInstruction({
    programId: solanaWeb3.SystemProgram.programId,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data,
  });
}

/** Wrap SOL: transfer lamports to WSOL ATA + sync native */
export function buildWrapSolIxs(from, wsolAta, lamports) {
  return [
    buildSystemTransferIx(from, wsolAta, lamports),
    createSyncNativeIx(wsolAta),
  ];
}

// --- Meteora PDA helpers (lines 690-745) ---

export function deriveBinArrayPDA(lbPairPubkey, arrayIndex, dlmmProgramId) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigInt64(0, BigInt(arrayIndex), true);
  const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('bin_array'), lbPairPubkey.toBytes(), new Uint8Array(buf)],
    dlmmProgramId
  );
  return pda;
}

/** Derive Meteora event authority PDA */
export function deriveEventAuthorityPDA(dlmmProgramId) {
  const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('__event_authority')],
    dlmmProgramId
  );
  return pda;
}

/** Derive Meteora bin array bitmap extension PDA */
export function deriveBitmapExtPDA(lbPairPubkey, dlmmProgramId) {
  const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('bitmap'), lbPairPubkey.toBytes()],
    dlmmProgramId
  );
  return pda;
}

/** Compute bin array index from bin ID (matches Meteora SDK binIdToBinArrayIndex) */
export function binIdToBinArrayIndex(binId) {
  return Math.floor(binId / 70);
}

/**
 * Build Meteora initializeBinArray instruction.
 * Discriminator from IDL: [35, 86, 19, 185, 78, 212, 75, 211]
 */
export function buildInitBinArrayIx(lbPairPubkey, binArrayPDA, funderPubkey, arrayIndex, dlmmProgramId) {
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

// --- Meteora DLMM program constant (line 1718) ---

export const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
