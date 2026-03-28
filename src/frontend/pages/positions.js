import { state } from '../state.js';
import { CONFIG, getPositionPDA, getVaultPDA, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, SPL_MEMO_PROGRAM_ID, getConfigPDA, getRoverAuthorityPDA } from '../constants.js';
import { binToPrice, formatPrice, formatAge, getFillPercent, escapeHtml, showToast, calculateFee, timeAgo } from '../helpers.js';
import { kitIxToWeb3, asSigner, walletSendTransaction, confirmAndCheck, toEncodedAccount, makeComputeUnitPriceIx, DEFAULT_PRIORITY_MICROLAMPORTS, ensureAccountsSetup, getPoolALT, preSimulateVersioned } from '../wallet.js';
import { relayFetch } from '../relay.js';
import { getMintDecimals, decodePosition, BIN_FARM_PROGRAM_ADDRESS, getUserCloseInstructionAsync, getClaimFeesInstruction, getHarvestBinsInstructionAsync, resolveMeteoraCPIAccounts, Side } from '../instructions.js';
import { showPnlModal } from '../shared/pnl-card.js';
import { parseLbPair, parseLbPairFull, resolveTokenSymbol } from './trade.js';
import { loadBinVizData } from '../shared/bin-viz.js';
import { renderOpsStats, renderBountyBoard } from './ops.js';

import { address } from '@solana/kit';

// ============================================================
// FETCH USER POSITIONS
// ============================================================

export async function fetchUserPositions(poolAddress) {
  if (!state.connected || !state.publicKey) return [];
  const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;
  const conn = state.connection || new solanaWeb3.Connection(rpcUrl, 'confirmed');
  const programId = new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID);

  try {
    const accounts = await conn.getProgramAccounts(programId, {
      filters: [
        { dataSize: 138 }, // Position::SIZE = 8+32+32+32+1+4+4+8+8+8+1 = 138
        { memcmp: { offset: 8, bytes: state.publicKey.toBase58() } },
        { memcmp: { offset: 40, bytes: poolAddress } },
      ],
    });

    return accounts.map(({ pubkey, account }) => {
      const pos = decodePosition(toEncodedAccount(pubkey, account.data, BIN_FARM_PROGRAM_ADDRESS)).data;
      return {
        pubkey,
        meteoraPosition: new solanaWeb3.PublicKey(pos.meteoraPosition),
        side: pos.side === Side.Buy ? 'buy' : 'sell',
        minBinId: pos.minBinId,
        maxBinId: pos.maxBinId,
        initialAmount: Number(pos.initialAmount),
        harvestedAmount: Number(pos.harvestedAmount),
      };
    });
  } catch (err) {
    if (CONFIG.DEBUG) console.error('Failed to fetch user positions:', err);
    return [];
  }
}

export async function fetchAllUserPositions() {
  if (!state.connected || !state.publicKey) return [];
  const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;
  const conn = state.connection || new solanaWeb3.Connection(rpcUrl, 'confirmed');
  const programId = new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID);

  try {
    const accounts = await conn.getProgramAccounts(programId, {
      filters: [
        { dataSize: 138 },
        { memcmp: { offset: 8, bytes: state.publicKey.toBase58() } },
      ],
    });

    return accounts.map(({ pubkey, account }) => {
      const pos = decodePosition(toEncodedAccount(pubkey, account.data, BIN_FARM_PROGRAM_ADDRESS)).data;
      return {
        pubkey,
        lbPair: pos.lbPair,
        meteoraPosition: new solanaWeb3.PublicKey(pos.meteoraPosition),
        side: pos.side === Side.Buy ? 'buy' : 'sell',
        minBinId: pos.minBinId,
        maxBinId: pos.maxBinId,
        initialAmount: Number(pos.initialAmount),
        harvestedAmount: Number(pos.harvestedAmount),
        createdAt: Number(pos.createdAt),
      };
    });
  } catch (err) {
    if (CONFIG.DEBUG) console.error('Failed to fetch all positions:', err);
    return [];
  }
}

// ============================================================
// RENDER POSITIONS PAGE (full-page positions view)
// ============================================================

