import { state } from '../state.js';
import { CONFIG, getRoverAuthorityPDA, getDistPoolPDA, getProgramVaultPDA, getMonkeStatePDA, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, NATIVE_MINT } from '../constants.js';
import { formatAge, escapeHtml, showToast, timeAgo } from '../helpers.js';
import { kitIxToWeb3, asSigner, walletSendTransaction, confirmAndCheck, toEncodedAccount, makeComputeUnitPriceIx, DEFAULT_PRIORITY_MICROLAMPORTS } from '../wallet.js';
import { relayFetch, formatRelayEvent } from '../relay.js';
import { getSweepRoverInstructionAsync, getDepositPeggedInstructionAsync, getDepositSolInstructionAsync, getStakeAndForwardInstructionAsync, decodeConfig, BIN_FARM_PROGRAM_ADDRESS } from '../instructions.js';
import { address } from '@solana/kit';

export const SANCTUM_PROGRAM = new solanaWeb3.PublicKey('SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY');
export const STAKE_PROGRAM_ID = new solanaWeb3.PublicKey('Stake11111111111111111111111111111111111111');
export const SYSVAR_CLOCK = new solanaWeb3.PublicKey('SysvarC1ock11111111111111111111111111111111');
export const SYSVAR_STAKE_HISTORY = new solanaWeb3.PublicKey('SysvarStakeHistory1111111111111111111111111');

export async function handleRoverDeposit() {
  const mintAddress = document.getElementById('roverTokenMint')?.value.trim();
  const amount = parseFloat(document.getElementById('roverAmount')?.value);
  if (!mintAddress) { showToast('Enter a token mint address', 'error'); return; }
  if (!amount || amount <= 0) { showToast('Enter an amount', 'error'); return; }
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  showToast('Bribe deposit requires deployed programs', 'info');
}

// ============================================================
// OPS PAGE — activity feed + bounty board + permissionless crank
// ============================================================

