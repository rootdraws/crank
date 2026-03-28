// ============================================================
// wallet.js — Phantom Connect SDK, Codama adapters, wallet lifecycle
// Extracted from public/app.js (Phase 1 structural extraction)
// ============================================================

import { BrowserSDK, AddressType } from '@phantom/browser-sdk';
import { address } from '@solana/kit';
import { state } from './state.js';
import { CONFIG, createAssociatedTokenAccountIx } from './constants.js';
import { showToast } from './helpers.js';
import { decodeConfig, BIN_FARM_PROGRAM_ADDRESS } from '../../src/generated/bin-farm/index.js';
import { loadOnChainFeeBps } from './instructions.js';

// Page function imports (modules created in later phases)
import { updateFee } from './pages/trade.js';
import { renderPositionsPage, refreshPositionsList, updatePositionsList } from './pages/positions.js';
import { renderMonkeList, loadPeggedSection } from './plugins/rank-monke/index.js';
import { loadBinVizData, vizState } from './shared/bin-viz.js';

// ============================================================
// PHANTOM CONNECT SDK
// ============================================================

export const phantomSDK = new BrowserSDK({
  providers: ['injected'],
  addressTypes: [AddressType.solana],
  appId: '89b27865-826e-439c-93c3-80464b758b51',
});

// ============================================================
// CODAMA ADAPTERS — bridge @solana/kit types ↔ @solana/web3.js
// ============================================================

export const DEFAULT_PRIORITY_MICROLAMPORTS = 100_000;

/** Build SetComputeUnitPrice ix without Buffer (web3.js u64 path needs Buffer which browsers lack) */
export function makeComputeUnitPriceIx(microLamports) {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, BigInt(microLamports), true);
  return new solanaWeb3.TransactionInstruction({
    programId: new solanaWeb3.PublicKey('ComputeBudget111111111111111111111111111111'),
    keys: [],
    data,
  });
}

/** Convert @solana/kit Instruction -> @solana/web3.js TransactionInstruction */
export function kitIxToWeb3(ix) {
  return new solanaWeb3.TransactionInstruction({
    programId: new solanaWeb3.PublicKey(ix.programAddress),
    keys: ix.accounts.map(m => ({
      pubkey: new solanaWeb3.PublicKey(m.address),
      isSigner: (m.role & 2) !== 0,
      isWritable: (m.role & 1) !== 0,
    })),
    data: new Uint8Array(ix.data),
  });
}

/** Wrap a web3.js PublicKey as a @solana/kit TransactionSigner shim */
export function asSigner(pubkeyOrAddress) {
  const addr = typeof pubkeyOrAddress === 'string'
    ? pubkeyOrAddress : pubkeyOrAddress.toBase58();
  return {
    address: address(addr),
    signTransactions: async () => { throw new Error('use web3.js for signing'); },
  };
}

export async function preSimulate(tx) {
  const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const encoded = raw.toString('base64');
  const res = await fetch(state.connection.rpcEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: [encoded, { sigVerify: false, encoding: 'base64', commitment: 'confirmed' }],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error('Simulation RPC error: ' + JSON.stringify(json.error));
  const sim = json.result?.value;
  if (sim?.err) {
    console.error('[monke] pre-sim failed:', sim.err, sim.logs?.join('\n'));
    throw new Error('Transaction simulation failed: ' + JSON.stringify(sim.err));
  }
}

/** Sign + send via Phantom Connect SDK (single-signer). Pre-simulates first. */
export async function walletSendTransaction(tx) {
  await preSimulate(tx);
  const result = await phantomSDK.solana.signAndSendTransaction(tx);
  const sig = result?.signature || result?.hash || (typeof result === 'string' ? result : undefined);
  if (!sig) {
    console.warn('[monke] signAndSendTransaction result:', JSON.stringify(result));
    throw new Error('Wallet returned no transaction signature');
  }
  return sig;
}

/** Fetch and cache the pool Address Lookup Table for v0 transactions */
let _cachedALT = null;
export async function getPoolALT() {
  if (_cachedALT) return _cachedALT;
  const altPubkey = new solanaWeb3.PublicKey(CONFIG.POOL_ALT);
  const res = await state.connection.getAddressLookupTable(altPubkey);
  if (!res.value) throw new Error('ALT not found: ' + CONFIG.POOL_ALT);
  _cachedALT = res.value;
  return _cachedALT;
}

/** Pre-simulate a VersionedTransaction (base64-encoded, sigVerify: false) */
export async function preSimulateVersioned(vtx) {
  const encoded = btoa(String.fromCharCode(...vtx.serialize()));
  const res = await fetch(state.connection.rpcEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'simulateTransaction',
      params: [encoded, { sigVerify: false, encoding: 'base64', commitment: 'confirmed' }],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error('Simulation RPC error: ' + JSON.stringify(json.error));
  const sim = json.result?.value;
  if (sim?.err) {
    console.error('[monke] pre-sim (versioned) failed:', sim.err, sim.logs?.join('\n'));
    throw new Error('Transaction simulation failed: ' + JSON.stringify(sim.err));
  }
}

/** Confirm tx AND check for on-chain errors (confirmTransaction alone doesn't throw on program failures) */
export async function confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight) {
  const confirmation = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (confirmation.value.err) {
    const logs = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      .then(tx => tx?.meta?.logMessages || []).catch(() => []);
    const anchorErr = logs.find(l => l.includes('Error Number:') || l.includes('AnchorError') || l.includes('failed:'));
    console.error('[monke] tx failed on-chain:', confirmation.value.err, '\nLogs:', logs.join('\n'));
    throw new Error(anchorErr || 'Transaction failed on-chain: ' + JSON.stringify(confirmation.value.err));
  }
  return confirmation;
}

/**
 * Ensure required ATAs exist (and optionally init bin arrays / wrap SOL) in a
 * separate "setup" TX that contains ONLY standard SPL / System ops.
 *
 * Keeps the real execute TX down to compute-budget + one program instruction,
 * which dramatically reduces Blowfish per-transaction risk scoring.
 *
 * @param {Connection} conn
 * @param {PublicKey}   payer
 * @param {{ ata: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey }[]} ataChecks
 * @param {TransactionInstruction[]} [extraSetupIxs] - bin array inits, SOL wrapping, etc.
 * @returns {Promise<void>}
 */
export async function ensureAccountsSetup(conn, payer, ataChecks, extraSetupIxs = []) {
  const accounts = ataChecks.map(c => c.ata);
  const infos = await conn.getMultipleAccountsInfo(accounts);

  const setupIxs = [];
  for (let i = 0; i < ataChecks.length; i++) {
    if (!infos[i]) {
      const c = ataChecks[i];
      setupIxs.push(createAssociatedTokenAccountIx(payer, c.ata, c.owner, c.mint, c.tokenProgram));
    }
  }
  setupIxs.push(...extraSetupIxs);

  if (setupIxs.length === 0) return;

  const setupTx = new solanaWeb3.Transaction();
  setupTx.add(solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
  setupTx.add(makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS));
  for (const ix of setupIxs) setupTx.add(ix);

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  setupTx.recentBlockhash = blockhash;
  setupTx.lastValidBlockHeight = lastValidBlockHeight;
  setupTx.feePayer = payer;

  showToast('Preparing accounts...', 'info');
  const sig = await walletSendTransaction(setupTx);
  await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);
}