export async function renderPositionsPage() {
  const listEl = document.getElementById('allPositionsList');
  const countEl = document.getElementById('posPageCount');
  const depositEl = document.getElementById('posPageDeposited');
  const harvestEl = document.getElementById('posPageHarvested');
  if (!listEl) return;

  if (!state.connected) {
    listEl.innerHTML = '<div class="empty-state">connect wallet to view positions</div>';
    return;
  }

  listEl.innerHTML = '<div class="empty-state">loading...</div>';
  let positions;
  try {
    positions = await fetchAllUserPositions();
  } catch (err) {
    console.error('[monke] Failed to load positions:', err);
    listEl.innerHTML = '<div class="empty-state">failed to load positions — RPC may be unavailable</div>';
    return;
  }

  if (positions.length === 0) {
    listEl.innerHTML = '<div class="empty-state">no positions</div>';
    if (countEl) countEl.textContent = '0';
    if (depositEl) depositEl.textContent = '0 SOL';
    if (harvestEl) harvestEl.textContent = '0 SOL';
    return;
  }

  let totalDeposited = 0;
  let totalHarvested = 0;

  const uniquePools = [...new Set(positions.map(p => p.lbPair))];
  const poolMeta = {};
  for (const pool of uniquePools) {
    try {
      const info = await parseLbPair(pool);
      const [symX, symY, decX, decY] = await Promise.all([
        resolveTokenSymbol(info.tokenXMint),
        resolveTokenSymbol(info.tokenYMint),
        getMintDecimals(info.tokenXMint.toBase58()),
        getMintDecimals(info.tokenYMint.toBase58()),
      ]);
      poolMeta[pool] = {
        name: `${symX}/${symY}`,
        binStep: info.binStep,
        decimalsX: decX,
        decimalsY: decY,
      };
    } catch {
      poolMeta[pool] = {
        name: pool.slice(0, 4) + '...' + pool.slice(-4),
        binStep: 0, decimalsX: 9, decimalsY: 9,
      };
    }
  }

  let html = '';
  for (const pos of positions) {
    totalDeposited += pos.initialAmount;
    totalHarvested += pos.harvestedAmount;
    const fillPct = pos.initialAmount > 0 ? Math.min(100, Math.round((pos.harvestedAmount / pos.initialAmount) * 100)) : 0;
    const meta = poolMeta[pos.lbPair] || { name: pos.lbPair.slice(0, 8) + '...', binStep: 0 };
    const poolName = meta.name;
    const status = fillPct >= 100 ? 'harvested' : 'active';
    const minPrice = meta.binStep ? formatPrice(binToPrice(pos.minBinId, meta.binStep, meta.decimalsX, meta.decimalsY)) : pos.minBinId;
    const maxPrice = meta.binStep ? formatPrice(binToPrice(pos.maxBinId, meta.binStep, meta.decimalsX, meta.decimalsY)) : pos.maxBinId;

    const age = pos.createdAt ? formatAge(pos.createdAt) : '';
    const harvested = (pos.harvestedAmount / 1e9).toFixed(4);
    html += `<div class="pos-page-row">
      <span class="pos-pool">${escapeHtml(poolName)}</span>
      <span class="pos-side ${pos.side}">${pos.side}</span>
      <span class="pos-range">${minPrice} → ${maxPrice}</span>
      <span class="pos-filled">${fillPct}%<div class="pos-fill-bar"><div class="pos-fill-bar-inner ${pos.side}" style="width:${fillPct}%"></div></div><span class="pos-harvested-amt">${harvested}</span></span>
      <span class="pos-amount">${(pos.initialAmount / 1e9).toFixed(4)}</span>
      <span class="pos-age">${age}</span>
      <span class="pos-status ${status}">${status}</span>
      <button class="claim-fees-btn action-btn-sm" data-pubkey="${pos.pubkey.toBase58()}" data-lbpair="${pos.lbPair}" data-metpos="${pos.meteoraPosition.toBase58()}" data-min="${pos.minBinId}" data-max="${pos.maxBinId}">fees</button>
      <button class="close-btn" data-pubkey="${pos.pubkey.toBase58()}" data-lbpair="${pos.lbPair}" data-metpos="${pos.meteoraPosition.toBase58()}" data-min="${pos.minBinId}" data-max="${pos.maxBinId}">close</button>
      <button class="history-btn action-btn-sm" data-metpos="${pos.meteoraPosition.toBase58()}">history</button>
    </div>`;
  }

  listEl.innerHTML = html;
  if (countEl) countEl.textContent = positions.length;
  if (depositEl) depositEl.textContent = (totalDeposited / 1e9).toFixed(4) + ' SOL';
  if (harvestEl) harvestEl.textContent = (totalHarvested / 1e9).toFixed(4) + ' SOL';

  listEl.querySelectorAll('.close-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pubkey = new solanaWeb3.PublicKey(btn.dataset.pubkey);
      const meteoraPosition = new solanaWeb3.PublicKey(btn.dataset.metpos);
      const lbPair = btn.dataset.lbpair;
      const minBin = parseInt(btn.dataset.min);
      const maxBin = parseInt(btn.dataset.max);
      btn.textContent = 'closing...'; btn.disabled = true;
      try {
        const pos = { pubkey, meteoraPosition, poolAddress: lbPair, minBin, maxBin };
        await closePositionDirect(pos);
        showToast('Position closed', 'success');
        renderPositionsPage();
      } catch (err) {
        console.error('Close failed:', err);
        showToast('Close failed: ' + (err?.message || err), 'error');
        btn.textContent = 'close'; btn.disabled = false;
      }
    });
  });

  listEl.querySelectorAll('.claim-fees-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pubkey = new solanaWeb3.PublicKey(btn.dataset.pubkey);
      const meteoraPosition = new solanaWeb3.PublicKey(btn.dataset.metpos);
      const lbPair = btn.dataset.lbpair;
      const minBin = parseInt(btn.dataset.min);
      const maxBin = parseInt(btn.dataset.max);
      btn.textContent = 'claiming...'; btn.disabled = true;
      try {
        const pos = { pubkey, meteoraPosition, poolAddress: lbPair, minBin, maxBin };
        await claimFeesDirect(pos);
        showToast('Fees claimed', 'success');
        renderPositionsPage();
      } catch (err) {
        console.error('Claim fees failed:', err);
        showToast('Claim fees failed: ' + (err?.message || err), 'error');
        btn.textContent = 'fees'; btn.disabled = false;
      }
    });
  });

  listEl.querySelectorAll('.history-btn').forEach(btn => {
    btn.addEventListener('click', () => showPositionHistory(btn.dataset.metpos));
  });
}