export async function renderOpsStats() {
  const el = id => document.getElementById(id);
  try {
    const [stats, pending, botWallet] = await Promise.all([
      relayFetch('/api/stats'),
      relayFetch('/api/pending-harvests'),
      relayFetch('/api/bot-wallet'),
    ]);
    if (stats) {
      if (el('opsPositionCount')) el('opsPositionCount').textContent = stats.positionCount || 0;
      if (el('opsTotalHarvested')) el('opsTotalHarvested').textContent = (stats.totalHarvests || 0) + ' txs';
      if (el('opsTotalCloses')) el('opsTotalCloses').textContent = stats.totalCloses || 0;
      if (el('opsQueueDepth')) el('opsQueueDepth').textContent = (stats.queueDepth || 0) + (stats.inflightTxs ? ` (${stats.inflightTxs} inflight)` : '');
      if (el('opsBotStatus')) el('opsBotStatus').textContent = stats.grpcConnected ? 'connected' : 'offline';
    } else {
      if (el('opsBotStatus')) el('opsBotStatus').textContent = 'offline';
    }
    if (pending) {
      if (el('opsPendingCount')) el('opsPendingCount').textContent = pending.count || 0;
    }
    if (botWallet) {
      const balEl = el('opsBotBalance');
      if (balEl) {
        balEl.textContent = `(${botWallet.balanceSol?.toFixed(3)} SOL)`;
        balEl.className = 'stat-value-inline ' + (botWallet.status === 'critical' ? 'red' : botWallet.status === 'warning' ? 'yellow' : 'green');
        balEl.style.marginLeft = '4px';
        balEl.style.opacity = '0.6';
      }
    }
  } catch {
    if (el('opsBotStatus')) el('opsBotStatus').textContent = 'offline';
  }

  // Fee pipeline balances + conditional crank buttons
  const RENT_EXEMPT = 890880;
  try {
    if (state.connection) {
      const roverAuthority = getRoverAuthorityPDA()[0];
      const distPool = getDistPoolPDA()[0];

      const fetches = [
        state.connection.getBalance(roverAuthority),
        state.connection.getBalance(distPool),
      ];

      // Bridge vault balance for the stake button
      let bridgeVaultPk = null;
      if (CONFIG.BRIDGE_PROGRAM_ID) {
        const bridgeProgramId = new solanaWeb3.PublicKey(CONFIG.BRIDGE_PROGRAM_ID);
        [bridgeVaultPk] = solanaWeb3.PublicKey.findProgramAddressSync(
          [new TextEncoder().encode('bridge_vault')], bridgeProgramId
        );
        fetches.push(state.connection.getBalance(bridgeVaultPk));
      }

      const results = await Promise.all(fetches);
      const roverBal = results[0];
      const distBal = results[1];
      const bridgeVaultBal = results[2] ?? 0;

      const roverAvail = Math.max(0, roverBal - RENT_EXEMPT);
      const bridgeAvail = Math.max(0, bridgeVaultBal - RENT_EXEMPT);

      // Sweep button: enabled when rover_authority has SOL above rent
      if (el('opsSweepBalance')) el('opsSweepBalance').textContent = (roverAvail / 1e9).toFixed(4) + ' SOL';
      const sweepBtn = el('crankSweep');
      if (sweepBtn) sweepBtn.disabled = roverAvail <= 0;

      // Stake button: enabled when bridge_vault has SOL above rent
      if (el('opsStakeBalance')) el('opsStakeBalance').textContent = (bridgeAvail / 1e9).toFixed(4) + ' SOL';
      const stakeBtn = el('crankStakeForward');
      if (stakeBtn) stakeBtn.disabled = bridgeAvail <= 0;

      // Deposit button: enabled when dist_pool has $PEGGED > 0
      let peggedBal = 0;
      if (CONFIG.PEGGED_MINT) {
        try {
          const peggedMint = new solanaWeb3.PublicKey(CONFIG.PEGGED_MINT);
          const distPoolAta = getAssociatedTokenAddressSync(peggedMint, distPool, true);
          const info = await state.connection.getAccountInfo(distPoolAta);
          peggedBal = info && info.data.length >= 72 ? Number(info.data.readBigUInt64LE(64)) : 0;
          if (el('opsDepositBalance')) el('opsDepositBalance').textContent = (peggedBal / 1e9).toFixed(4) + ' $PEGGED';
        } catch {
          if (el('opsDepositBalance')) el('opsDepositBalance').textContent = (distBal / 1e9).toFixed(4) + ' SOL';
          peggedBal = Math.max(0, distBal - RENT_EXEMPT);
        }
      } else {
        if (el('opsDepositBalance')) el('opsDepositBalance').textContent = (distBal / 1e9).toFixed(4) + ' SOL';
        peggedBal = Math.max(0, distBal - RENT_EXEMPT);
      }
      const depositBtn = el('crankDeposit');
      if (depositBtn) depositBtn.disabled = peggedBal <= 0;
    }
  } catch {}
}

export async function renderBountyBoard() {
  const container = document.getElementById('bountyBoard');
  if (!container) return;

  try {
    const data = await relayFetch('/api/pending-harvests');
    if (!data || !data.pending || data.pending.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:16px;">no pending harvests</div>';
      return;
    }

    container.innerHTML = data.pending.map(p => `
      <div class="bounty-row">
        <span>${(p.lbPair || '').slice(0, 4)}...${(p.lbPair || '').slice(-4)}</span>
        <span>${p.safeBinCount} / ${p.totalBins}</span>
        <span>${p.side}</span>
        <span>${p.safeBinCount > 0 ? 'ready' : ''}</span>
        <button class="action-btn-sm harvest-btn" data-pda="${p.positionPDA}" data-lbpair="${p.lbPair}" data-owner="${p.owner}" data-side="${p.side}">harvest</button>
      </div>
    `).join('');

    container.querySelectorAll('.harvest-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.textContent = '...'; btn.disabled = true;
        handleHarvestPosition(btn.dataset.pda, btn.dataset.lbpair, btn.dataset.owner, btn.dataset.side)
          .then(() => { showToast('Harvested!', 'success'); renderBountyBoard(); renderOpsStats(); })
          .catch(err => { showToast('Harvest failed: ' + (err?.message || err), 'error'); btn.textContent = 'harvest'; btn.disabled = false; });
      });
    });
  } catch {
    container.innerHTML = '<div class="empty-state" style="padding:16px;">relay offline</div>';
  }
}