/** Wrap RPC account data as an EncodedAccount for Codama decoders */
export function toEncodedAccount(pubkeyOrStr, data, programAddr) {
  return {
    address: typeof pubkeyOrStr === 'string' ? pubkeyOrStr
      : pubkeyOrStr.toBase58 ? pubkeyOrStr.toBase58() : String(pubkeyOrStr),
    data: new Uint8Array(data),
    executable: false,
    lamports: 0n,
    programAddress: programAddr || BIN_FARM_PROGRAM_ADDRESS,
  };
}

// ============================================================
// WALLET — multi-wallet support
// ============================================================

export function toggleWalletMenu() {
  if (state.connected) {
    disconnectWallet();
    return;
  }
  connectWallet();
}

export async function connectWallet() {
  const btn = document.getElementById('connectWallet');
  if (btn) btn.textContent = 'connecting...';

  try {
    const { addresses } = await phantomSDK.connect({ provider: 'injected' });
    if (CONFIG.DEBUG) console.log('[monke] SDK connect addresses:', JSON.stringify(addresses));

    let pubkeyStr;
    if (addresses && addresses.length > 0) {
      const solAddr = addresses.find(a =>
        a.addressType === 'solana' || a.addressType === AddressType.solana || a.chain === 'solana'
      );
      pubkeyStr = solAddr ? (solAddr.address || solAddr.publicKey) : addresses[0].address || addresses[0].publicKey;
    }
    if (!pubkeyStr && window.solana?.publicKey) {
      pubkeyStr = window.solana.publicKey.toString();
    }
    if (!pubkeyStr) throw new Error('No Solana address returned from wallet');
    const pubkey = new solanaWeb3.PublicKey(pubkeyStr);

    state.publicKey = pubkey;
    state.connected = true;
    state.connection = new solanaWeb3.Connection(
      CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed'
    );

    window.__monkeWallet = { publicKey: pubkey };
    window.dispatchEvent(new Event('monke:walletChanged'));

    await loadOnChainFeeBps();

    const short = pubkey.toString().slice(0, 4) + '...' + pubkey.toString().slice(-4);
    if (btn) {
      btn.textContent = short;
      btn.classList.add('connected');
    }

    showToast('Connected', 'success');
    refreshPositionsList();
    loadBinVizData();
    if (state.currentPage === 1) renderPositionsPage();
    renderMonkeList();
    updateFee();
    if (state.currentSubPage === 'pegged') loadPeggedSection();
  } catch (err) {
    console.error('Wallet connection failed:', err);
    if (btn) btn.textContent = 'connect wallet';
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (isMobile && (err?.message?.includes('provider') || !window.solana)) {
      const deepLink = `https://phantom.app/ul/browse/${encodeURIComponent(window.location.href)}`;
      showToast('Redirecting to Phantom...', 'info');
      setTimeout(() => { window.location.href = deepLink; }, 1500);
    } else {
      showToast('Connection failed', 'error');
    }
  }
}

export async function disconnectWallet() {
  try { await phantomSDK.disconnect(); } catch (_) {}

  state.connected = false;
  state.publicKey = null;
  state.positions = [];
  vizState.userBins.clear();
  vizState.previewBins.clear();

  window.__monkeWallet = null;
  window.dispatchEvent(new Event('monke:walletChanged'));

  const btn = document.getElementById('connectWallet');
  if (btn) {
    btn.textContent = 'connect wallet';
    btn.classList.remove('connected');
  }
  showToast('Disconnected');
  updatePositionsList();
  renderMonkeList();
}