// ============================================================
// POSITIONS LIST (sidebar/inline view)
// ============================================================

export async function refreshPositionsList() {
  if (!state.connected || !state.poolAddress) return;
  try {
    const positions = await fetchUserPositions(state.poolAddress);
    state.positions = positions.map(p => {
      const decimals = p.side === 'sell' ? state.tokenXDecimals : state.tokenYDecimals;
      const fillPct = p.initialAmount > 0 ? Math.min(100, Math.round((p.harvestedAmount / p.initialAmount) * 100)) : 0;
      return {
        pubkey: p.pubkey,
        meteoraPosition: p.meteoraPosition,
        pool: `${state.tokenXSymbol}/${state.tokenYSymbol}`,
        poolAddress: state.poolAddress,
        side: p.side,
        minBin: p.minBinId,
        maxBin: p.maxBinId,
        minPrice: binToPrice(p.minBinId, state.binStep, state.tokenXDecimals, state.tokenYDecimals),
        maxPrice: binToPrice(p.maxBinId, state.binStep, state.tokenXDecimals, state.tokenYDecimals),
        filled: fillPct,
        amount: p.initialAmount / Math.pow(10, decimals),
        initialAmount: p.initialAmount,
        lpFees: 0,
      };
    });
  } catch (err) {
    if (CONFIG.DEBUG) console.error('Failed to refresh positions:', err);
  }
  updatePositionsList();
}