export function addFeedEvent(text, ts) {
  const feed = document.getElementById('activityFeed');
  if (!feed) return;
  const emptyState = feed.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const event = document.createElement('div');
  event.className = 'feed-event';
  const d = ts ? new Date(ts) : new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  event.innerHTML = `${escapeHtml(text)} <span class="event-time">${time}</span>`;
  feed.insertBefore(event, feed.firstChild);

  while (feed.children.length > 100) {
    feed.removeChild(feed.lastChild);
  }
}

export async function preloadFeed() {
  try {
    const data = await relayFetch('/api/feed');
    if (data?.events?.length) {
      const feed = document.getElementById('activityFeed');
      if (feed) feed.innerHTML = '';
      for (const evt of [...data.events].reverse()) {
        const text = evt.text || formatRelayEvent(evt);
        if (text.includes('rover TVL') && text.includes('$0')) continue;
        addFeedEvent(text, evt.timestamp);
      }
    }
  } catch {
    // Feed pre-load is best-effort
  }
}

export async function handleCrankSweep() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  const btn = document.getElementById('crankSweep');
  if (btn) btn.disabled = true;
  const conn = state.connection;
  const user = state.publicKey;

  try {
    const [distPoolPDA] = getDistPoolPDA();

    const [configPDA] = solanaWeb3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('config')],
      new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
    );
    const configInfo = await conn.getAccountInfo(configPDA);
    if (!configInfo) { showToast('Config account not found', 'error'); return; }
    const configDecoded = decodeConfig(toEncodedAccount(configPDA, configInfo.data, BIN_FARM_PROGRAM_ADDRESS));
    const botAddress = configDecoded.data.bot;

    const tx = new solanaWeb3.Transaction();
    tx.add(solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS));
    const sweepIx = await getSweepRoverInstructionAsync({
      caller: asSigner(user),
      revenueDest: address(distPoolPDA.toBase58()),
      botDest: botAddress,
    });
    tx.add(kitIxToWeb3(sweepIx));

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = user;

    showToast('Approve sweep...', 'info');
    const sig = await walletSendTransaction(tx);
    showToast('Confirming sweep...', 'info');
    await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);
    showToast('Swept SOL — 50% to bridge vault, 50% to bot!', 'success');
    renderOpsStats();
  } catch (err) {
    console.error('[monke] sweep_rover failed:', err);
    showToast('Sweep failed: ' + (err?.message || err), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * Read stake pool on-chain state and build epoch update instructions.
 * Returns { ixs, stakePoolPk, withdrawAuth, reserveStake, poolMintPk, managerFeeAcct, tokenProgramPk }
 */
export async function buildSanctumEpochUpdateIxs(conn) {
  const stakePoolPk = new solanaWeb3.PublicKey(CONFIG.STAKE_POOL);

  const stakePoolInfo = await conn.getAccountInfo(stakePoolPk);
  if (!stakePoolInfo || stakePoolInfo.data.length < 258) {
    throw new Error('Could not read stake pool state');
  }
  const spData = stakePoolInfo.data;
  const validatorListPk = new solanaWeb3.PublicKey(spData.subarray(98, 130));
  const reserveStake    = new solanaWeb3.PublicKey(spData.subarray(130, 162));
  const poolMintPk      = new solanaWeb3.PublicKey(spData.subarray(162, 194));
  const managerFeeAcct  = new solanaWeb3.PublicKey(spData.subarray(194, 226));
  const tokenProgramPk  = new solanaWeb3.PublicKey(spData.subarray(226, 258));

  const [withdrawAuth] = solanaWeb3.PublicKey.findProgramAddressSync(
    [stakePoolPk.toBytes(), new TextEncoder().encode('withdraw')], SANCTUM_PROGRAM
  );

  const vlInfo = await conn.getAccountInfo(validatorListPk);
  if (!vlInfo) throw new Error('Validator list not found');
  const vlData = vlInfo.data;
  const vlCount = new DataView(vlData.buffer, vlData.byteOffset).getUint32(5, true);

  const ENTRY_SIZE = 73;
  const ENTRIES_OFF = 9;
  const validatorStakeKeys = [];

  for (let i = 0; i < vlCount; i++) {
    const off = ENTRIES_OFF + i * ENTRY_SIZE;
    if (off + ENTRY_SIZE > vlData.length) break;

    const status = vlData[off + 40];
    if (status === 2) continue;
    const voteAccount = new solanaWeb3.PublicKey(vlData.subarray(off + 41, off + 73));
    if (voteAccount.equals(solanaWeb3.PublicKey.default)) continue;

    const validatorSeedSuffix = new DataView(vlData.buffer, vlData.byteOffset).getUint32(off + 36, true);
    const transientBuf = vlData.subarray(off + 24, off + 32);

    const valSeeds = [voteAccount.toBytes(), stakePoolPk.toBytes()];
    if (validatorSeedSuffix !== 0) {
      const sfx = new Uint8Array(4);
      new DataView(sfx.buffer).setUint32(0, validatorSeedSuffix, true);
      valSeeds.push(sfx);
    }
    const [valStake] = solanaWeb3.PublicKey.findProgramAddressSync(valSeeds, SANCTUM_PROGRAM);
    const [transStake] = solanaWeb3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('transient'), voteAccount.toBytes(), stakePoolPk.toBytes(), transientBuf],
      SANCTUM_PROGRAM
    );

    validatorStakeKeys.push({ pubkey: valStake, isSigner: false, isWritable: true });
    validatorStakeKeys.push({ pubkey: transStake, isSigner: false, isWritable: true });
  }

  const uvlbData = new Uint8Array(6);
  uvlbData[0] = 6;
  const uvlbIx = new solanaWeb3.TransactionInstruction({
    programId: SANCTUM_PROGRAM,
    keys: [
      { pubkey: stakePoolPk, isSigner: false, isWritable: false },
      { pubkey: withdrawAuth, isSigner: false, isWritable: false },
      { pubkey: validatorListPk, isSigner: false, isWritable: true },
      { pubkey: reserveStake, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_STAKE_HISTORY, isSigner: false, isWritable: false },
      { pubkey: STAKE_PROGRAM_ID, isSigner: false, isWritable: false },
      ...validatorStakeKeys,
    ],
    data: uvlbData,
  });

  const uspbIx = new solanaWeb3.TransactionInstruction({
    programId: SANCTUM_PROGRAM,
    keys: [
      { pubkey: stakePoolPk, isSigner: false, isWritable: true },
      { pubkey: withdrawAuth, isSigner: false, isWritable: false },
      { pubkey: validatorListPk, isSigner: false, isWritable: true },
      { pubkey: reserveStake, isSigner: false, isWritable: false },
      { pubkey: managerFeeAcct, isSigner: false, isWritable: true },
      { pubkey: poolMintPk, isSigner: false, isWritable: true },
      { pubkey: tokenProgramPk, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([7]),
  });

  return {
    ixs: [uvlbIx, uspbIx],
    stakePoolPk, withdrawAuth, reserveStake, poolMintPk, managerFeeAcct, tokenProgramPk,
  };
}

export async function handleCrankStakeForward() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  const btn = document.getElementById('crankStakeForward');
  if (btn) btn.disabled = true;
  const conn = state.connection;
  const user = state.publicKey;

  if (!CONFIG.BRIDGE_PROGRAM_ID || !CONFIG.STAKE_POOL || !CONFIG.PEGGED_MINT) {
    if (btn) btn.disabled = false;
    showToast('Bridge/stake pool not configured', 'error'); return;
  }

  try {
    const bridgeProgramId = new solanaWeb3.PublicKey(CONFIG.BRIDGE_PROGRAM_ID);
    const peggedMint = new solanaWeb3.PublicKey(CONFIG.PEGGED_MINT);

    showToast('Fetching stake pool state...', 'info');
    const epoch = await buildSanctumEpochUpdateIxs(conn);

    const [bridgeVaultPDA] = solanaWeb3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('bridge_vault')], bridgeProgramId
    );
    const bridgePeggedAta = getAssociatedTokenAddressSync(peggedMint, bridgeVaultPDA, true);

    const [distPoolPDA] = getDistPoolPDA();
    const distPoolPeggedAta = getAssociatedTokenAddressSync(peggedMint, distPoolPDA, true);

    const sfIx = await getStakeAndForwardInstructionAsync({
      crank: asSigner(user),
      bridgePeggedAta: address(bridgePeggedAta.toBase58()),
      distPoolPeggedAta: address(distPoolPeggedAta.toBase58()),
      peggedMint: address(peggedMint.toBase58()),
      stakePool: address(epoch.stakePoolPk.toBase58()),
      stakePoolWithdrawAuthority: address(epoch.withdrawAuth.toBase58()),
      reserveStake: address(epoch.reserveStake.toBase58()),
      managerFeeAccount: address(epoch.managerFeeAcct.toBase58()),
      stakePoolProgram: address(SANCTUM_PROGRAM.toBase58()),
    });

    const tx = new solanaWeb3.Transaction();
    tx.add(solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS));
    for (const ix of epoch.ixs) tx.add(ix);
    tx.add(kitIxToWeb3(sfIx));

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = user;

    showToast('Approve stake & forward...', 'info');
    const sig = await walletSendTransaction(tx);
    showToast('Confirming...', 'info');
    await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);
    showToast('SOL staked → $PEGGED forwarded to dist pool!', 'success');
    renderOpsStats();
  } catch (err) {
    console.error('[monke] stake_and_forward failed:', err);
    showToast('Stake & forward failed: ' + (err?.message || err), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function handleCrankDeposit() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  const btn = document.getElementById('crankDeposit');
  if (btn) btn.disabled = true;
  const conn = state.connection;
  const user = state.publicKey;
  const usePegged = !!CONFIG.PEGGED_MINT;

  try {
    const tx = new solanaWeb3.Transaction();
    tx.add(solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS));

    if (usePegged) {
      const peggedMint = new solanaWeb3.PublicKey(CONFIG.PEGGED_MINT);
      const [distPoolPDA] = getDistPoolPDA();
      const [programVaultPDA] = getProgramVaultPDA();
      const distPoolAta = getAssociatedTokenAddressSync(peggedMint, distPoolPDA, true);
      const programVaultAta = getAssociatedTokenAddressSync(peggedMint, programVaultPDA, true);
      const depositIx = await getDepositPeggedInstructionAsync({
        caller: asSigner(user),
        distPoolPeggedAta: address(distPoolAta.toBase58()),
        programVaultPeggedAta: address(programVaultAta.toBase58()),
      });
      tx.add(kitIxToWeb3(depositIx));
    } else {
      const depositIx = await getDepositSolInstructionAsync({
        caller: asSigner(user),
      });
      tx.add(kitIxToWeb3(depositIx));
    }

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = user;

    showToast('Approve deposit...', 'info');
    const sig = await walletSendTransaction(tx);
    showToast('Confirming deposit...', 'info');
    await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);
    showToast(usePegged ? '$PEGGED deposited to program vault!' : 'SOL deposited to program vault!', 'success');
    renderOpsStats();
  } catch (err) {
    console.error('[monke] deposit failed:', err);
    showToast('Deposit failed: ' + (err?.message || err), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}