export function updatePositionsList() {
  const container = document.getElementById('positionsList');
  if (!container) return;

  if (!state.connected) {
    container.innerHTML = '<div class="empty-state">connect wallet to view positions</div>';
    return;
  }

  if (state.positions.length === 0) {
    container.innerHTML = '<div class="empty-state">no positions yet</div>';
    return;
  }

  container.innerHTML = state.positions.map((p, i) => `
    <div class="position-row">
      <span>${escapeHtml(p.pool)}</span>
      <span class="position-side ${escapeHtml(p.side)}">${escapeHtml(p.side)}</span>
      <span>${typeof p.filled === 'number' ? p.filled : 0}%</span>
      <button class="close-btn" data-idx="${i}">close</button>
      <button class="action-btn-sm share-btn" data-idx="${i}">share</button>
    </div>
  `).join('');

  container.querySelectorAll('.close-btn').forEach(btn => {
    btn.addEventListener('click', () => closePosition(parseInt(btn.dataset.idx)));
  });
  container.querySelectorAll('.share-btn').forEach(btn => {
    btn.addEventListener('click', () => showPnlModal(parseInt(btn.dataset.idx)));
  });
}

// ============================================================
// CLOSE POSITION
// ============================================================

export async function closePosition(index) {
  const pos = state.positions[index];
  if (!pos) { showToast('Position not found', 'error'); return; }
  if (!pos.pubkey || !pos.meteoraPosition) {
    showToast('Missing position data — reload page', 'error');
    return;
  }

  const closeBtn = document.querySelectorAll('.close-btn')[index];
  if (closeBtn) { closeBtn.textContent = 'closing...'; closeBtn.disabled = true; }

  try {
    showToast('Building close transaction...', 'info');

    const conn = state.connection;
    const user = state.publicKey;
    const coreProgramId = new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID);

    const poolAddr = pos.poolAddress || state.poolAddress;
    const cpi = await resolveMeteoraCPIAccounts(poolAddr, pos.minBin, pos.maxBin);

    const [configPDA] = getConfigPDA();
    const [positionPDA] = getPositionPDA(pos.meteoraPosition);
    const [vaultPDA] = getVaultPDA(pos.meteoraPosition);
    const [roverAuthorityPDA] = getRoverAuthorityPDA();

    const vaultTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, vaultPDA, true, cpi.tokenXProgramId);
    const vaultTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, vaultPDA, true, cpi.tokenYProgramId);
    const userTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, user, false, cpi.tokenXProgramId);
    const userTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, user, false, cpi.tokenYProgramId);
    const roverFeeTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, roverAuthorityPDA, true, cpi.tokenXProgramId);
    const roverFeeTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, roverAuthorityPDA, true, cpi.tokenYProgramId);

    // --- Setup TX: ensure all ATAs exist (standard SPL ops only) ---
    await ensureAccountsSetup(conn, user, [
      { ata: userTokenX, owner: user, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
      { ata: userTokenY, owner: user, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
      { ata: roverFeeTokenX, owner: roverAuthorityPDA, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
      { ata: roverFeeTokenY, owner: roverAuthorityPDA, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
    ]);

    // --- Execute TX: compute budget + userClose only ---
    const closeIx = await getUserCloseInstructionAsync({
      user: asSigner(user),
      position: address(pos.pubkey.toBase58()),
      vault: address(vaultPDA.toBase58()),
      meteoraPosition: address(pos.meteoraPosition.toBase58()),
      lbPair: address(cpi.lbPair.toBase58()),
      binArrayBitmapExt: address(cpi.binArrayBitmapExt.toBase58()),
      binArrayLower: address(cpi.binArrayLower.toBase58()),
      binArrayUpper: address(cpi.binArrayUpper.toBase58()),
      reserveX: address(cpi.reserveX.toBase58()),
      reserveY: address(cpi.reserveY.toBase58()),
      tokenXMint: address(cpi.tokenXMint.toBase58()),
      tokenYMint: address(cpi.tokenYMint.toBase58()),
      eventAuthority: address(cpi.eventAuthority.toBase58()),
      dlmmProgram: address(cpi.dlmmProgram.toBase58()),
      vaultTokenX: address(vaultTokenX.toBase58()),
      vaultTokenY: address(vaultTokenY.toBase58()),
      userTokenX: address(userTokenX.toBase58()),
      userTokenY: address(userTokenY.toBase58()),
      roverFeeTokenX: address(roverFeeTokenX.toBase58()),
      roverFeeTokenY: address(roverFeeTokenY.toBase58()),
      tokenXProgram: address(cpi.tokenXProgramId.toBase58()),
      tokenYProgram: address(cpi.tokenYProgramId.toBase58()),
      memoProgram: address(SPL_MEMO_PROGRAM_ID.toBase58()),
    });
    const closeWeb3Ix = kitIxToWeb3(closeIx);
    const bmExtWritable = !cpi.binArrayBitmapExt.equals(cpi.dlmmProgram);
    if (bmExtWritable) {
      const bmIdx = closeWeb3Ix.keys.findIndex(k => k.pubkey.equals(cpi.binArrayBitmapExt));
      if (bmIdx >= 0) closeWeb3Ix.keys[bmIdx].isWritable = true;
    }

    const altAccount = await getPoolALT();
    const ixs = [
      solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS),
      closeWeb3Ix,
    ];
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const messageV0 = new solanaWeb3.TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message([altAccount]);
    const vtx = new solanaWeb3.VersionedTransaction(messageV0);

    await preSimulateVersioned(vtx);
    showToast('Approve in wallet...', 'info');
    const result = await phantomSDK.solana.signAndSendTransaction(vtx);
    const sig = result?.signature || result?.hash || (typeof result === 'string' ? result : undefined);
    if (!sig) throw new Error('Wallet returned no transaction signature');
    showToast('Confirming...', 'info');
    await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);

    showToast('Position closed', 'success');
    if (CONFIG.DEBUG) console.log(`[monke] Close tx: ${sig}`);

    await refreshPositionsList();
    loadBinVizData();
  } catch (err) {
    console.error('Close failed:', err);
    showToast('Close failed: ' + (err?.message || err), 'error');
  } finally {
    if (closeBtn) { closeBtn.textContent = 'close'; closeBtn.disabled = false; }
  }
}

/** Close a position by direct data (used by positions page). */
export async function closePositionDirect(pos) {
  if (!state.connected) throw new Error('Connect wallet first');
  const conn = state.connection;
  const user = state.publicKey;

  const cpi = await resolveMeteoraCPIAccounts(pos.poolAddress, pos.minBin, pos.maxBin);

  const [positionPDA] = getPositionPDA(pos.meteoraPosition);
  const [vaultPDA] = getVaultPDA(pos.meteoraPosition);
  const [roverAuthorityPDA] = getRoverAuthorityPDA();

  const vaultTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, vaultPDA, true, cpi.tokenXProgramId);
  const vaultTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, vaultPDA, true, cpi.tokenYProgramId);
  const userTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, user, false, cpi.tokenXProgramId);
  const userTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, user, false, cpi.tokenYProgramId);
  const roverFeeTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, roverAuthorityPDA, true, cpi.tokenXProgramId);
  const roverFeeTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, roverAuthorityPDA, true, cpi.tokenYProgramId);

  // --- Setup TX: ensure all ATAs exist (standard SPL ops only) ---
  await ensureAccountsSetup(conn, user, [
    { ata: userTokenX, owner: user, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
    { ata: userTokenY, owner: user, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
    { ata: roverFeeTokenX, owner: roverAuthorityPDA, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
    { ata: roverFeeTokenY, owner: roverAuthorityPDA, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
  ]);

  // --- Execute TX: compute budget + userClose only ---
  const closeIx = await getUserCloseInstructionAsync({
    user: asSigner(user),
    position: address(pos.pubkey.toBase58()),
    vault: address(vaultPDA.toBase58()),
    meteoraPosition: address(pos.meteoraPosition.toBase58()),
    lbPair: address(cpi.lbPair.toBase58()),
    binArrayBitmapExt: address(cpi.binArrayBitmapExt.toBase58()),
    binArrayLower: address(cpi.binArrayLower.toBase58()),
    binArrayUpper: address(cpi.binArrayUpper.toBase58()),
    reserveX: address(cpi.reserveX.toBase58()),
    reserveY: address(cpi.reserveY.toBase58()),
    tokenXMint: address(cpi.tokenXMint.toBase58()),
    tokenYMint: address(cpi.tokenYMint.toBase58()),
    eventAuthority: address(cpi.eventAuthority.toBase58()),
    dlmmProgram: address(cpi.dlmmProgram.toBase58()),
    vaultTokenX: address(vaultTokenX.toBase58()),
    vaultTokenY: address(vaultTokenY.toBase58()),
    userTokenX: address(userTokenX.toBase58()),
    userTokenY: address(userTokenY.toBase58()),
    roverFeeTokenX: address(roverFeeTokenX.toBase58()),
    roverFeeTokenY: address(roverFeeTokenY.toBase58()),
    tokenXProgram: address(cpi.tokenXProgramId.toBase58()),
    tokenYProgram: address(cpi.tokenYProgramId.toBase58()),
    memoProgram: address(SPL_MEMO_PROGRAM_ID.toBase58()),
  });
  const ucWeb3Ix = kitIxToWeb3(closeIx);
  const ucBmWritable = !cpi.binArrayBitmapExt.equals(cpi.dlmmProgram);
  if (ucBmWritable) {
    const bmIdx = ucWeb3Ix.keys.findIndex(k => k.pubkey.equals(cpi.binArrayBitmapExt));
    if (bmIdx >= 0) ucWeb3Ix.keys[bmIdx].isWritable = true;
  }

  const altAccount = await getPoolALT();
  const ixs = [
    solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS),
    ucWeb3Ix,
  ];
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const messageV0 = new solanaWeb3.TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message([altAccount]);
  const vtx = new solanaWeb3.VersionedTransaction(messageV0);

  await preSimulateVersioned(vtx);
  showToast('Approve in wallet...', 'info');
  const result = await phantomSDK.solana.signAndSendTransaction(vtx);
  const sig = result?.signature || result?.hash || (typeof result === 'string' ? result : undefined);
  if (!sig) throw new Error('Wallet returned no transaction signature');
  showToast('Confirming...', 'info');
  await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);
  if (CONFIG.DEBUG) console.log(`[monke] Close tx: ${sig}`);
}

export async function claimFeesDirect(pos) {
  if (!state.connected) throw new Error('Connect wallet first');
  const conn = state.connection;
  const user = state.publicKey;

  const cpi = await resolveMeteoraCPIAccounts(pos.poolAddress, pos.minBin, pos.maxBin);

  const [positionPDA] = getPositionPDA(pos.meteoraPosition);
  const [vaultPDA] = getVaultPDA(pos.meteoraPosition);

  const vaultTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, vaultPDA, true, cpi.tokenXProgramId);
  const vaultTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, vaultPDA, true, cpi.tokenYProgramId);
  const userTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, user, false, cpi.tokenXProgramId);
  const userTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, user, false, cpi.tokenYProgramId);

  // --- Setup TX: ensure user ATAs exist (standard SPL ops only) ---
  await ensureAccountsSetup(conn, user, [
    { ata: userTokenX, owner: user, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
    { ata: userTokenY, owner: user, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
  ]);

  // --- Execute TX: compute budget + claimFees only ---
  const claimFeesIx = getClaimFeesInstruction({
    user: asSigner(user),
    position: address(positionPDA.toBase58()),
    vault: address(vaultPDA.toBase58()),
    meteoraPosition: address(pos.meteoraPosition.toBase58()),
    lbPair: address(cpi.lbPair.toBase58()),
    binArrayLower: address(cpi.binArrayLower.toBase58()),
    binArrayUpper: address(cpi.binArrayUpper.toBase58()),
    reserveX: address(cpi.reserveX.toBase58()),
    reserveY: address(cpi.reserveY.toBase58()),
    tokenXMint: address(cpi.tokenXMint.toBase58()),
    tokenYMint: address(cpi.tokenYMint.toBase58()),
    eventAuthority: address(cpi.eventAuthority.toBase58()),
    dlmmProgram: address(cpi.dlmmProgram.toBase58()),
    vaultTokenX: address(vaultTokenX.toBase58()),
    vaultTokenY: address(vaultTokenY.toBase58()),
    userTokenX: address(userTokenX.toBase58()),
    userTokenY: address(userTokenY.toBase58()),
    tokenXProgram: address(cpi.tokenXProgramId.toBase58()),
    tokenYProgram: address(cpi.tokenYProgramId.toBase58()),
    memoProgram: address(SPL_MEMO_PROGRAM_ID.toBase58()),
  });
  const tx = new solanaWeb3.Transaction();
  tx.add(solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
  tx.add(makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS));
  tx.add(kitIxToWeb3(claimFeesIx));

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = user;

  showToast('Approve in wallet...', 'info');
  const sig = await walletSendTransaction(tx);
  showToast('Confirming fee claim...', 'info');
  await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);
  if (CONFIG.DEBUG) console.log(`[monke] Claim fees tx: ${sig}`);
}

// ============================================================
// POSITION HISTORY MODAL — events from DataPI
// ============================================================

const METEORA_API_BASE_FN = () => CONFIG.METEORA_API_URL || 'https://dlmm.datapi.meteora.ag';

export async function showPositionHistory(meteoraPositionAddress) {
  const modal = document.getElementById('positionHistoryModal');
  const eventsEl = document.getElementById('historyEvents');
  if (!modal || !eventsEl) return;

  eventsEl.innerHTML = '<div class="empty-state">loading...</div>';
  modal.classList.add('visible');
  document.body.classList.add('modal-open'); document.documentElement.classList.add('modal-open');

  let data = null;
  try {
    const relayData = await relayFetch(`/api/position-history/${meteoraPositionAddress}`);
    if (relayData?.events) data = relayData;
  } catch {}

  if (!data) {
    try {
      const resp = await fetch(
        `${METEORA_API_BASE_FN()}/positions/${meteoraPositionAddress}/historical?order_direction=desc`
      );
      if (resp.ok) data = await resp.json();
    } catch {}
  }

  if (!data?.events?.length) {
    eventsEl.innerHTML = '<div class="empty-state">no events found</div>';
    return;
  }

  eventsEl.innerHTML = data.events.map(evt => {
    const ts = evt.blockTime ? new Date(evt.blockTime * 1000) : null;
    const timeStr = ts ? timeAgo(evt.blockTime) : '—';
    const usd = parseFloat(evt.totalUsd) || 0;
    const sig = evt.signature || '';
    const shortSig = sig ? sig.slice(0, 6) + '...' : '';
    return `<div class="history-event-row">
      <span class="history-event-type ${escapeHtml(evt.eventType)}">${escapeHtml(evt.eventType)}</span>
      <span class="history-event-amounts">
        <span class="history-event-usd">$${usd.toFixed(2)}</span>
      </span>
      <span class="history-event-time">${escapeHtml(timeStr)}</span>
      <span class="history-event-tx">${sig ? `<a href="https://solscan.io/tx/${encodeURIComponent(sig)}" target="_blank" rel="noopener">${escapeHtml(shortSig)}</a>` : '—'}</span>
    </div>`;
  }).join('');
}

// ============================================================
// HARVEST
// ============================================================

export async function handleHarvestPosition(positionPDAStr, lbPairStr, ownerStr, side) {
  if (!state.connected) throw new Error('Connect wallet first');
  const conn = state.connection;
  const user = state.publicKey;

  const positionPubkey = new solanaWeb3.PublicKey(positionPDAStr);
  const posInfo = await conn.getAccountInfo(positionPubkey);
  if (!posInfo) throw new Error('Position not found');
  const posDecoded = decodePosition(toEncodedAccount(positionPubkey, posInfo.data, BIN_FARM_PROGRAM_ADDRESS)).data;
  const meteoraPosition = new solanaWeb3.PublicKey(posDecoded.meteoraPosition);
  const minBinId = posDecoded.minBinId;
  const maxBinId = posDecoded.maxBinId;
  const owner = new solanaWeb3.PublicKey(ownerStr);

  const cpi = await resolveMeteoraCPIAccounts(lbPairStr, minBinId, maxBinId);

  // Compute safe bin_ids from active_id
  const lbPairPubkey = new solanaWeb3.PublicKey(lbPairStr);
  const lbPairInfo = await conn.getAccountInfo(lbPairPubkey);
  const lbData = new Uint8Array(lbPairInfo.data);
  const lbView = new DataView(lbData.buffer, lbData.byteOffset);
  const activeId = lbView.getInt32(76, true);

  const binIds = [];
  const sideEnum = side === 'Sell' || side === 'sell' ? 1 : 0;
  for (let b = minBinId; b <= maxBinId; b++) {
    if (sideEnum === 1 && b < activeId) binIds.push(b);
    else if (sideEnum === 0 && b > activeId) binIds.push(b);
  }
  if (binIds.length === 0) throw new Error('No safe bins to harvest');
  if (binIds.length > 40) binIds.length = 40;

  const [vaultPDA] = getVaultPDA(meteoraPosition);
  const [roverAuthorityPDA] = getRoverAuthorityPDA();

  const vaultTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, vaultPDA, true, cpi.tokenXProgramId);
  const vaultTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, vaultPDA, true, cpi.tokenYProgramId);
  const ownerTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, owner, false, cpi.tokenXProgramId);
  const ownerTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, owner, false, cpi.tokenYProgramId);
  const roverFeeTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, roverAuthorityPDA, true, cpi.tokenXProgramId);
  const roverFeeTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, roverAuthorityPDA, true, cpi.tokenYProgramId);

  // --- Setup TX: ensure all ATAs exist (standard SPL ops only) ---
  await ensureAccountsSetup(conn, user, [
    { ata: ownerTokenX, owner: owner, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
    { ata: ownerTokenY, owner: owner, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
    { ata: roverFeeTokenX, owner: roverAuthorityPDA, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
    { ata: roverFeeTokenY, owner: roverAuthorityPDA, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
  ]);

  // --- Execute TX: compute budget + harvestBins only ---
  const harvestIx = await getHarvestBinsInstructionAsync({
    bot: asSigner(user),
    position: address(positionPubkey.toBase58()),
    vault: address(vaultPDA.toBase58()),
    owner: address(owner.toBase58()),
    meteoraPosition: address(meteoraPosition.toBase58()),
    lbPair: address(cpi.lbPair.toBase58()),
    binArrayBitmapExt: address(cpi.binArrayBitmapExt.toBase58()),
    binArrayLower: address(cpi.binArrayLower.toBase58()),
    binArrayUpper: address(cpi.binArrayUpper.toBase58()),
    reserveX: address(cpi.reserveX.toBase58()),
    reserveY: address(cpi.reserveY.toBase58()),
    tokenXMint: address(cpi.tokenXMint.toBase58()),
    tokenYMint: address(cpi.tokenYMint.toBase58()),
    eventAuthority: address(cpi.eventAuthority.toBase58()),
    dlmmProgram: address(cpi.dlmmProgram.toBase58()),
    vaultTokenX: address(vaultTokenX.toBase58()),
    vaultTokenY: address(vaultTokenY.toBase58()),
    ownerTokenX: address(ownerTokenX.toBase58()),
    ownerTokenY: address(ownerTokenY.toBase58()),
    roverFeeTokenX: address(roverFeeTokenX.toBase58()),
    roverFeeTokenY: address(roverFeeTokenY.toBase58()),
    tokenXProgram: address(cpi.tokenXProgramId.toBase58()),
    tokenYProgram: address(cpi.tokenYProgramId.toBase58()),
    memoProgram: address(SPL_MEMO_PROGRAM_ID.toBase58()),
    binIds: binIds,
  });
  const harvestWeb3Ix = kitIxToWeb3(harvestIx);
  const hvBmWritable = !cpi.binArrayBitmapExt.equals(cpi.dlmmProgram);
  if (hvBmWritable) {
    const bmIdx = harvestWeb3Ix.keys.findIndex(k => k.pubkey.equals(cpi.binArrayBitmapExt));
    if (bmIdx >= 0) harvestWeb3Ix.keys[bmIdx].isWritable = true;
  }
  const tx = new solanaWeb3.Transaction();
  tx.add(solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS));
  tx.add(harvestWeb3Ix);

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = user;

  showToast('Approve harvest...', 'info');
  const sig = await walletSendTransaction(tx);
  showToast('Confirming harvest...', 'info');
  await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);
}

export async function handleHarvestAll() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  try {
    const data = await relayFetch('/api/pending-harvests');
    if (!data || !data.pending || data.pending.length === 0) { showToast('Nothing to harvest', 'info'); return; }
    for (const p of data.pending) {
      await handleHarvestPosition(p.positionPDA, p.lbPair, p.owner, p.side);
    }
    showToast(`Harvested ${data.pending.length} position(s)!`, 'success');
    renderBountyBoard();
    renderOpsStats();
  } catch (err) {
    console.error('[monke] harvest_all failed:', err);
    showToast('Harvest all failed: ' + (err?.message || err), 'error');
  }
}

// renderBountyBoard / renderOpsStats are from the ops page — they're called
