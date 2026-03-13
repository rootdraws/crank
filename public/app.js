/**
 * crank.money — Application Logic
 *
 * Merges:
 * - frame.html scaffold geometry (arc-tracing range panels, pixel-based sliders)
 * - App UI logic (pool loading, position creation, monke dashboard, rover bribes)
 * - SDK integration (transaction.js, meteora.js, bins.js, zap.js, useWallet.js)
 *
 * On-chain calls are structured correctly for immediate swap to real RPCs
 * once programs are deployed. Until then, demo mode simulates responses.
 */

// Phantom Connect Browser SDK
import { BrowserSDK, AddressType } from '@phantom/browser-sdk';

// Codama-generated clients (bundled by esbuild)
import { address } from '@solana/kit';
import {
  getOpenPositionV2InstructionAsync,
  getUserCloseInstructionAsync,
  getClaimFeesInstruction,
  getHarvestBinsInstructionAsync,
  getSweepRoverInstructionAsync,
  decodePosition, decodeConfig,
  BIN_FARM_PROGRAM_ADDRESS, Side,
} from '../src/generated/bin-farm/index.js';
import {
  getFeedMonkeInstructionAsync,
  getFeedGooseInstructionAsync,
  getClaimInstructionAsync,
  getClaimPeggedInstructionAsync,
  getDepositSolInstructionAsync,
  getDepositPeggedInstructionAsync,
  getSetPeggedMintInstructionAsync,
  decodeMonkeBurn, decodeMonkeState,
  MONKE_BANANAS_PROGRAM_ADDRESS,
} from '../src/generated/monke-bananas/index.js';

// ============================================================
// CONFIG — matches .env.example
// ============================================================

const CONFIG = {
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

// Runtime config injection — override defaults from /config.json
async function loadConfig() {
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

// ============================================================
// PHANTOM CONNECT SDK
// ============================================================

const phantomSDK = new BrowserSDK({
  providers: ['injected'],
  addressTypes: [AddressType.solana],
  appId: '89b27865-826e-439c-93c3-80464b758b51',
});

// ============================================================
// CODAMA ADAPTERS — bridge @solana/kit types ↔ @solana/web3.js
// ============================================================

const DEFAULT_PRIORITY_MICROLAMPORTS = 100_000;

/** Build SetComputeUnitPrice ix without Buffer (web3.js u64 path needs Buffer which browsers lack) */
function makeComputeUnitPriceIx(microLamports) {
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
function kitIxToWeb3(ix) {
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
function asSigner(pubkeyOrAddress) {
  const addr = typeof pubkeyOrAddress === 'string'
    ? pubkeyOrAddress : pubkeyOrAddress.toBase58();
  return {
    address: address(addr),
    signTransactions: async () => { throw new Error('use web3.js for signing'); },
  };
}

async function preSimulate(tx) {
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
async function walletSendTransaction(tx) {
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
async function getPoolALT() {
  if (_cachedALT) return _cachedALT;
  const altPubkey = new solanaWeb3.PublicKey(CONFIG.POOL_ALT);
  const res = await state.connection.getAddressLookupTable(altPubkey);
  if (!res.value) throw new Error('ALT not found: ' + CONFIG.POOL_ALT);
  _cachedALT = res.value;
  return _cachedALT;
}

/** Pre-simulate a VersionedTransaction (base64-encoded, sigVerify: false) */
async function preSimulateVersioned(vtx) {
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
async function confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight) {
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
async function ensureAccountsSetup(conn, payer, ataChecks, extraSetupIxs = []) {
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
function toEncodedAccount(pubkeyOrStr, data, programAddr) {
  return {
    address: typeof pubkeyOrStr === 'string' ? pubkeyOrStr
      : pubkeyOrStr.toBase58 ? pubkeyOrStr.toBase58() : String(pubkeyOrStr),
    data: new Uint8Array(data),
    executable: false,
    lamports: 0n,
    programAddress: programAddr || BIN_FARM_PROGRAM_ADDRESS,
  };
}

// Read fee_bps from on-chain Config (falls back to config.json value if RPC fails)
async function loadOnChainFeeBps() {
  try {
    if (!state.connection) return;
    const [configPDA] = solanaWeb3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('config')],
      new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
    );
    const accountInfo = await state.connection.getAccountInfo(configPDA);
    if (accountInfo && accountInfo.data.length >= 138) {
      const decoded = decodeConfig(toEncodedAccount(configPDA, accountInfo.data, BIN_FARM_PROGRAM_ADDRESS));
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
// BOT RELAY — WebSocket + REST connection to the LaserStream relay
// ============================================================

let relayWs = null;
let relayConnected = false;
let relayRetries = 0;
const RELAY_MAX_RETRIES = 10;
const RELAY_BASE_DELAY = 5000;

function connectRelay() {
  const url = CONFIG.BOT_RELAY_URL;
  if (!url) return;
  if (relayRetries >= RELAY_MAX_RETRIES) {
    if (CONFIG.DEBUG) console.log('[relay] Max retries reached — bot offline');
    return;
  }

  try {
    relayWs = new WebSocket(url + '/ws');

    relayWs.onopen = () => {
      relayConnected = true;
      relayRetries = 0;
      if (CONFIG.DEBUG) console.log('[relay] Connected to bot relay');
      const statusEl = document.getElementById('opsBotStatus');
      if (statusEl) statusEl.textContent = 'connected';
    };

    relayWs.onclose = () => {
      relayConnected = false;
      const statusEl = document.getElementById('opsBotStatus');
      if (statusEl) statusEl.textContent = 'offline';
      relayRetries++;
      if (relayRetries < RELAY_MAX_RETRIES) {
        const delay = RELAY_BASE_DELAY * Math.pow(2, relayRetries - 1);
        if (CONFIG.DEBUG) console.log(`[relay] Reconnecting in ${delay / 1000}s (attempt ${relayRetries}/${RELAY_MAX_RETRIES})`);
        setTimeout(connectRelay, delay);
      }
    };

    relayWs.onerror = () => {
      relayConnected = false;
    };

    relayWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleRelayEvent(msg);
      } catch {}
    };
  } catch {
    relayRetries++;
    if (relayRetries < RELAY_MAX_RETRIES) {
      setTimeout(connectRelay, RELAY_BASE_DELAY * Math.pow(2, relayRetries - 1));
    }
  }
}

function handleRelayEvent(msg) {
  switch (msg.type) {
    case 'activeBinChanged': {
      // Update price if we're watching the primary pool
      const isWatchedPool = state.poolAddress && (
        msg.data.lbPair === state.poolAddress ||
        state.discoveredDlmmPools.some(p => p.address === msg.data.lbPair)
      );
      if (isWatchedPool) {
        if (msg.data.lbPair === state.poolAddress) {
          const newPrice = binToPrice(msg.data.newActiveId, state.binStep, state.tokenXDecimals, state.tokenYDecimals);
          state.currentPrice = newPrice;
          state.activeBin = msg.data.newActiveId;
          const priceEl = document.getElementById('currentPrice');
          if (priceEl) priceEl.textContent = '$' + formatPrice(newPrice);
          vizState.activeBin = msg.data.newActiveId;
        }
        loadBinVizData();
      }
      break;
    }

    case 'binArrayUpdated':
      if (msg.data && msg.data.lbPair && state.discoveredDlmmPools.some(p => p.address === msg.data.lbPair)) {
        patchBinArrayCache(msg.data);
        renderBinVizDebounced();
      }
      break;

    case 'harvestExecuted':
    case 'positionClosed':
    case 'positionChanged':
      addFeedEvent(formatRelayEvent(msg));
      refreshPositionsList();
      if (state.currentPage === 1) renderPositionsPage();
      loadUserBins().then(() => renderBinViz());
      break;

    case 'harvestNeeded':
    case 'roverTvlUpdated':
      addFeedEvent(formatRelayEvent(msg));
      break;

    case 'feedHistory':
      // Catch-up events on WebSocket connect (only if preload hasn't already populated the feed)
      if (msg.data && Array.isArray(msg.data)) {
        const feed = document.getElementById('activityFeed');
        const hasFeedContent = feed && feed.children.length > 0 && !feed.querySelector('.empty-state');
        if (!hasFeedContent) {
          for (const evt of [...msg.data].reverse()) {
            addFeedEvent(evt.text || formatRelayEvent(evt), evt.timestamp);
          }
        }
      }
      break;
  }
}

function formatRelayEvent(msg) {
  const d = msg.data || {};
  switch (msg.type) {
    case 'harvestExecuted':
      return `harvested ${d.binCount || '?'} bins on ${(d.lbPair || '').slice(0, 8)}... → ${(d.owner || '').slice(0, 6)}...`;
    case 'positionClosed':
      return `position closed ${(d.lbPair || '').slice(0, 8)}... → ${(d.owner || '').slice(0, 6)}...`;
    case 'harvestNeeded':
      return `${d.safeBinCount || '?'} bins ready on ${(d.lbPair || '').slice(0, 8)}...`;
    case 'positionChanged':
      return `position ${d.action || '?'}: ${(d.positionPDA || '').slice(0, 8)}...`;
    case 'activeBinChanged':
      return `price moved on ${(d.lbPair || '').slice(0, 8)}... → bin ${d.newActiveId}`;
    case 'roverTvlUpdated':
      return `rover TVL updated: ${d.count || 0} pools, $${d.totalTvl || 0}`;
    default:
      return `${msg.type}: ${JSON.stringify(d).slice(0, 80)}`;
  }
}

async function relayFetch(path, options = {}) {
  if (!CONFIG.BOT_RELAY_URL) return null;
  const baseUrl = CONFIG.BOT_RELAY_URL.replace('ws://', 'http://').replace('wss://', 'https://');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const opts = { ...options, signal: controller.signal };
    if (opts.body && !opts.headers) opts.headers = { 'Content-Type': 'application/json' };
    const resp = await fetch(baseUrl + path, opts);
    clearTimeout(timer);
    if (resp.ok) return resp.json();
  } catch {}
  clearTimeout(timer);
  return null;
}

let _binVizDebounceTimer = null;
function renderBinVizDebounced() {
  clearTimeout(_binVizDebounceTimer);
  _binVizDebounceTimer = setTimeout(renderBinViz, 50);
}

function patchBinArrayCache(data) {
  if (!data || !data.bins) return;
  const dlmmPools = state.discoveredDlmmPools.length > 0
    ? state.discoveredDlmmPools
    : [{ address: state.poolAddress, bin_step: state.binStep }];
  const poolEntry = dlmmPools.find(p => p.address === data.lbPair);
  if (!poolEntry || !vizState.logSlotStep) return;
  const poolBinStep = poolEntry.bin_step ?? poolEntry.binStep;
  const poolLogStep = Math.log(1 + poolBinStep / 10000);
  const { logPriceMin, logSlotStep, slotCount } = vizState;

  for (const [binIdStr, amounts] of Object.entries(data.bins)) {
    const binId = parseInt(binIdStr, 10);
    const binLogLow = binId * poolLogStep - poolLogStep / 2;
    const binLogHigh = binId * poolLogStep + poolLogStep / 2;
    const slotLow = Math.max(0, Math.floor((binLogLow - logPriceMin) / logSlotStep));
    const slotHigh = Math.min(slotCount - 1, Math.floor((binLogHigh - logPriceMin) / logSlotStep));
    if (slotHigh < 0 || slotLow >= slotCount) continue;
    const span = Math.max(1, slotHigh - slotLow + 1);
    for (let s = slotLow; s <= slotHigh; s++) {
      const ex = vizState.poolBins.get(s) || { amountX: 0, amountY: 0 };
      ex.amountX += amounts.amountX / span;
      ex.amountY += amounts.amountY / span;
      vizState.poolBins.set(s, ex);
    }
  }
}

// ============================================================
// SDK INLINE — key functions from our fixed SDK files
// ============================================================

/** Bin <-> Price math (from bins.js). decimalsX/Y normalize atomic price to human-readable. */
function binToPrice(binId, binStep, decimalsX = 0, decimalsY = 0) {
  const raw = Math.pow(1 + binStep / 10000, binId);
  return raw * Math.pow(10, decimalsX - decimalsY);
}

function priceToBin(price, binStep, decimalsX = 0, decimalsY = 0, roundDown = true) {
  if (price <= 0) return NaN;
  const raw = price / Math.pow(10, decimalsX - decimalsY);
  const binId = Math.log(raw) / Math.log(1 + binStep / 10000);
  return roundDown ? Math.floor(binId) : Math.ceil(binId);
}

function formatPrice(price) {
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.0001) return price.toFixed(6);
  return price.toExponential(2);
}

/** Fee calculation (from transaction.js) */
function calculateFee(amount) {
  return Math.floor(amount * CONFIG.FEE_BPS / 10000);
}

function calculateAmounts(amount) {
  const fee = calculateFee(amount);
  return { fee, net: amount - fee, feePercent: CONFIG.FEE_BPS / 100 };
}

/** PDA derivation — core program */
function getConfigPDA() {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('config')],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

function getPositionPDA(meteoraPosition) {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('position'), meteoraPosition.toBytes()],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

function getVaultPDA(meteoraPosition) {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('vault'), meteoraPosition.toBytes()],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

function getPositionCounterPDA(user, lbPair) {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('pos_counter'), user.toBytes(), lbPair.toBytes()],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

function getMeteoraPosiitonPDA(user, lbPair, count) {
  const countBuf = new Uint8Array(8);
  new DataView(countBuf.buffer).setBigUint64(0, BigInt(count), true);
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('meteora_pos'), user.toBytes(), lbPair.toBytes(), countBuf],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

function getRoverAuthorityPDA() {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('rover_authority')],
    new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID)
  );
}

/** PDA derivation — monke_bananas program */
function getMonkeStatePDA() {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('monke_state')],
    new solanaWeb3.PublicKey(CONFIG.MONKE_BANANAS_PROGRAM_ID)
  );
}

function getMonkeBurnPDA(nftMint) {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('monke_burn'), nftMint.toBytes()],
    new solanaWeb3.PublicKey(CONFIG.MONKE_BANANAS_PROGRAM_ID)
  );
}

function getDistPoolPDA() {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('dist_pool')],
    new solanaWeb3.PublicKey(CONFIG.MONKE_BANANAS_PROGRAM_ID)
  );
}

function getProgramVaultPDA() {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('program_vault')],
    new solanaWeb3.PublicKey(CONFIG.MONKE_BANANAS_PROGRAM_ID)
  );
}

/** PDA derivation — Metaplex Token Metadata */
const METAPLEX_PROGRAM_ID = new solanaWeb3.PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

function getMetadataPDA(nftMint) {
  return solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('metadata'), METAPLEX_PROGRAM_ID.toBytes(), nftMint.toBytes()],
    METAPLEX_PROGRAM_ID
  );
}


const PRECISION = 1_000_000_000_000n;

/** Compute pending SOL claim for a MonkeBurn given MonkeState accumulator */
function computePendingClaim(burn, monkeState) {
  if (!burn || !monkeState || burn.shareWeight === 0n) return 0n;
  const pending = (burn.shareWeight * monkeState.accumulatedSolPerShare / PRECISION) - burn.rewardDebt;
  return pending > 0n ? pending : 0n;
}

/** Token program constants */
const TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new solanaWeb3.PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new solanaWeb3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SPL_MEMO_PROGRAM_ID = new solanaWeb3.PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const SYSVAR_RENT_PUBKEY = new solanaWeb3.PublicKey('SysvarRent111111111111111111111111111111111');
const NATIVE_MINT = new solanaWeb3.PublicKey('So11111111111111111111111111111111111111112');

/** Derive Associated Token Address (pure PDA, no SDK needed) */
function getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve = false, tokenProgramId = TOKEN_PROGRAM_ID) {
  const [ata] = solanaWeb3.PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgramId.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

/** Build create-ATA-idempotent instruction (won't fail if ATA already exists) */
function createAssociatedTokenAccountIx(payer, ata, owner, mint, tokenProgramId = TOKEN_PROGRAM_ID) {
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
function createSyncNativeIx(nativeAccount) {
  return new solanaWeb3.TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: nativeAccount, isSigner: false, isWritable: true }],
    data: new Uint8Array([17]),
  });
}

/** Build SystemProgram transfer without Buffer dependency */
function buildSystemTransferIx(from, to, lamports) {
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
function buildWrapSolIxs(from, wsolAta, lamports) {
  return [
    buildSystemTransferIx(from, wsolAta, lamports),
    createSyncNativeIx(wsolAta),
  ];
}

/** Derive Meteora bin array PDA */
function deriveBinArrayPDA(lbPairPubkey, arrayIndex, dlmmProgramId) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigInt64(0, BigInt(arrayIndex), true);
  const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('bin_array'), lbPairPubkey.toBytes(), new Uint8Array(buf)],
    dlmmProgramId
  );
  return pda;
}

/** Derive Meteora event authority PDA */
function deriveEventAuthorityPDA(dlmmProgramId) {
  const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('__event_authority')],
    dlmmProgramId
  );
  return pda;
}

/** Derive Meteora bin array bitmap extension PDA */
function deriveBitmapExtPDA(lbPairPubkey, dlmmProgramId) {
  const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('bitmap'), lbPairPubkey.toBytes()],
    dlmmProgramId
  );
  return pda;
}

/** Compute bin array index from bin ID (matches Meteora SDK binIdToBinArrayIndex) */
function binIdToBinArrayIndex(binId) {
  return Math.floor(binId / 70);
}

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
async function ensureBinArraysExist(lbPairPubkey, minBinId, maxBinId, funder, dlmmProgramId) {
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

/**
 * Resolve all Meteora CPI accounts needed for open_position.
 * Reads LbPair on-chain for reserves/mints/program flags.
 */
async function resolveMeteoraCPIAccounts(poolAddress, minBinId, maxBinId) {
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

/** Fill percent */
function getFillPercent(currentAmount, initialAmount) {
  if (initialAmount === 0) return 0;
  const converted = initialAmount - currentAmount;
  if (converted < 0) return 0;
  const fillBps = Math.floor((converted * 10000) / initialAmount);
  return Math.min(fillBps / 10000, 1.0);
}

/** HTML escape to prevent XSS from on-chain data */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

/** Read mint decimals at runtime (works without wallet connection) */
async function getMintDecimals(mintAddress) {
  try {
    const conn = state.connection || new solanaWeb3.Connection(
      CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed'
    );
    const pubkey = new solanaWeb3.PublicKey(mintAddress);
    const info = await conn.getParsedAccountInfo(pubkey);
    return info.value?.data?.parsed?.info?.decimals ?? 9;
  } catch {
    return 9;
  }
}

// ============================================================
// MOCK DATA
// ============================================================

// Mock data removed — live data flows from bot relay + on-chain reads

// ============================================================
// STATE
// ============================================================

const state = {
  // Wallet
  connected: false,
  publicKey: null,
  connection: null,

  // Pool
  poolAddress: null,
  activeBin: null,
  binStep: 10,
  currentPrice: null,
  tokenXSymbol: 'TOKEN',
  tokenYSymbol: 'SOL',
  tokenXMint: null,
  tokenYMint: null,
  tokenXDecimals: 9,
  tokenYDecimals: 9,

  // Side
  side: 'buy',

  // Positions (fetched from chain in prod, mock for demo)
  positions: [],

  // Pool discovery
  tokenMint: null,
  discoveredDlmmPools: [],
  discoveredDammPools: [],
  addressBook: { active: [], recent: [], topPairs: [] },
  trendingPools: [],

  // Navigation
  currentPage: 0,
  currentSubPage: 'monke',
  ohlcvTimeframe: '24h',
  activePoolOrbital: 0,
};

// ============================================================
// PERCENTAGE RANGE — bin math from user-entered percentages
// ============================================================

function percentToPrice(pct, side) {
  if (!state.currentPrice) return 0;
  if (side === 'buy') return state.currentPrice * (1 - pct / 100);
  return state.currentPrice * (1 + pct / 100);
}

function getRangeBins() {
  const near = parseFloat(document.getElementById('rangeNear')?.value) || 0;
  const far = parseFloat(document.getElementById('rangeFar')?.value) || 0;
  const nearPrice = percentToPrice(near, state.side);
  const farPrice = percentToPrice(far, state.side);
  // For buy: far is lower price (more bins below), near is higher
  // For sell: near is lower price, far is higher
  const minBin = priceToBin(Math.min(nearPrice, farPrice), state.binStep, state.tokenXDecimals, state.tokenYDecimals);
  const maxBin = priceToBin(Math.max(nearPrice, farPrice), state.binStep, state.tokenXDecimals, state.tokenYDecimals, false);
  return { minBin, maxBin };
}

// ============================================================
// UI UPDATES
// ============================================================


function updateSide(newSide) {
  state.side = newSide;
  document.querySelectorAll('.side-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.side-tab.${newSide}`)?.classList.add('active');

  const btn = document.getElementById('actionBtn');
  if (btn) {
    btn.className = 'action-btn ' + newSide;
    btn.textContent = newSide === 'buy' ? 'buy' : 'sell';
  }

  const tok = document.getElementById('amountToken');
  if (tok) tok.textContent = newSide === 'buy' ? state.tokenYSymbol : state.tokenXSymbol;

  // Update range suffix text and default values
  const suffix = newSide === 'buy' ? 'percent below price.' : 'percent above price.';
  const suffixEl = document.getElementById('rangeSuffix');
  const suffixFarEl = document.getElementById('rangeSuffixFar');
  if (suffixEl) suffixEl.textContent = suffix;
  if (suffixFarEl) suffixFarEl.textContent = suffix;

  const nearInput = document.getElementById('rangeNear');
  const farInput = document.getElementById('rangeFar');
  if (nearInput) nearInput.value = newSide === 'buy' ? '1' : '1';
  if (farInput) farInput.value = newSide === 'buy' ? '5' : '5';

  updateFee();
  updateBinStrip();
}

async function updateFee() {
  const el = document.getElementById('feeAmount');
  if (!el) return;

  if (!state.connected || !state.connection || !state.publicKey) {
    el.textContent = `${CONFIG.FEE_BPS / 100}% on output`;
    return;
  }

  try {
    const mint = state.side === 'buy' ? state.tokenYMint : state.tokenXMint;
    const decimals = state.side === 'buy' ? state.tokenYDecimals : state.tokenXDecimals;
    const symbol = state.side === 'buy' ? (state.tokenYSymbol || 'SOL') : (state.tokenXSymbol || 'TOKEN');
    if (!mint) { el.textContent = `${CONFIG.FEE_BPS / 100}% on output`; return; }

    let rawAmount;
    if (mint === NATIVE_MINT.toBase58() || mint === 'So11111111111111111111111111111111111111112') {
      rawAmount = await state.connection.getBalance(state.publicKey);
    } else {
      const mintPk = new solanaWeb3.PublicKey(mint);
      const atas = await state.connection.getTokenAccountsByOwner(state.publicKey, { mint: mintPk });
      rawAmount = 0;
      for (const { account } of atas.value) {
        rawAmount += Number(account.data.readBigUInt64LE(64));
      }
    }
    el.textContent = `balance: ${(rawAmount / Math.pow(10, decimals)).toFixed(4)} ${symbol}`;
  } catch {
    el.textContent = `${CONFIG.FEE_BPS / 100}% on output`;
  }
}

function updateBinStrip() {
  if (!state.currentPrice || !state.activeBin) return;

  const near = parseFloat(document.getElementById('rangeNear')?.value) || 0;
  const far = parseFloat(document.getElementById('rangeFar')?.value) || 0;

  const rangeEl = document.getElementById('binStripRange');
  const activeEl = document.getElementById('binStripActive');
  const nearLabel = document.getElementById('binStripNear');
  const farLabel = document.getElementById('binStripFar');
  const currentLabel = document.getElementById('binStripCurrent');
  if (!rangeEl || !activeEl) return;

  const maxPct = Math.max(far, near) * 1.3;
  if (maxPct <= 0) return;

  if (state.side === 'buy') {
    const rangeLeft = (1 - far / maxPct) * 100;
    const rangeWidth = ((far - near) / maxPct) * 100;
    const activePos = (1 - 0 / maxPct) * 100;
    rangeEl.style.left = rangeLeft + '%';
    rangeEl.style.width = Math.max(rangeWidth, 1) + '%';
    rangeEl.style.background = 'var(--data-green-faint)';
    activeEl.style.left = Math.min(activePos, 99) + '%';
    if (nearLabel) nearLabel.textContent = '-' + near + '%';
    if (farLabel) farLabel.textContent = '-' + far + '%';
  } else {
    const rangeLeft = (near / maxPct) * 100;
    const rangeWidth = ((far - near) / maxPct) * 100;
    const activePos = 0;
    rangeEl.style.left = rangeLeft + '%';
    rangeEl.style.width = Math.max(rangeWidth, 1) + '%';
    rangeEl.style.background = 'var(--alert-red-fill)';
    activeEl.style.left = activePos + '%';
    if (nearLabel) nearLabel.textContent = '+' + near + '%';
    if (farLabel) farLabel.textContent = '+' + far + '%';
  }

  if (currentLabel) currentLabel.textContent = '$' + formatPrice(state.currentPrice);
}

// ============================================================
// WALLET — multi-wallet support
// ============================================================

function toggleWalletMenu() {
  if (state.connected) {
    disconnectWallet();
    return;
  }
  connectWallet();
}

async function connectWallet() {
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
    loadAddressBook();
    loadAddressBook();
  } catch (err) {
    console.error('Wallet connection failed:', err);
    if (btn) btn.textContent = 'connect wallet';
    showToast('Connection failed', 'error');
  }
}

async function disconnectWallet() {
  try { await phantomSDK.disconnect(); } catch (_) {}

  state.connected = false;
  state.publicKey = null;
  state.addressBook = { active: [], recent: [] };
  renderAddressBook();

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

// ============================================================
// POOL LOADING
// ============================================================

const LBPAIR_EXPECTED_SIZE = 904;
const LBPAIR_OFFSETS = {
  ACTIVE_ID: 76,       // i32
  BIN_STEP: 80,        // u16
  TOKEN_X_MINT: 88,    // pubkey (32 bytes)
  TOKEN_Y_MINT: 120,   // pubkey (32 bytes)
  RESERVE_X: 152,      // pubkey (32 bytes)
  RESERVE_Y: 184,      // pubkey (32 bytes)
  TOKEN_X_PROG_FLAG: 880, // u8 (0=SPL, 1=Token-2022)
  TOKEN_Y_PROG_FLAG: 881, // u8
};

const KNOWN_TOKENS = {
  'So11111111111111111111111111111111111111112': 'SOL',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'mSOL',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'jitoSOL',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': 'BONK',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP',
  'Fr4cqYmSK1n8H1ePkcpZthKTiXWqN14ZTn9zj1Gnpump': 'CRANK',
};

async function parseLbPair(address) {
  const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;
  const pubkey = new solanaWeb3.PublicKey(address);

  const conn = state.connection || new solanaWeb3.Connection(rpcUrl, 'confirmed');
  const accountInfo = await conn.getAccountInfo(pubkey);

  if (!accountInfo) throw new Error('Account not found — check the address');
  if (accountInfo.data.length !== LBPAIR_EXPECTED_SIZE) {
    throw new Error(`Not a DLMM pool (expected ${LBPAIR_EXPECTED_SIZE} bytes, got ${accountInfo.data.length})`);
  }

  const data = accountInfo.data;
  const activeId = data.readInt32LE(LBPAIR_OFFSETS.ACTIVE_ID);
  const binStep = data.readUInt16LE(LBPAIR_OFFSETS.BIN_STEP);

  if (binStep === 0 || binStep > 500) {
    throw new Error(`Invalid bin_step ${binStep} — account may not be an LbPair`);
  }

  const tokenXMint = new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.TOKEN_X_MINT, LBPAIR_OFFSETS.TOKEN_X_MINT + 32));
  const tokenYMint = new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.TOKEN_Y_MINT, LBPAIR_OFFSETS.TOKEN_Y_MINT + 32));

  return { activeId, binStep, tokenXMint, tokenYMint };
}

async function parseLbPairFull(address) {
  const conn = state.connection || new solanaWeb3.Connection(CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed');
  const pubkey = new solanaWeb3.PublicKey(address);
  const accountInfo = await conn.getAccountInfo(pubkey);
  if (!accountInfo) throw new Error('Account not found');
  if (accountInfo.data.length !== LBPAIR_EXPECTED_SIZE) throw new Error('Not a DLMM pool');
  const data = accountInfo.data;
  return {
    activeId: data.readInt32LE(LBPAIR_OFFSETS.ACTIVE_ID),
    binStep: data.readUInt16LE(LBPAIR_OFFSETS.BIN_STEP),
    tokenXMint: new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.TOKEN_X_MINT, LBPAIR_OFFSETS.TOKEN_X_MINT + 32)),
    tokenYMint: new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.TOKEN_Y_MINT, LBPAIR_OFFSETS.TOKEN_Y_MINT + 32)),
    reserveX: new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.RESERVE_X, LBPAIR_OFFSETS.RESERVE_X + 32)),
    reserveY: new solanaWeb3.PublicKey(data.slice(LBPAIR_OFFSETS.RESERVE_Y, LBPAIR_OFFSETS.RESERVE_Y + 32)),
    tokenXProgramFlag: data.readUInt8(LBPAIR_OFFSETS.TOKEN_X_PROG_FLAG),
    tokenYProgramFlag: data.readUInt8(LBPAIR_OFFSETS.TOKEN_Y_PROG_FLAG),
  };
}

async function resolveTokenSymbol(mintPubkey) {
  const addr = mintPubkey.toBase58();
  if (KNOWN_TOKENS[addr]) return KNOWN_TOKENS[addr];

  try {
    const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getAsset',
        params: { id: addr },
      }),
    });
    const json = await resp.json();
    const symbol = json?.result?.content?.metadata?.symbol;
    if (symbol) {
      KNOWN_TOKENS[addr] = symbol;
      return symbol;
    }
  } catch {}

  return addr.slice(0, 4) + '...' + addr.slice(-4);
}

// ============================================================
// POOL DISCOVERY — Meteora DataPI + address book
// ============================================================

const METEORA_API_BASE = () => CONFIG.METEORA_API_URL || 'https://dlmm.datapi.meteora.ag';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function formatVolume(v) {
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(v);
}

function timeAgo(ts) {
  const diff = (Date.now() / 1000) - ts;
  if (diff < 3600) return Math.round(diff / 60) + 'm ago';
  if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
  if (diff < 172800) return 'yesterday';
  return Math.round(diff / 86400) + 'd ago';
}

async function fetchTrendingPools() {
  try {
    const resp = await fetch(
      `${METEORA_API_BASE()}/pools/groups?sort_by=volume_24h:desc&page_size=8&filter_by=is_blacklisted=false`
    );
    if (!resp.ok) return;
    const { data } = await resp.json();
    state.trendingPools = (data || []).map(g => {
      const mints = g.lexical_order_mints.split('-');
      const mint = mints.find(m => m !== SOL_MINT && m !== USDC_MINT) || mints[0];
      return {
        name: g.group_name,
        mint,
        volume: g.total_volume,
        tvl: g.total_tvl,
        poolCount: g.pool_count,
      };
    });
    renderTrendingFeed();
  } catch {
    if (CONFIG.DEBUG) console.warn('[discovery] Trending feed unavailable');
  }
}

async function discoverAllPoolsForToken(mintAddress) {
  const DAMM_API_BASE = CONFIG.DAMM_API_URL || 'https://damm-v2.datapi.meteora.ag';
  const quoteKeys = [SOL_MINT, USDC_MINT].map(quote => [mintAddress, quote].sort().join('-'));

  const [dlmmSol, dlmmUsdc, dammSol, dammUsdc] = await Promise.all([
    fetch(`${METEORA_API_BASE()}/pools/groups/${quoteKeys[0]}?sort_by=volume_24h:desc&page_size=10`)
      .then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
    fetch(`${METEORA_API_BASE()}/pools/groups/${quoteKeys[1]}?sort_by=volume_24h:desc&page_size=10`)
      .then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
    fetch(`${DAMM_API_BASE}/pools/groups/${quoteKeys[0]}?sort_by=volume_24h:desc&page_size=10`)
      .then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
    fetch(`${DAMM_API_BASE}/pools/groups/${quoteKeys[1]}?sort_by=volume_24h:desc&page_size=10`)
      .then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
  ]);

  const dlmmPools = [...(dlmmSol.data || []), ...(dlmmUsdc.data || [])]
    .filter(p => !p.is_blacklisted)
    .sort((a, b) => (b.volume?.['24h'] || 0) - (a.volume?.['24h'] || 0));

  // Normalize API response shape: the DataAPI nests bin_step inside pool_config
  // and never returns active_id — derive it from current_price and token decimals.
  for (const p of dlmmPools) {
    if (p.bin_step == null && p.pool_config?.bin_step != null) {
      p.bin_step = p.pool_config.bin_step;
    }
    if (p.active_id == null && p.current_price > 0 && p.bin_step) {
      const decimalsX = p.token_x?.decimals ?? 9;
      const decimalsY = p.token_y?.decimals ?? 6;
      const rawPrice = p.current_price / Math.pow(10, decimalsX - decimalsY);
      p.active_id = Math.round(Math.log(rawPrice) / Math.log(1 + p.bin_step / 10000));
    }
  }

  const dammPools = [...(dammSol.data || []), ...(dammUsdc.data || [])]
    .filter(p => !p.is_blacklisted)
    .sort((a, b) => (b.volume?.['24h'] || 0) - (a.volume?.['24h'] || 0));

  // Tag DAMM pools so renderPoolPicker can badge them
  dammPools.forEach(p => { p._source = 'damm'; });

  // Register known symbols
  for (const p of [...dlmmPools, ...dammPools]) {
    if (p.token_x?.symbol) KNOWN_TOKENS[p.token_x?.address] = p.token_x.symbol;
    if (p.token_y?.symbol) KNOWN_TOKENS[p.token_y?.address] = p.token_y.symbol;
  }

  return { dlmm: dlmmPools, damm: dammPools };
}

async function loadAggregatedView(dlmmPools, dammPools) {
  state.tokenMint = document.getElementById('poolAddress')?.value.trim();
  state.discoveredDlmmPools = dlmmPools;
  state.discoveredDammPools = dammPools;

  const primary = dlmmPools[0];
  state.poolAddress = primary.address;
  state.activeBin = primary.active_id ?? primary.activeId ?? primary.active_bin_id;
  state.binStep = primary.bin_step ?? primary.binStep;
  state.tokenXSymbol = primary.token_x?.symbol || 'TOKEN';
  state.tokenYSymbol = primary.token_y?.symbol || 'SOL';
  state.tokenXMint = primary.token_x?.address || null;
  state.tokenYMint = primary.token_y?.address || null;

  if (state.tokenXMint) {
    const [dX, dY] = await Promise.all([getMintDecimals(state.tokenXMint), getMintDecimals(state.tokenYMint)]);
    state.tokenXDecimals = dX;
    state.tokenYDecimals = dY;
  }

  state.currentPrice = binToPrice(state.activeBin, state.binStep, state.tokenXDecimals, state.tokenYDecimals);

  document.getElementById('poolName').textContent = `${state.tokenXSymbol}/${state.tokenYSymbol}`;
  document.getElementById('currentPrice').textContent = '$' + formatPrice(state.currentPrice);
  document.getElementById('poolInfo').classList.add('visible');

  updatePoolMetrics(primary);
  fetchAndRenderOHLCV(primary.address, state.ohlcvTimeframe || '24h');

  // Show/hide DAMM TVL info
  let dammInfoEl = document.getElementById('dammTvlInfo');
  if (dammPools.length > 0) {
    const totalTvl = dammPools.reduce((sum, p) => sum + (p.tvl || p.liquidity || 0), 0);
    const tvlStr = totalTvl >= 1e6 ? '$' + (totalTvl / 1e6).toFixed(1) + 'M'
                 : totalTvl >= 1e3 ? '$' + (totalTvl / 1e3).toFixed(0) + 'K'
                 : '$' + Math.round(totalTvl);
    if (!dammInfoEl) {
      dammInfoEl = document.createElement('div');
      dammInfoEl.id = 'dammTvlInfo';
      dammInfoEl.className = 'damm-tvl-info';
      document.getElementById('poolInfo').after(dammInfoEl);
    }
    dammInfoEl.textContent = `+ ${tvlStr} DAMM v2 liquidity (${dammPools.length} pool${dammPools.length > 1 ? 's' : ''})`;
    dammInfoEl.style.display = '';
  } else if (dammInfoEl) {
    dammInfoEl.style.display = 'none';
  }

  // Primary pool selector when multiple DLMM pools exist
  const selectWrap = document.getElementById('primaryPoolSelectWrap');
  const select = document.getElementById('primaryPoolSelect');
  if (selectWrap && select && dlmmPools.length > 1) {
    select.innerHTML = dlmmPools.map((p, i) => {
      const label = `${p.token_x?.symbol || '?'}/${p.token_y?.symbol || '?'} · ${p.bin_step ?? p.binStep} bps`;
      return `<option value="${i}">${label}</option>`;
    }).join('');
    selectWrap.style.display = '';
    select.onchange = () => {
      const idx = parseInt(select.value, 10);
      const pool = state.discoveredDlmmPools[idx];
      state.poolAddress = pool.address;
      state.activeBin = pool.active_id ?? pool.activeId ?? pool.active_bin_id;
      state.binStep = pool.bin_step ?? pool.binStep;
      state.currentPrice = binToPrice(state.activeBin, state.binStep, state.tokenXDecimals, state.tokenYDecimals);
      document.getElementById('currentPrice').textContent = '$' + formatPrice(state.currentPrice);
      loadUserBins();
      updateBinVizPreview();
    };
  } else if (selectWrap) {
    selectWrap.style.display = 'none';
  }

  updateSide(state.side);

  // Restore form sections in case they were hidden by createPoolPanel
  document.querySelector('.side-tabs')?.style.setProperty('display', '');
  document.querySelector('.range-section')?.style.setProperty('display', '');
  document.querySelector('.amount-section')?.style.setProperty('display', '');
  document.getElementById('createPoolPanel')?.style.setProperty('display', 'none');

  showToast(`Found ${dlmmPools.length} DLMM pool${dlmmPools.length > 1 ? 's' : ''}`, 'success');
  loadBinVizData();
  if (state.connected) refreshPositionsList();

  // Notify relay to watch these pools for bin array updates
  const poolAddresses = dlmmPools.map(p => p.address);
  relayFetch('/api/subscribe-pools', { method: 'POST', body: JSON.stringify({ pools: poolAddresses }) }).catch(() => {});
}

function showCreatePoolUI(mint, dammPools) {
  state.tokenMint = mint;
  state.discoveredDlmmPools = [];
  state.discoveredDammPools = dammPools || [];

  document.querySelector('.side-tabs').style.display = 'none';
  document.querySelector('.range-section').style.display = 'none';
  document.querySelector('.amount-section').style.display = 'none';
  const panel = document.getElementById('createPoolPanel');
  if (panel) panel.style.display = '';

  showToast('No DLMM pool found — create one to get started', 'info');

  const btn = document.getElementById('createPoolBtn');
  if (btn) btn.onclick = createDlmmPool;
}

async function createDlmmPool() {
  if (!state.connected || !state.publicKey) {
    showToast('Connect wallet first', 'error');
    return;
  }
  const btn = document.getElementById('createPoolBtn');
  const binStep = parseInt(document.getElementById('createPoolBinStep')?.value || '100', 10);
  if (btn) { btn.textContent = 'creating...'; btn.disabled = true; }

  try {
    const body = JSON.stringify({ tokenMint: state.tokenMint, quoteMint: SOL_MINT, binStep });
    const result = await relayFetch('/api/init-pool-tx', { method: 'POST', body });
    if (!result || !result.transaction) throw new Error('Failed to build pool creation transaction');

    const txBytes = Uint8Array.from(atob(result.transaction), c => c.charCodeAt(0));
    const tx = solanaWeb3.Transaction.from(txBytes);
    const conn = state.connection || new solanaWeb3.Connection(CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed');
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.feePayer = state.publicKey;

    const signed = await window.phantom?.solana?.signTransaction(tx);
    if (!signed) throw new Error('Transaction rejected by wallet');

    const sig = await conn.sendRawTransaction(signed.serialize());
    await conn.confirmTransaction(sig, 'confirmed');

    showToast('Pool created! Loading...', 'success');
    document.querySelector('.side-tabs').style.display = '';
    document.querySelector('.range-section').style.display = '';
    document.querySelector('.amount-section').style.display = '';
    document.getElementById('createPoolPanel').style.display = 'none';

    document.getElementById('poolAddress').value = result.poolAddress;
    await loadPool();
  } catch (err) {
    console.error('[createPool]', err);
    showToast(err.message || 'Pool creation failed', 'error');
  } finally {
    if (btn) { btn.textContent = 'create pool'; btn.disabled = false; }
  }
}

function renderTrendingFeed() {
  const container = document.getElementById('trendingFeed');
  if (!container) return;
  if (!state.trendingPools.length) { container.innerHTML = ''; return; }

  container.innerHTML = '<div class="ab-title">trending</div>' +
    state.trendingPools.slice(0, 8).map((p, i) => {
      const vol = formatVolume(p.volume || 0);
      return `<button class="ab-card trending-pill" data-idx="${i}" title="${p.name} · ${vol} 24h vol"><span class="ab-pair">${p.name}</span><span class="ab-count">${vol}</span></button>`;
    }).join('');

  container.querySelectorAll('.trending-pill').forEach(pill => {
    pill.addEventListener('click', async () => {
      const p = state.trendingPools[parseInt(pill.dataset.idx, 10)];
      if (!p) return;
      document.getElementById('poolAddress').value = p.mint;
      hidePoolPicker();
      const btn = document.getElementById('loadPool');
      if (btn) { btn.textContent = 'searching...'; btn.disabled = true; }
      try {
        const { dlmm, damm } = await discoverAllPoolsForToken(p.mint);
        if (dlmm.length > 0) {
          await loadAggregatedView(dlmm, damm);
        }
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        if (btn) { btn.textContent = 'load'; btn.disabled = false; }
      }
    });
  });
}

function renderPoolPicker(pools) {
  const container = document.getElementById('poolPicker');
  if (!container) return;

  container.innerHTML = pools.slice(0, 10).map(p => {
    const name = p.name || `${p.token_x?.symbol || '?'}/${p.token_y?.symbol || '?'}`;
    const isDamm = p._source === 'damm';
    const typeBadge = isDamm
      ? `<span class="picker-type damm-badge">DAMM v2</span>`
      : `<span class="picker-type dlmm-badge">DLMM · ${p.bin_step ?? p.pool_config?.bin_step ?? '?'} bps</span>`;
    const vol = formatVolume(p.volume?.['24h'] || 0);
    const tvl = formatVolume(p.tvl || p.liquidity || 0);
    return `<button class="picker-row${isDamm ? ' picker-row-damm' : ''}" data-pool="${p.address}" data-damm="${isDamm}">
      <span class="picker-name">${name}</span>
      ${typeBadge}
      <span class="picker-meta">${vol} vol · ${tvl} tvl</span>
    </button>`;
  }).join('');

  container.style.display = 'block';

  container.querySelectorAll('.picker-row').forEach(row => {
    row.addEventListener('click', () => {
      if (row.dataset.damm === 'true') {
        showToast('DAMM v2 — view only. Select a DLMM pool to open positions.', 'info');
        return;
      }
      document.getElementById('poolAddress').value = row.dataset.pool;
      hidePoolPicker();
      loadPool();
    });
  });
}

function hidePoolPicker() {
  const picker = document.getElementById('poolPicker');
  if (picker) picker.style.display = 'none';
}

function renderAddressBook() {
  const activeContainer = document.getElementById('addressBookActive');
  const recentContainer = document.getElementById('addressBookRecent');

  if (activeContainer) {
    if (state.addressBook.active.length) {
      activeContainer.innerHTML = '<div class="discovery-label">open positions</div>' +
        state.addressBook.active.map(p =>
          `<button class="addressbook-pill active-pill" data-pool="${p.pair}" title="${p.name}">
            ${p.name} <span class="pill-meta">${p.openPositions} pos</span>
          </button>`
        ).join('');
      activeContainer.querySelectorAll('.addressbook-pill').forEach(pill => {
        pill.addEventListener('click', () => {
          document.getElementById('poolAddress').value = pill.dataset.pool;
          hidePoolPicker();
          loadPool();
        });
      });
    } else {
      activeContainer.innerHTML = '';
    }
  }

  if (recentContainer) {
    if (state.addressBook.recent.length) {
      recentContainer.innerHTML = '<div class="discovery-label">recent</div>' +
        state.addressBook.recent.map(p =>
          `<button class="addressbook-pill recent-pill" data-pool="${p.pair}" title="${p.name} · ${timeAgo(p.lastActive)}">
            ${p.name} <span class="pill-meta">${timeAgo(p.lastActive)}</span>
          </button>`
        ).join('');
      recentContainer.querySelectorAll('.addressbook-pill').forEach(pill => {
        pill.addEventListener('click', () => {
          document.getElementById('poolAddress').value = pill.dataset.pool;
          hidePoolPicker();
          loadPool();
        });
      });
    } else {
      recentContainer.innerHTML = '';
    }
  }
}

async function loadAddressBook() {
  if (!state.connected || !state.publicKey) return;
  renderAddressBookPanel();
  const data = await relayFetch('/api/addressbook?wallet=' + state.publicKey.toBase58());
  if (data) {
    state.addressBook = { active: data.active || [], recent: data.recent || [], topPairs: data.topPairs || [] };
    renderAddressBook();
  }
  renderAddressBookPanel();
}

function renderAddressBookPanel() {
  const container = document.getElementById('abCards');
  if (!container) return;

  const pairs = state.addressBook.topPairs || [];
  if (pairs.length === 0) {
    container.innerHTML = `<div class="ab-empty">${state.connected ? 'no trades yet' : 'connect wallet'}</div>`;
    return;
  }

  container.innerHTML = pairs.map(p =>
    `<button class="ab-card" data-mint="${p.tokenMint}">
      <span class="ab-pair">${p.pairSymbol || p.symbol}</span>
      <span class="ab-count">${p.totalPositionsOpened} pos</span>
    </button>`
  ).join('');

  container.querySelectorAll('.ab-card').forEach(card => {
    card.addEventListener('click', () => {
      const mint = card.dataset.mint;
      document.getElementById('poolAddress').value = mint;
      loadPool();
    });
  });
}

async function loadPool() {
  const addr = document.getElementById('poolAddress')?.value.trim();
  if (!addr) { showToast('Enter a token or pool address', 'error'); return; }

  const btn = document.getElementById('loadPool');
  if (btn) { btn.textContent = 'loading...'; btn.disabled = true; }

  try {
    let pubkey;
    try { pubkey = new solanaWeb3.PublicKey(addr); }
    catch { throw new Error('Invalid Solana address'); }

    hidePoolPicker();

    // Resolve the input to a token mint for discovery.
    // Whether the user enters a token CA or a specific pool address, we always
    // discover all DLMM/DAMM pools for that token and show the aggregated view.
    let tokenMintForDiscovery = addr;
    let preferredPoolAddress = null;
    let fallbackPool = null; // used if the entered pool isn't indexed by the API

    // Step 1 — try relay (fast path for known LP pairs)
    const relayData = await relayFetch(`/api/pools/${addr}`);
    if (relayData && relayData.activeId !== undefined) {
      let xMint = relayData.tokenXMint;
      let yMint = relayData.tokenYMint;
      if (!xMint) {
        const poolData = await parseLbPairFull(addr);
        xMint = poolData.tokenXMint.toBase58();
        yMint = poolData.tokenYMint.toBase58();
      }
      tokenMintForDiscovery = [xMint, yMint].find(m => m && m !== SOL_MINT && m !== USDC_MINT) || xMint;
      preferredPoolAddress = addr;
      fallbackPool = {
        address: addr,
        active_id: relayData.activeId,
        bin_step: relayData.binStep,
        token_x: { address: xMint, symbol: relayData.tokenXSymbol || 'TOKEN' },
        token_y: { address: yMint, symbol: relayData.tokenYSymbol || 'SOL' },
      };
    } else {
      // Step 2 — try direct on-chain parse
      const conn = state.connection || new solanaWeb3.Connection(CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed');
      const accountInfo = await conn.getAccountInfo(pubkey);
      if (!accountInfo) throw new Error('Account not found — check the address');

      if (accountInfo.data.length === LBPAIR_EXPECTED_SIZE) {
        // It's a raw LP pair account
        const pool = await parseLbPair(addr);
        const xMint = pool.tokenXMint.toBase58();
        const yMint = pool.tokenYMint.toBase58();
        const [symX, symY] = await Promise.all([resolveTokenSymbol(pool.tokenXMint), resolveTokenSymbol(pool.tokenYMint)]);
        tokenMintForDiscovery = [xMint, yMint].find(m => m !== SOL_MINT && m !== USDC_MINT) || xMint;
        preferredPoolAddress = addr;
        fallbackPool = {
          address: addr,
          active_id: pool.activeId,
          bin_step: pool.binStep,
          token_x: { address: xMint, symbol: symX },
          token_y: { address: yMint, symbol: symY },
        };
      }
      // else: it's a token mint — tokenMintForDiscovery is already addr
    }

    if (btn) { btn.textContent = 'searching...'; }
    const { dlmm, damm } = await discoverAllPoolsForToken(tokenMintForDiscovery);

    // If the user entered a specific pool, make sure it's in the list.
    // Promote it to primary (index 0) if found, or inject it if the API missed it.
    if (preferredPoolAddress) {
      const idx = dlmm.findIndex(p => p.address === preferredPoolAddress);
      if (idx > 0) {
        const [preferred] = dlmm.splice(idx, 1);
        dlmm.unshift(preferred);
      } else if (idx === -1 && fallbackPool) {
        dlmm.unshift(fallbackPool);
      }
    }

    if (dlmm.length > 0) {
      await loadAggregatedView(dlmm, damm);
    } else {
      showCreatePoolUI(tokenMintForDiscovery, damm);
    }
  } catch (err) {
    console.error('Failed to load pool:', err);
    showToast(err.message, 'error');
  } finally {
    if (btn) { btn.textContent = 'load'; btn.disabled = false; }
  }
}

// ============================================================
// BIN VISUALIZATION — on-chain liquidity + preview
// ============================================================

const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const BINS_PER_ARRAY = 70;

// BinArray layout verified against Meteora DLMM IDL (idl.json):
//
// BinArray header (repr C, bytemuck):
//   8  discriminator
//   8  index (i64)
//   1  version (u8)
//   7  _padding_1 ([u8; 7])
//   32 lb_pair (pubkey)
//   = 56 bytes header
//
// Bin struct (repr C, bytemuck), 70 per array:
//   8   amount_x (u64)          offset 0
//   8   amount_y (u64)          offset 8
//   16  price (u128)            offset 16
//   16  liquidity_supply (u128) offset 32
//   32  function_bytes ([u128; 2])
//   16  fee_amount_x_per_token_stored (u128)
//   16  fee_amount_y_per_token_stored (u128)
//   16  _padding_0 (u128)
//   16  _padding_1 (u128)
//   = 144 bytes per bin
const BIN_ARRAY_HEADER = 56;
const BIN_SIZE = 144;
const BIN_AMOUNT_X_OFFSET = 0;
const BIN_AMOUNT_Y_OFFSET = 8;

function binIdToArrayIndex(binId) {
  if (binId >= 0) return Math.floor(binId / BINS_PER_ARRAY);
  return Math.floor((binId - (BINS_PER_ARRAY - 1)) / BINS_PER_ARRAY);
}

async function fetchBinArrays(poolAddress, centerBin, visibleRange) {
  const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;
  const conn = state.connection || new solanaWeb3.Connection(rpcUrl, 'confirmed');
  const poolPubkey = new solanaWeb3.PublicKey(poolAddress);
  const dlmmProgram = new solanaWeb3.PublicKey(METEORA_DLMM_PROGRAM);

  const lowBin = centerBin - visibleRange;
  const highBin = centerBin + visibleRange;
  const lowIdx = binIdToArrayIndex(lowBin);
  const highIdx = binIdToArrayIndex(highBin);

  const pdas = [];
  for (let i = lowIdx; i <= highIdx; i++) {
    // Encode i64 LE using BigInt for correct two's complement
    const signed = BigInt(i);
    const unsigned = signed < 0n ? signed + (1n << 64n) : signed;
    const buf = new Uint8Array(8);
    for (let byte = 0; byte < 8; byte++) {
      buf[byte] = Number((unsigned >> BigInt(byte * 8)) & 0xFFn);
    }
    const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('bin_array'), poolPubkey.toBytes(), buf],
      dlmmProgram
    );
    pdas.push({ pda, arrayIndex: i });
  }

  const RPC_CHUNK = 100;
  const allPdaKeys = pdas.map(p => p.pda);
  const chunks = [];
  for (let i = 0; i < allPdaKeys.length; i += RPC_CHUNK) {
    chunks.push(allPdaKeys.slice(i, i + RPC_CHUNK));
  }
  const accountChunks = await Promise.all(chunks.map(c => conn.getMultipleAccountsInfo(c)));
  const accounts = accountChunks.flat();

  const bins = new Map();
  for (let a = 0; a < accounts.length; a++) {
    const acct = accounts[a];
    if (!acct) continue;
    const data = acct.data;

    // Read the actual index from the account (i64 LE at offset 8, after 8-byte discriminator)
    const idxLo = data.readInt32LE(8);
    const idxHi = data.readInt32LE(12);
    const actualIndex = idxHi * 0x100000000 + (idxLo >>> 0);
    const baseBinId = actualIndex * BINS_PER_ARRAY;

    const expectedBinDataSize = BIN_ARRAY_HEADER + BINS_PER_ARRAY * BIN_SIZE;
    if (data.length < expectedBinDataSize) {
      if (CONFIG.DEBUG) console.warn(`BinArray ${actualIndex} unexpected size: ${data.length} (expected ${expectedBinDataSize})`);
      continue;
    }

    for (let b = 0; b < BINS_PER_ARRAY; b++) {
      const offset = BIN_ARRAY_HEADER + b * BIN_SIZE;
      const amountX = Number(data.readBigUInt64LE(offset + BIN_AMOUNT_X_OFFSET));
      const amountY = Number(data.readBigUInt64LE(offset + BIN_AMOUNT_Y_OFFSET));
      const binId = baseBinId + b;
      if (binId >= lowBin && binId <= highBin && (amountX > 0 || amountY > 0)) {
        bins.set(binId, { amountX, amountY });
      }
    }
  }
  return bins;
}

function computeBidAskPreview(amount, minBin, maxBin, activeBin) {
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

async function fetchUserPositions(poolAddress) {
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

async function fetchAllUserPositions() {
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

async function renderPositionsPage() {
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

    html += `<div class="pos-page-row">
      <span class="pos-pool">${escapeHtml(poolName)}</span>
      <span class="pos-side ${pos.side}">${pos.side}</span>
      <span class="pos-range">${minPrice} → ${maxPrice}</span>
      <span class="pos-filled">${fillPct}%<div class="pos-fill-bar"><div class="pos-fill-bar-inner ${pos.side}" style="width:${fillPct}%"></div></div></span>
      <span class="pos-amount">${(pos.initialAmount / 1e9).toFixed(4)}</span>
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

function aggregateUserBins(positions, activeBin) {
  const bins = new Map();
  for (const pos of positions) {
    const side = pos.side || 'buy';
    const remaining = Math.max(0, pos.initialAmount - (pos.harvestedAmount || 0));
    if (remaining <= 0) continue;

    // Only show unfilled bins: buy = at/below active, sell = at/above active
    const effectiveMin = side === 'sell' ? Math.max(pos.minBinId, activeBin) : pos.minBinId;
    const effectiveMax = side === 'buy' ? Math.min(pos.maxBinId, activeBin) : pos.maxBinId;
    if (effectiveMin > effectiveMax) continue;

    const preview = computeBidAskPreview(remaining, effectiveMin, effectiveMax, activeBin);
    for (const [binId, amount] of preview) {
      const entry = bins.get(binId) || { buy: 0, sell: 0 };
      entry[side] += amount;
      bins.set(binId, entry);
    }
  }
  return bins;
}

// Canvas rendering state
const vizState = {
  poolBins: new Map(),
  userBins: new Map(),
  previewBins: new Map(),
  activeBin: 0,
  binStep: 0,
  zoomPct: 20,
  logPriceMin: 0,
  logSlotStep: 0,
  slotCount: 400,
  binArrayCache: new Map(),
  fetchController: null,
};

function renderBinViz() {
  const canvas = document.getElementById('binVizCanvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  if (!wrap) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = wrap.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;

  ctx.clearRect(0, 0, W, H);

  const { poolBins, userBins, previewBins, activeBin, binStep,
          logPriceMin, logSlotStep, slotCount } = vizState;
  if (!binStep) {
    ctx.fillStyle = '#D984AC';
    ctx.font = '400 12px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('LOAD A POOL TO SEE LIQUIDITY', W / 2, H / 2);
    return;
  }

  const totalBins = slotCount;
  const activeSlot = Math.floor(totalBins / 2);

  const userSlotMap = new Map();
  const previewSlotMap = new Map();
  if (logSlotStep > 0) {
    const logStep = Math.log(1 + binStep / 10000);

    for (const [binId, amounts] of userBins) {
      const logPrice = binId * logStep;
      const slot = Math.floor((logPrice - logPriceMin) / logSlotStep);
      if (slot >= 0 && slot < totalBins) {
        const existing = userSlotMap.get(slot) || { buy: 0, sell: 0 };
        existing.buy += amounts.buy || 0;
        existing.sell += amounts.sell || 0;
        userSlotMap.set(slot, existing);
      }
    }

    for (const [binId, amount] of previewBins) {
      const logPrice = binId * logStep;
      const slot = Math.floor((logPrice - logPriceMin) / logSlotStep);
      if (slot >= 0 && slot < totalBins) {
        previewSlotMap.set(slot, Math.max(previewSlotMap.get(slot) || 0, amount));
      }
    }
  }

  let maxPoolLiq = 0;
  let maxUserLiq = 0;
  for (let slot = 0; slot < totalBins; slot++) {
    const pool = poolBins.get(slot);
    if (pool) {
      const slotPriceRaw = Math.exp(logPriceMin + slot * logSlotStep);
      const poolTotal = pool.amountX * slotPriceRaw + pool.amountY;
      maxPoolLiq = Math.max(maxPoolLiq, poolTotal);
    }
    const ub = userSlotMap.get(slot);
    const user = ub ? ub.buy + ub.sell : 0;
    const preview = previewSlotMap.get(slot) || 0;
    maxUserLiq = Math.max(maxUserLiq, user + preview);
  }
  if (maxPoolLiq === 0) maxPoolLiq = 1;
  if (maxUserLiq === 0) maxUserLiq = 1;

  const yMargin = 24;
  const xLabelWidth = 72;
  const barAreaW = W - xLabelWidth - 12;
  const barAreaH = H - yMargin * 2;
  const rowH = barAreaH / totalBins;
  const barH = Math.max(1, rowH * 0.8);
  const halfBar = barH / 2;

  const poolBuyColor = 'rgba(217, 132, 172, 0.65)';
  const poolSellColor = 'rgba(113, 75, 166, 0.70)';
  const poolNeutralColor = 'rgba(217, 132, 172, 0.40)';
  const userBuyColor = 'rgba(173, 217, 108, 1.0)';
  const userSellColor = 'rgba(24, 14, 38, 0.80)';
  const previewBuyColor = 'rgba(173, 217, 108, 0.30)';
  const previewSellColor = 'rgba(24, 14, 38, 0.20)';

  for (let slot = 0; slot < totalBins; slot++) {
    const idx = slot;
    const yCenter = yMargin + barAreaH - (idx + 0.5) * rowH;

    const pool = poolBins.get(slot);
    const slotPriceRaw = Math.exp(logPriceMin + slot * logSlotStep);
    const poolTotal = pool ? pool.amountX * slotPriceRaw + pool.amountY : 0;
    const ub = userSlotMap.get(slot);
    const userBuy = ub ? ub.buy : 0;
    const userSell = ub ? ub.sell : 0;
    const preview = previewSlotMap.get(slot) || 0;

    const colW = barAreaW * 0.46;

    // Pool bar (left column) — colored by buy/sell side relative to active slot
    if (poolTotal > 0) {
      const barW = (poolTotal / maxPoolLiq) * colW;
      if (slot < activeSlot) {
        ctx.fillStyle = poolBuyColor;
      } else if (slot > activeSlot) {
        ctx.fillStyle = poolSellColor;
      } else {
        ctx.fillStyle = poolNeutralColor;
      }
      ctx.fillRect(xLabelWidth, yCenter - halfBar, barW, barH);
    }

    // User + preview bars (right column)
    const userX = xLabelWidth + barAreaW * 0.54;
    let userDrawn = 0;

    if (userBuy > 0) {
      const barW = (userBuy / maxUserLiq) * colW;
      ctx.fillStyle = userBuyColor;
      ctx.fillRect(userX, yCenter - halfBar, barW, barH);
      userDrawn += barW;
    }
    if (userSell > 0) {
      const barW = (userSell / maxUserLiq) * colW;
      ctx.fillStyle = userSellColor;
      ctx.fillRect(userX + userDrawn, yCenter - halfBar, barW, barH);
      userDrawn += barW;
    }

    if (preview > 0) {
      const previewW = (preview / maxUserLiq) * colW;
      const isSellPreview = slot > activeSlot;
      ctx.fillStyle = isSellPreview ? previewSellColor : previewBuyColor;
      ctx.fillRect(userX + userDrawn, yCenter - halfBar, previewW, barH);
    }
  }

  // Divider line between pool and user columns
  ctx.strokeStyle = 'rgba(113, 75, 166, 0.15)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  const divX = xLabelWidth + barAreaW * 0.5;
  ctx.beginPath();
  ctx.moveTo(divX, yMargin);
  ctx.lineTo(divX, H - yMargin);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = '400 9px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#D984AC';
  ctx.fillText('POOL', xLabelWidth + barAreaW * 0.24, yMargin - 6);
  ctx.fillText('YOURS', xLabelWidth + barAreaW * 0.76, yMargin - 6);

  // Active bin line at the middle slot
  const activeY = yMargin + barAreaH - (activeSlot + 0.5) * rowH;
  ctx.strokeStyle = '#180E26';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(xLabelWidth, activeY);
  ctx.lineTo(W - 8, activeY);
  ctx.stroke();

  ctx.fillStyle = '#180E26';
  ctx.font = '500 10px "IBM Plex Mono", monospace';
  ctx.textAlign = 'right';
  const priceLabel = '$' + formatPrice(binToPrice(activeBin, binStep, state.tokenXDecimals, state.tokenYDecimals));
  ctx.fillText(priceLabel, xLabelWidth - 6, activeY + 3);

  ctx.fillStyle = '#714BA6';
  ctx.font = '400 9px "IBM Plex Mono", monospace';
  ctx.textAlign = 'right';
  const labelInterval = Math.max(5, Math.round(totalBins / 10));
  for (let slot = 0; slot < totalBins; slot += labelInterval) {
    if (slot === activeSlot) continue;
    const y = yMargin + barAreaH - (slot + 0.5) * rowH;
    const rawP = Math.exp(logPriceMin + slot * logSlotStep);
    const price = rawP * Math.pow(10, state.tokenXDecimals - state.tokenYDecimals);
    ctx.fillText('$' + formatPrice(price), xLabelWidth - 6, y + 3);
  }

  // Update header meta
  const metaEl = document.getElementById('binVizMeta');
  if (metaEl && binStep) {
    const poolCount = state.discoveredDlmmPools.length;
    const metaLabel = poolCount > 1
      ? `${poolCount} pools aggregated · ±${vizState.zoomPct}%`
      : `bin step ${binStep} · ±${vizState.zoomPct}%`;
    metaEl.textContent = metaLabel;
  }
}

function updateBinVizPreview() {
  if (!state.poolAddress || state.activeBin == null || !state.binStep) return;

  vizState.activeBin = state.activeBin;
  vizState.binStep = state.binStep;

  const amount = parseFloat(document.getElementById('amount')?.value) || 0;
  const { minBin, maxBin } = getRangeBins();
  const amountLamports = amount * 1e9;

  vizState.previewBins = computeBidAskPreview(amountLamports, minBin, maxBin, state.activeBin);
  renderBinViz();
}

async function fetchAggregatedLiquidity(dlmmPools) {
  const primary = dlmmPools[0];
  const primaryBinStep = primary.bin_step ?? primary.binStep;
  const primaryActiveId = primary.active_id ?? primary.activeId ?? primary.active_bin_id;

  const SLOT_COUNT = 400;
  const logRange = Math.log(1 + vizState.zoomPct / 100);
  const primaryLogStep = Math.log(1 + primaryBinStep / 10000);
  const logPriceCenter = primaryActiveId * primaryLogStep;
  const logPriceMin = logPriceCenter - logRange;
  const logSlotStep = (2 * logRange) / SLOT_COUNT;

  const allBinMaps = await Promise.all(
    dlmmPools.map(p => {
      const poolBinStep = p.bin_step ?? p.binStep;
      const poolActiveId = p.active_id ?? p.activeId ?? p.active_bin_id;
      const poolBinsNeeded = Math.ceil(logRange / Math.log(1 + poolBinStep / 10000));
      return fetchBinArrays(p.address, poolActiveId, poolBinsNeeded).catch(() => new Map());
    })
  );

  const merged = new Map();
  for (let i = 0; i < dlmmPools.length; i++) {
    const pool = dlmmPools[i];
    const poolBinStep = pool.bin_step ?? pool.binStep;
    const poolLogStep = Math.log(1 + poolBinStep / 10000);

    for (const [binId, amounts] of allBinMaps[i]) {
      const binLogLow = binId * poolLogStep - poolLogStep / 2;
      const binLogHigh = binId * poolLogStep + poolLogStep / 2;
      const slotLow = Math.max(0, Math.floor((binLogLow - logPriceMin) / logSlotStep));
      const slotHigh = Math.min(SLOT_COUNT - 1, Math.floor((binLogHigh - logPriceMin) / logSlotStep));
      if (slotHigh < 0 || slotLow >= SLOT_COUNT) continue;
      const span = Math.max(1, slotHigh - slotLow + 1);

      for (let s = slotLow; s <= slotHigh; s++) {
        const ex = merged.get(s) || { amountX: 0, amountY: 0 };
        ex.amountX += amounts.amountX / span;
        ex.amountY += amounts.amountY / span;
        merged.set(s, ex);
      }
    }
  }

  vizState.logPriceMin = logPriceMin;
  vizState.logSlotStep = logSlotStep;
  vizState.slotCount = SLOT_COUNT;
  return merged;
}

async function loadBinVizData() {
  if (!state.poolAddress || !state.activeBin || !state.binStep) return;

  if (vizState.fetchController) vizState.fetchController.abort();
  vizState.fetchController = new AbortController();

  vizState.activeBin = state.activeBin;
  vizState.binStep = state.binStep;

  const dlmmPools = state.discoveredDlmmPools.length > 0
    ? state.discoveredDlmmPools
    : [{ address: state.poolAddress, activeId: state.activeBin, active_id: state.activeBin, binStep: state.binStep, bin_step: state.binStep }];

  try {
    vizState.poolBins = await fetchAggregatedLiquidity(dlmmPools);
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (CONFIG.DEBUG) console.error('Failed to fetch bin arrays:', err);
    vizState.poolBins = new Map();
  }

  await loadUserBins();
  updateBinVizPreview();
}

async function loadUserBins() {
  if (!state.poolAddress) return;

  // Try real on-chain bin data from bot relay first
  if (state.publicKey) {
    try {
      const data = await relayFetch(
        `/api/user-bins?pool=${state.poolAddress}&owner=${state.publicKey.toBase58()}`
      );
      if (data && data.bins && data.bins.length > 0) {
        const map = new Map();
        for (const b of data.bins) {
          map.set(b.binId, { buy: b.buy || 0, sell: b.sell || 0 });
        }
        vizState.userBins = map;
        if (CONFIG.DEBUG) console.log('[monke] User bins from relay:', map.size);
        return;
      }
    } catch (e) {
      if (CONFIG.DEBUG) console.warn('[monke] Relay user-bins failed, falling back to synthetic:', e);
    }
  }

  // Fallback: synthetic approximation from on-chain position accounts
  try {
    const positions = await fetchUserPositions(state.poolAddress);
    vizState.userBins = aggregateUserBins(positions, state.activeBin);
  } catch {
    vizState.userBins = new Map();
  }
}

// ============================================================
// POSITION CREATION
// ============================================================

async function createPosition() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  if (!state.poolAddress) { showToast('Load a pool first', 'error'); return; }

  const amount = parseFloat(document.getElementById('amount')?.value);
  if (!amount || amount <= 0) { showToast('Enter a valid amount', 'error'); return; }

  const { minBin, maxBin } = getRangeBins();

  if (state.side === 'buy' && maxBin >= state.activeBin) {
    showToast('Buy range must be below current price', 'error'); return;
  }
  if (state.side === 'sell' && minBin <= state.activeBin) {
    showToast('Sell range must be above current price', 'error'); return;
  }

  const btn = document.getElementById('actionBtn');
  const original = btn?.textContent;
  if (btn) { btn.textContent = 'creating...'; btn.disabled = true; }

  try {
    showToast('Building transaction...', 'info');

    const decimals = state.side === 'sell' ? state.tokenXDecimals : state.tokenYDecimals;
    const depositAmount = BigInt(Math.round(amount * Math.pow(10, decimals)));
    const numBins = maxBin - minBin + 1;

    if (CONFIG.DEBUG) {
      console.log(`[monke] Create ${state.side} position`);
      console.log(`  Amount: ${amount} (${depositAmount} lamports, ${decimals} decimals)`);
      console.log(`  Bins: ${minBin} -> ${maxBin} (${numBins} bins)`);
    }

    const conn = state.connection;
    const user = state.publicKey;
    const coreProgramId = new solanaWeb3.PublicKey(CONFIG.CORE_PROGRAM_ID);

    // Resolve all Meteora CPI accounts from on-chain pool data
    showToast('Resolving accounts...', 'info');
    const cpi = await resolveMeteoraCPIAccounts(state.poolAddress, minBin, maxBin);

    // Deposit token: sell = token X, buy = token Y (SOL)
    const depositMint = state.side === 'sell' ? cpi.tokenXMint : cpi.tokenYMint;
    const depositTokenProgramId = state.side === 'sell' ? cpi.tokenXProgramId : cpi.tokenYProgramId;

    // Derive meteora position as PDA (single-signer: no keypair needed)
    const [counterPDA] = getPositionCounterPDA(user, cpi.lbPair);
    let posCounter = 0;
    try {
      const counterInfo = await conn.getAccountInfo(counterPDA);
      if (counterInfo && counterInfo.data.length >= 16) {
        posCounter = Number(new DataView(counterInfo.data.buffer, counterInfo.data.byteOffset).getBigUint64(8, true));
      }
    } catch { /* counter doesn't exist yet — first position, count = 0 */ }
    const [meteoraPositionPDA] = getMeteoraPosiitonPDA(user, cpi.lbPair, posCounter);

    const [configPDA] = getConfigPDA();
    const [positionPDA] = getPositionPDA(meteoraPositionPDA);
    const [vaultPDA] = getVaultPDA(meteoraPositionPDA);

    const userTokenAccount = getAssociatedTokenAddressSync(depositMint, user, false, depositTokenProgramId);

    const vaultTokenX = getAssociatedTokenAddressSync(cpi.tokenXMint, vaultPDA, true, cpi.tokenXProgramId);
    const vaultTokenY = getAssociatedTokenAddressSync(cpi.tokenYMint, vaultPDA, true, cpi.tokenYProgramId);

    // --- Setup TX: ATAs, bin arrays, SOL wrapping (standard SPL ops only) ---
    const isNativeSol = depositMint.equals(NATIVE_MINT);
    const initBinArrayIxs = await ensureBinArraysExist(cpi.lbPair, minBin, maxBin, user, cpi.dlmmProgram);
    const extraSetupIxs = [...initBinArrayIxs];
    if (isNativeSol) extraSetupIxs.push(...buildWrapSolIxs(user, userTokenAccount, depositAmount));

    await ensureAccountsSetup(conn, user, [
      { ata: userTokenAccount, owner: user, mint: depositMint, tokenProgram: depositTokenProgramId },
      { ata: vaultTokenX, owner: vaultPDA, mint: cpi.tokenXMint, tokenProgram: cpi.tokenXProgramId },
      { ata: vaultTokenY, owner: vaultPDA, mint: cpi.tokenYMint, tokenProgram: cpi.tokenYProgramId },
    ], extraSetupIxs);

    // --- Execute TX: compute budget + openPositionV2 only ---
    const slippage = state.binStep >= 80 ? 15 : 5;
    const bitmapExtWritable = !cpi.binArrayBitmapExt.equals(cpi.dlmmProgram);

    if (CONFIG.DEBUG) console.log('[monke] Open position V2:', { amount: depositAmount.toString(), minBin, maxBin });

    const openIx = await getOpenPositionV2InstructionAsync({
      user: asSigner(user),
      lbPair: address(cpi.lbPair.toBase58()),
      positionCounter: address(counterPDA.toBase58()),
      meteoraPosition: address(meteoraPositionPDA.toBase58()),
      binArrayBitmapExt: address(cpi.binArrayBitmapExt.toBase58()),
      reserveX: address(cpi.reserveX.toBase58()),
      reserveY: address(cpi.reserveY.toBase58()),
      userTokenAccount: address(userTokenAccount.toBase58()),
      vaultTokenX: address(vaultTokenX.toBase58()),
      vaultTokenY: address(vaultTokenY.toBase58()),
      tokenXProgram: address(cpi.tokenXProgramId.toBase58()),
      tokenYProgram: address(cpi.tokenYProgramId.toBase58()),
      binArrayLower: address(cpi.binArrayLower.toBase58()),
      binArrayUpper: address(cpi.binArrayUpper.toBase58()),
      eventAuthority: address(cpi.eventAuthority.toBase58()),
      dlmmProgram: address(cpi.dlmmProgram.toBase58()),
      tokenXMint: address(cpi.tokenXMint.toBase58()),
      tokenYMint: address(cpi.tokenYMint.toBase58()),
      amount: BigInt(depositAmount.toString()),
      minBinId: minBin,
      maxBinId: maxBin,
      side: state.side === 'buy' ? Side.Buy : Side.Sell,
      maxActiveBinSlippage: slippage,
    });
    const openWeb3Ix = kitIxToWeb3(openIx);
    if (bitmapExtWritable) {
      const bmIdx = openWeb3Ix.keys.findIndex(k => k.pubkey.equals(cpi.binArrayBitmapExt));
      if (bmIdx >= 0) openWeb3Ix.keys[bmIdx].isWritable = true;
    }

    const altAccount = await getPoolALT();

    const ixs = [
      solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS),
      openWeb3Ix,
    ];

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const messageV0 = new solanaWeb3.TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message([altAccount]);

    const vtx = new solanaWeb3.VersionedTransaction(messageV0);

    // No pre-signing — single signer (user wallet only). Lighthouse can inject guards.
    showToast('Approve in wallet...', 'info');
    const result = await phantomSDK.solana.signAndSendTransaction(vtx);
    const sig = result?.signature || result?.hash || (typeof result === 'string' ? result : undefined);
    if (!sig) throw new Error('Wallet returned no transaction signature');
    showToast('Confirming...', 'info');
    await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);

    showToast('Position created!', 'success');
    if (CONFIG.DEBUG) console.log(`[monke] Position tx: ${sig}`);

    await refreshPositionsList();
    loadBinVizData();
    if (state.currentPage === 1) renderPositionsPage();
  } catch (err) {
    console.error('Position creation failed:', err);
    showToast('Failed: ' + (err?.message || err), 'error');
  } finally {
    if (btn) { btn.textContent = original; btn.disabled = false; }
  }
}

// ============================================================
// POSITIONS LIST
// ============================================================

async function refreshPositionsList() {
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

function updatePositionsList() {
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

async function closePosition(index) {
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
async function closePositionDirect(pos) {
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

  showToast('Approve in wallet...', 'info');
  const result = await phantomSDK.solana.signAndSendTransaction(vtx);
  const sig = result?.signature || result?.hash || (typeof result === 'string' ? result : undefined);
  if (!sig) throw new Error('Wallet returned no transaction signature');
  showToast('Confirming...', 'info');
  await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);
  if (CONFIG.DEBUG) console.log(`[monke] Close tx: ${sig}`);
}

async function claimFeesDirect(pos) {
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
// RANK PAGE — Monke + Roster (stub — wired to live data in later phase)
// ============================================================

let burnFireRAF = null;
function initBurnFireCanvas() {
  const canvas = document.getElementById('burnFireCanvas');
  if (!canvas) return;
  const S = 4;
  const W = 16, H = 16;
  const CW = W * S, CH = H * S;
  canvas.width = CW; canvas.height = CH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const pal = [
    [24, 14, 38],
    [70, 30, 90], [113, 75, 166], [180, 100, 160],
    [217, 132, 172], [242, 182, 198], [242, 210, 220],
    [242, 224, 208], [220, 235, 180], [173, 217, 108],
  ];

  const fire = new Float32Array(W * H);
  const stars = [];
  let t = 0, last = 0;

  function step(ts) {
    if (ts - last < 70) { burnFireRAF = requestAnimationFrame(step); return; }
    last = ts; t++;

    const sway = Math.sin(t * 0.05) * 0.5;

    for (let x = 0; x < W; x++) {
      const cx = (x - W / 2) / (W / 2);
      const shape = Math.max(0, 1 - cx * cx * 1.2);
      const flicker = Math.sin(t * 0.25 + x * 1.3) * 0.4;
      fire[(H - 1) * W + x] = Math.random() < shape * 0.9
        ? 6.5 + Math.random() * 3 + flicker
        : shape * 2 * Math.random();
    }

    for (let y = 0; y < H - 1; y++) {
      for (let x = 0; x < W; x++) {
        const srcVal = fire[(y + 1) * W + x];
        if (srcVal < 0.2) { fire[y * W + x] *= 0.4; continue; }

        let drift = 0;
        if (Math.random() < 0.4) drift = Math.random() < 0.5 ? -1 : 1;
        if (Math.random() < 0.2) drift += sway > 0 ? 1 : -1;
        const dx = Math.min(W - 1, Math.max(0, x + drift));

        const ny = y / H;
        const taper = 1 - ny;
        const decay = 0.25 + ny * 0.25 + Math.random() * 0.1;
        const turb = Math.sin(t * 0.3 + x * 1.5 + y * 0.8) * 0.08;
        fire[y * W + dx] = Math.max(0, srcVal - decay + turb) * (0.85 + taper * 0.15);
      }
    }

    if (Math.random() < 0.5) {
      const sx = 4 + Math.floor(Math.random() * (W - 8));
      stars.push({
        x: sx, y: H - 2,
        vx: (Math.random() - 0.5) * 0.3 + sway * 0.15,
        vy: -(0.3 + Math.random() * 0.5),
        life: 8 + Math.random() * 14,
        phase: Math.random() * 6.28,
      });
    }
    for (let i = stars.length - 1; i >= 0; i--) {
      const s = stars[i];
      s.x += s.vx; s.y += s.vy;
      s.vy -= 0.01; s.vx += sway * 0.005;
      s.life--;
      if (s.life <= 0 || s.x < 0 || s.x >= W || s.y < 0) { stars.splice(i, 1); continue; }
      const px = Math.floor(s.x), py = Math.floor(s.y);
      if (py >= 0 && py < H && px >= 0 && px < W) {
        const twinkle = Math.sin(t * 0.8 + s.phase) * 0.5 + 0.5;
        fire[py * W + px] = Math.max(fire[py * W + px], 7 + twinkle * 2.5);
      }
    }

    const img = ctx.createImageData(CW, CH);
    for (let gy = 0; gy < H; gy++) {
      for (let gx = 0; gx < W; gx++) {
        const v = fire[gy * W + gx];
        let r, g, b, a;
        if (v < 0.15) { r = 0; g = 0; b = 0; a = 0; }
        else {
          const scaled = v * ((pal.length - 1) / 9);
          const ci = Math.min(Math.floor(scaled), pal.length - 2);
          const frac = scaled - ci;
          const c0 = pal[ci], c1 = pal[Math.min(ci + 1, pal.length - 1)];
          r = c0[0] + (c1[0] - c0[0]) * frac;
          g = c0[1] + (c1[1] - c0[1]) * frac;
          b = c0[2] + (c1[2] - c0[2]) * frac;
          a = v > 0.5 ? 255 : v * (255 / 0.5);
        }
        for (let py = 0; py < S; py++) {
          for (let px = 0; px < S; px++) {
            const off = ((gy * S + py) * CW + (gx * S + px)) * 4;
            img.data[off] = r; img.data[off + 1] = g;
            img.data[off + 2] = b; img.data[off + 3] = a;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    burnFireRAF = requestAnimationFrame(step);
  }

  if (burnFireRAF) cancelAnimationFrame(burnFireRAF);
  burnFireRAF = requestAnimationFrame(step);
}

function renderCarouselFrame(nfts, idx) {
  const frame = document.getElementById('nftFrame');
  const counter = document.getElementById('nftCounter');
  const prevBtn = document.getElementById('nftPrev');
  const nextBtn = document.getElementById('nftNext');
  if (!frame) return;

  const nft = nfts[idx];
  const weightLabel = nft.weight > 0 ? `wt: ${nft.weight}` : '';
  const rewardTk = CONFIG.PEGGED_MINT ? '$PEGGED' : 'SOL';
  const claimLabel = nft.pendingSol > 0n ? `${(Number(nft.pendingSol) / 1e9).toFixed(4)} ${rewardTk}` : '';
  frame.innerHTML = `
    <img src="${escapeHtml(nft.image || '')}" alt="${escapeHtml(nft.name || 'monke')}" loading="eager" fetchpriority="high" decoding="async" onerror="this.style.display='none'">
    <span class="nft-gen-tag ${nft.gen === 'goose' ? 'goose' : nft.gen === 2 ? 'gen2' : 'gen3'}">${nft.gen === 'goose' ? 'goose' : nft.gen === 2 ? 'g2' : 'g3'}</span>
    ${weightLabel || claimLabel ? `<span class="nft-burn-info">${weightLabel}${weightLabel && claimLabel ? ' · ' : ''}${claimLabel}</span>` : ''}`;

  if (counter) counter.textContent = nfts.length > 1 ? `${idx + 1} / ${nfts.length}` : '';
  if (prevBtn) prevBtn.style.display = nfts.length > 1 ? '' : 'none';
  if (nextBtn) nextBtn.style.display = nfts.length > 1 ? '' : 'none';

  selectMonke(nft);
}

async function enrichNftsWithBurnData(nfts) {
  if (!state.connection || nfts.length === 0) return;
  try {
    const burnPDAs = nfts.map(nft => getMonkeBurnPDA(new solanaWeb3.PublicKey(nft.mint))[0]);
    const [monkeStateInfo, ...burnInfos] = await state.connection.getMultipleAccountsInfo([
      getMonkeStatePDA()[0], ...burnPDAs
    ]);

    const monkeState = monkeStateInfo ? decodeMonkeState(toEncodedAccount(getMonkeStatePDA()[0], monkeStateInfo.data, MONKE_BANANAS_PROGRAM_ADDRESS)).data : null;
    state.monkeStateData = monkeState;

    nfts.forEach((nft, i) => {
      const info = burnInfos[i];
      if (info) {
        const burn = decodeMonkeBurn(toEncodedAccount(burnPDAs[i], info.data, MONKE_BANANAS_PROGRAM_ADDRESS)).data;
        if (burn) {
          nft.weight = Number(burn.shareWeight);
          nft.pendingSol = monkeState ? computePendingClaim(burn, monkeState) : 0n;
          nft.claimedSol = burn.claimedSol;
          nft.claimable = (Number(nft.pendingSol) / 1e9).toFixed(4);
          nft.hasBurn = true;
          return;
        }
      }
      nft.weight = 0;
      nft.pendingSol = 0n;
      nft.claimedSol = 0n;
      nft.claimable = '0';
      nft.hasBurn = false;
    });
  } catch (err) {
    console.warn('[monke] MonkeBurn fetch failed:', err.message);
  }
}

async function updateUserMonkeStats(nfts) {
  const el = id => document.getElementById(id);
  const totalWeight = nfts.reduce((s, n) => s + (n.weight || 0), 0);
  const totalPending = nfts.reduce((s, n) => s + Number(n.pendingSol || 0n), 0);
  const totalClaimed = nfts.reduce((s, n) => s + Number(n.claimedSol || 0n), 0);

  if (el('userTotalWeight')) el('userTotalWeight').textContent = totalWeight.toLocaleString();
  const rewardToken = CONFIG.PEGGED_MINT ? '$PEGGED' : 'SOL';
  if (el('userClaimable')) el('userClaimable').textContent = (totalPending / 1e9).toFixed(4) + ' ' + rewardToken;
  if (el('userTotalClaimed')) el('userTotalClaimed').textContent = (totalClaimed / 1e9).toFixed(4) + ' ' + rewardToken;

  const globalWeight = state.monkeStateData ? Number(state.monkeStateData.totalShareWeight) : 0;
  if (el('userRewardShare')) el('userRewardShare').textContent = globalWeight > 0 ? (totalWeight / globalWeight * 100).toFixed(2) + '%' : '0%';

  const totalFees = totalPending + totalClaimed;
  if (el('userTotalFees')) el('userTotalFees').textContent = (totalFees / 1e9).toFixed(4) + ' ' + rewardToken;

  if (state.connected && state.publicKey) {
    try {
      const conn = state.connection || new solanaWeb3.Connection(CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed');
      const bananasMint = new solanaWeb3.PublicKey(CONFIG.BANANAS_MINT);
      const userBananasAta = getAssociatedTokenAddressSync(bananasMint, state.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const ataInfo = await conn.getAccountInfo(userBananasAta);
      if (ataInfo) {
        const data = new Uint8Array(ataInfo.data);
        const amount = new DataView(data.buffer, data.byteOffset).getBigUint64(64, true);
        if (el('bananasBalance')) el('bananasBalance').textContent = (Number(amount) / 1e6).toLocaleString();
      } else {
        if (el('bananasBalance')) el('bananasBalance').textContent = '0';
      }
    } catch (err) {
      console.warn('[monke] Bananas balance fetch failed:', err.message);
    }
  }
}

async function renderMonkeList() {
  const container = document.getElementById('monkeList');
  const frame = document.getElementById('nftFrame');
  const counter = document.getElementById('nftCounter');
  const prevBtn = document.getElementById('nftPrev');
  const nextBtn = document.getElementById('nftNext');
  if (!container) return;

  const hideCarouselNav = () => {
    if (counter) counter.textContent = '';
    if (prevBtn) prevBtn.style.display = 'none';
    if (nextBtn) nextBtn.style.display = 'none';
  };

  if (!state.connected) {
    container.innerHTML = '<div class="empty-state">connect wallet to view your monkes</div>';
    if (frame) frame.innerHTML = '<div class="empty-state" style="padding:20px;">connect wallet</div>';
    hideCarouselNav();
    return;
  }

  container.innerHTML = '<div class="empty-state">scanning...</div>';
  if (frame) frame.innerHTML = '<div class="empty-state" style="padding:20px;">scanning...</div>';
  hideCarouselNav();

  let nfts = await fetchSMBNfts();
  await enrichNftsWithBurnData(nfts);

  // Once-in-always-in: filter out gooseswtf that have never been fed AND have no GooseDAO membership
  nfts = nfts.filter(nft => {
    if (nft.gen !== 'goose') return true;
    if (nft.gooseDaoAsset) return true;      // has current GooseDAO membership
    if (nft.hasBurn) return true;             // already fed before (once in, always in)
    return false;
  });

  state.monkeNfts = nfts;

  if (nfts.length === 0) {
    container.innerHTML = '';
    if (frame) frame.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center;"><span style="font-size:13px;color:var(--steel-dim);line-height:1.6;font-weight:400;letter-spacing:0.02em;">crank.money works best if you own a monke. May we suggest purchasing an <a href="https://magiceden.io/marketplace/smb_gen3" target="_blank" rel="noopener" style="color:var(--nerv-orange);text-decoration:none;">SMB GEN3 on Magic Eden</a>.</span></div>';
    hideCarouselNav();
    return;
  }

  state.currentNftIndex = 0;
  renderCarouselFrame(nfts, 0);

  if (prevBtn) {
    prevBtn.onclick = () => {
      if (state.currentNftIndex > 0) {
        state.currentNftIndex--;
        renderCarouselFrame(nfts, state.currentNftIndex);
      }
    };
  }
  if (nextBtn) {
    nextBtn.onclick = () => {
      if (state.currentNftIndex < nfts.length - 1) {
        state.currentNftIndex++;
        renderCarouselFrame(nfts, state.currentNftIndex);
      }
    };
  }

  // Populate list (right panel)
  container.innerHTML = nfts.map((nft, i) => `
    <div class="monke-row${i === 0 ? ' selected' : ''}" data-mint="${escapeHtml(nft.mint)}" data-idx="${i}">
      <span class="row-chevron">&#9654;</span>
      <span>${escapeHtml(nft.name || nft.mint.slice(0, 8) + '...')}</span>
      <span class="gen-badge ${nft.gen === 'goose' ? 'goose' : nft.gen === 2 ? 'gen2' : 'gen3'}">${nft.gen === 'goose' ? 'goose' : 'gen' + nft.gen}</span>
      <span>${nft.weight || 0}</span>
      <span class="claimable">${nft.claimable || '0'} ${CONFIG.PEGGED_MINT ? '$PEGGED' : 'SOL'}</span>
      <button class="action-btn-sm" data-mint="${escapeHtml(nft.mint)}" data-action="claim" ${nft.hasBurn && nft.pendingSol > 0n ? '' : 'disabled style="opacity:0.25;cursor:default;"'}>claim</button>
    </div>
  `).join('');

  container.querySelectorAll('.monke-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="claim"]')) return;
      const idx = parseInt(row.dataset.idx, 10);
      state.nftCarouselIdx = idx;
      renderCarouselFrame(nfts, idx);
      highlightMonkeRow(row.dataset.mint);
    });
  });

  container.querySelectorAll('[data-action="claim"]').forEach(btn => {
    btn.addEventListener('click', () => handleClaimMonke(btn.dataset.mint));
  });

  updateUserMonkeStats(nfts);
  initBurnFireCanvas();
  highlightMonkeRow(nfts[0]?.mint);
}

function selectMonke(nft) {
  const nameEl = document.getElementById('nftSelectedName');
  const genEl = document.getElementById('nftSelectedGen');
  const infoEl = document.getElementById('nftSelectedInfo');
  if (infoEl) infoEl.style.display = '';
  if (nameEl) nameEl.textContent = nft.name || nft.mint.slice(0, 12) + '...';
  if (genEl) {
    const label = nft.gen === 'goose' ? 'goose' : 'gen' + nft.gen;
    genEl.textContent = label + ' (1x weight)';
  }
  state.selectedMonkeMint = nft.mint;
  highlightMonkeRow(nft.mint);
}

function highlightMonkeRow(mint) {
  const container = document.getElementById('monkeList');
  if (!container) return;
  container.querySelectorAll('.monke-row').forEach(row => {
    row.classList.toggle('selected', row.dataset.mint === mint);
  });
}

async function fetchSMBNfts() {
  if (!state.connection || !state.publicKey) return [];
  const rpcUrl = CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL;

  try {
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'monke-nfts', method: 'getAssetsByOwner',
        params: {
          ownerAddress: state.publicKey.toString(),
          page: 1, limit: 100,
          displayOptions: { showCollectionMetadata: true },
        },
      }),
    });
    const data = await resp.json();
    const items = data?.result?.items || [];
    if (CONFIG.DEBUG) console.log('[monke] DAS assets:', items.length, items.map(i => ({ id: i.id, links: i.content?.links, files: i.content?.files, json_uri: i.content?.json_uri })));

    const gen2Collection = CONFIG.SMB_COLLECTION;
    const gen3Collection = CONFIG.SMB_GEN3_COLLECTION;
    const goosePixelCollection = CONFIG.GOOSE_PIXEL_COLLECTION;
    const gooseDaoCollection = CONFIG.GOOSE_DAO_COLLECTION;
    const monkes = [];
    const gooseCandidates = [];

    // Detect GooseDAO Core membership from the same DAS response (zero extra RPC calls)
    let gooseDaoAssetId = null;
    for (const item of items) {
      const collection = item.grouping?.find(g => g.group_key === 'collection')?.group_value;
      if (collection === gooseDaoCollection) {
        gooseDaoAssetId = item.id;
        break;
      }
    }

    for (const item of items) {
      const collection = item.grouping?.find(g => g.group_key === 'collection')?.group_value;
      let gen = 0;
      let isGoose = false;
      if (collection === gen2Collection) gen = 2;
      else if (collection === gen3Collection) gen = 3;
      else if (collection === goosePixelCollection) isGoose = true;
      if (gen === 0 && !isGoose) continue;

      let image = item.content?.links?.image || '';
      if (!image) {
        const files = item.content?.files || [];
        for (const f of files) {
          const candidate = f.cdn_uri || f.uri || '';
          if (candidate && (candidate.endsWith('.png') || candidate.endsWith('.jpg') || candidate.endsWith('.gif') || candidate.endsWith('.webp') || candidate.includes('image'))) {
            image = candidate; break;
          }
        }
        if (!image && files.length > 0) image = files[0].cdn_uri || files[0].uri || '';
      }

      const nftEntry = {
        mint: item.id,
        name: item.content?.metadata?.name || '',
        image,
        json_uri: item.content?.json_uri || '',
        gen: isGoose ? 'goose' : gen,
        weight: 0,
        claimable: '0',
        gooseDaoAsset: isGoose ? gooseDaoAssetId : null,
      };

      if (isGoose) {
        gooseCandidates.push(nftEntry);
      } else {
        monkes.push(nftEntry);
      }
    }

    // Include goose candidates that either have GooseDAO membership or will be filtered
    // after enrichNftsWithBurnData (once-in-always-in: already-fed geese kept regardless)
    monkes.push(...gooseCandidates);

    // Resolve missing images from off-chain JSON metadata
    const needsResolve = monkes.filter(m => !m.image && m.json_uri);
    if (needsResolve.length > 0) {
      await Promise.allSettled(needsResolve.map(async m => {
        try {
          const r = await fetch(m.json_uri);
          const meta = await r.json();
          m.image = meta.image || meta.properties?.files?.[0]?.uri || '';
        } catch {}
      }));
    }

    return monkes;
  } catch (err) {
    console.warn('[monke] NFT fetch failed:', err.message);
    return [];
  }
}

async function renderGlobalStats() {
  try {
    const conn = state.connection || new solanaWeb3.Connection(CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed');
    const [monkeStatePDA] = getMonkeStatePDA();
    const info = await conn.getAccountInfo(monkeStatePDA);
    if (!info) return;
    const ms = decodeMonkeState(toEncodedAccount(monkeStatePDA, info.data, MONKE_BANANAS_PROGRAM_ADDRESS)).data;
    if (!ms) return;
    const el = id => document.getElementById(id);
    if (el('globalBananasBurned')) el('globalBananasBurned').textContent = (Number(ms.totalBananasBurned) / 1e6).toLocaleString() + ' $CRANK';
    if (el('globalTotalWeight')) el('globalTotalWeight').textContent = Number(ms.totalShareWeight).toLocaleString();
    const distToken = CONFIG.PEGGED_MINT ? '$PEGGED' : 'SOL';
    if (el('globalSolDistributed')) el('globalSolDistributed').textContent = (Number(ms.totalSolDistributed) / 1e9).toFixed(4) + ' ' + distToken;
  } catch (err) {
    console.warn('[monke] Global stats fetch failed:', err.message);
  }
}

async function renderRoster() {
  const container = document.getElementById('rosterList');
  if (!container) return;
  container.innerHTML = '<div class="empty-state">loading roster...</div>';

  try {
    const conn = state.connection || new solanaWeb3.Connection(CONFIG.HELIUS_RPC_URL || CONFIG.RPC_URL, 'confirmed');
    const monkeBananasProgramId = new solanaWeb3.PublicKey(CONFIG.MONKE_BANANAS_PROGRAM_ID);
    const MONKE_BURN_DISC_B58 = 'HSeFS7MzwFQ';

    const accounts = await conn.getProgramAccounts(monkeBananasProgramId, {
      filters: [{ memcmp: { offset: 0, bytes: MONKE_BURN_DISC_B58 } }],
    });

    if (accounts.length === 0) {
      container.innerHTML = '<div class="empty-state">no monkes have been fed yet</div>';
      return;
    }

    const entries = accounts.map(({ pubkey, account }) => {
      const burn = decodeMonkeBurn(toEncodedAccount(pubkey, account.data, MONKE_BANANAS_PROGRAM_ADDRESS)).data;
      if (!burn) return null;
      return { mint: burn.nftMint, weight: Number(burn.shareWeight), claimed: Number(burn.claimedSol) / 1e9 };
    }).filter(Boolean).sort((a, b) => b.weight - a.weight);

    container.innerHTML = entries.map((e, i) => `
      <div class="roster-row">
        <span class="roster-rank">${i + 1}</span>
        <span class="roster-mint">${e.mint.slice(0, 4)}...${e.mint.slice(-4)}</span>
        <span class="roster-weight">${e.weight}</span>
        <span class="roster-claimed">${e.claimed.toFixed(4)} ${CONFIG.PEGGED_MINT ? '$PEGGED' : 'SOL'}</span>
      </div>
    `).join('');
  } catch (err) {
    console.warn('[monke] Roster fetch failed:', err.message);
    container.innerHTML = '<div class="empty-state">failed to load roster</div>';
  }
}

function handleMonkeBurnLookup() {
  const mint = document.getElementById('monkeBurnLookup')?.value.trim();
  const container = document.getElementById('monkeBurnResult');
  if (!container) return;
  if (!mint) { container.innerHTML = ''; return; }
  container.innerHTML = '<div class="empty-state">MonkeBurn lookup requires deployed programs</div>';
}

// ============================================================
// RANK ACTIONS — feed_monke, claim, claim_all
// ============================================================

async function handleFeedMonke(nftMintStr) {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  const conn = state.connection;
  const user = state.publicKey;
  const nftMint = new solanaWeb3.PublicKey(nftMintStr);
  const bananasMint = new solanaWeb3.PublicKey(CONFIG.BANANAS_MINT);

  try {
    const [metadataPDA] = getMetadataPDA(nftMint);
    const userNftAccount = getAssociatedTokenAddressSync(nftMint, user);
    const userBananasAccount = getAssociatedTokenAddressSync(bananasMint, user, false, TOKEN_2022_PROGRAM_ID);

    const tx = new solanaWeb3.Transaction();
    tx.add(solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS));
    const feedIx = await getFeedMonkeInstructionAsync({
      user: asSigner(user),
      nftMint: address(nftMint.toBase58()),
      nftMetadata: address(metadataPDA.toBase58()),
      userNftAccount: address(userNftAccount.toBase58()),
      userBananasAccount: address(userBananasAccount.toBase58()),
      bananasMint: address(bananasMint.toBase58()),
      tokenProgram: address(TOKEN_2022_PROGRAM_ID.toBase58()),
    });
    tx.add(kitIxToWeb3(feedIx));

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = user;

    showToast('Approve in wallet...', 'info');
    const sig = await walletSendTransaction(tx);
    showToast('Confirming burn...', 'info');
    await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);
    showToast('1M $CRANK burned!', 'success');
    renderMonkeList();
  } catch (err) {
    console.error('[monke] feed_monke failed:', err);
    showToast('Feed failed: ' + (err?.message || err), 'error');
  }
}

async function handleFeedGoose(nftMintStr) {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  const conn = state.connection;
  const user = state.publicKey;
  const gooseNftMint = new solanaWeb3.PublicKey(nftMintStr);
  const bananasMint = new solanaWeb3.PublicKey(CONFIG.BANANAS_MINT);

  const nftData = (state.monkeNfts || []).find(n => n.mint === nftMintStr);
  // Use GooseDAO Core asset if available, otherwise SystemProgram as placeholder (already-fed geese)
  const gooseDaoAssetStr = nftData?.gooseDaoAsset || '11111111111111111111111111111111';

  try {
    const [metadataPDA] = getMetadataPDA(gooseNftMint);
    const userGooseNftAccount = getAssociatedTokenAddressSync(gooseNftMint, user);
    const userBananasAccount = getAssociatedTokenAddressSync(bananasMint, user, false, TOKEN_2022_PROGRAM_ID);

    const tx = new solanaWeb3.Transaction();
    tx.add(solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS));
    const feedIx = await getFeedGooseInstructionAsync({
      user: asSigner(user),
      gooseNftMint: address(gooseNftMint.toBase58()),
      gooseNftMetadata: address(metadataPDA.toBase58()),
      userGooseNftAccount: address(userGooseNftAccount.toBase58()),
      gooseDaoAsset: address(gooseDaoAssetStr),
      userBananasAccount: address(userBananasAccount.toBase58()),
      bananasMint: address(bananasMint.toBase58()),
      tokenProgram: address(TOKEN_2022_PROGRAM_ID.toBase58()),
    });
    tx.add(kitIxToWeb3(feedIx));

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = user;

    showToast('Approve in wallet...', 'info');
    const sig = await walletSendTransaction(tx);
    showToast('Confirming burn...', 'info');
    await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);
    showToast('1M $CRANK burned!', 'success');
    renderMonkeList();
  } catch (err) {
    console.error('[monke] feed_goose failed:', err);
    showToast('Feed failed: ' + (err?.message || err), 'error');
  }
}

async function handleClaimMonke(nftMintStr) {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  const nftData = (state.monkeNfts || []).find(n => n.mint === nftMintStr);
  if (!nftData || !nftData.hasBurn || nftData.pendingSol <= 0n) {
    showToast('Nothing to claim for this monke', 'info'); return;
  }
  const conn = state.connection;
  const user = state.publicKey;
  const nftMint = new solanaWeb3.PublicKey(nftMintStr);
  const usePegged = !!CONFIG.PEGGED_MINT;

  try {
    const [monkeBurnPDA] = getMonkeBurnPDA(nftMint);
    const userNftAccount = getAssociatedTokenAddressSync(nftMint, user);

    const tx = new solanaWeb3.Transaction();
    tx.add(solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS));

    if (usePegged) {
      const peggedMint = new solanaWeb3.PublicKey(CONFIG.PEGGED_MINT);
      const [programVaultPDA] = getProgramVaultPDA();
      const programVaultAta = getAssociatedTokenAddressSync(peggedMint, programVaultPDA, true);
      const userPeggedAta = getAssociatedTokenAddressSync(peggedMint, user);
      await ensureAccountsSetup(conn, user, [
        { ata: userPeggedAta, owner: user, mint: peggedMint, tokenProgram: TOKEN_PROGRAM_ID },
      ]);
      const claimIx = await getClaimPeggedInstructionAsync({
        user: asSigner(user),
        monkeBurn: address(monkeBurnPDA.toBase58()),
        userNftAccount: address(userNftAccount.toBase58()),
        programVaultPeggedAta: address(programVaultAta.toBase58()),
        userPeggedAta: address(userPeggedAta.toBase58()),
      });
      tx.add(kitIxToWeb3(claimIx));
    } else {
      const claimIx = await getClaimInstructionAsync({
        user: asSigner(user),
        monkeBurn: address(monkeBurnPDA.toBase58()),
        userNftAccount: address(userNftAccount.toBase58()),
      });
      tx.add(kitIxToWeb3(claimIx));
    }

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;
    tx.feePayer = user;

    showToast('Approve in wallet...', 'info');
    const sig = await walletSendTransaction(tx);
    showToast('Confirming claim...', 'info');
    await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);
    showToast(usePegged ? '$PEGGED claimed!' : 'SOL claimed!', 'success');
    renderMonkeList();
  } catch (err) {
    console.error('[monke] claim failed:', err);
    showToast('Claim failed: ' + (err?.message || err), 'error');
  }
}

async function handleClaimAll() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  const conn = state.connection;
  const user = state.publicKey;
  const claimable = (state.monkeNfts || []).filter(n => n.hasBurn && n.pendingSol > 0n);
  if (claimable.length === 0) { showToast('Nothing to claim', 'info'); return; }
  const usePegged = !!CONFIG.PEGGED_MINT;
  const MAX_CLAIMS_PER_TX = 3;

  try {
    if (usePegged) {
      const peggedMint = new solanaWeb3.PublicKey(CONFIG.PEGGED_MINT);
      const [programVaultPDA] = getProgramVaultPDA();
      const programVaultAta = getAssociatedTokenAddressSync(peggedMint, programVaultPDA, true);
      const userPeggedAta = getAssociatedTokenAddressSync(peggedMint, user);
      await ensureAccountsSetup(conn, user, [
        { ata: userPeggedAta, owner: user, mint: peggedMint, tokenProgram: TOKEN_PROGRAM_ID },
      ]);
    }

    const claimIxs = [];
    for (const nft of claimable) {
      const nftMint = new solanaWeb3.PublicKey(nft.mint);
      const [monkeBurnPDA] = getMonkeBurnPDA(nftMint);
      const userNftAccount = getAssociatedTokenAddressSync(nftMint, user);
      if (usePegged) {
        const peggedMint = new solanaWeb3.PublicKey(CONFIG.PEGGED_MINT);
        const [programVaultPDA] = getProgramVaultPDA();
        const programVaultAta = getAssociatedTokenAddressSync(peggedMint, programVaultPDA, true);
        const userPeggedAta = getAssociatedTokenAddressSync(peggedMint, user);
        const ix = await getClaimPeggedInstructionAsync({
          user: asSigner(user),
          monkeBurn: address(monkeBurnPDA.toBase58()),
          userNftAccount: address(userNftAccount.toBase58()),
          programVaultPeggedAta: address(programVaultAta.toBase58()),
          userPeggedAta: address(userPeggedAta.toBase58()),
        });
        claimIxs.push(kitIxToWeb3(ix));
      } else {
        const ix = await getClaimInstructionAsync({
          user: asSigner(user),
          monkeBurn: address(monkeBurnPDA.toBase58()),
          userNftAccount: address(userNftAccount.toBase58()),
        });
        claimIxs.push(kitIxToWeb3(ix));
      }
    }

    const chunks = [];
    for (let i = 0; i < claimIxs.length; i += MAX_CLAIMS_PER_TX) {
      chunks.push(claimIxs.slice(i, i + MAX_CLAIMS_PER_TX));
    }

    let claimed = 0;
    for (let c = 0; c < chunks.length; c++) {
      const tx = new solanaWeb3.Transaction();
      tx.add(solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
      tx.add(makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS));
      for (const ix of chunks[c]) tx.add(ix);

      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      tx.feePayer = user;

      showToast(chunks.length > 1 ? `Approve batch ${c + 1}/${chunks.length}...` : 'Approve in wallet...', 'info');
      const sig = await walletSendTransaction(tx);
      showToast(chunks.length > 1 ? `Confirming batch ${c + 1}/${chunks.length}...` : 'Confirming claims...', 'info');
      await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);
      claimed += chunks[c].length;
    }

    const token = usePegged ? '$PEGGED' : 'SOL';
    showToast(`Claimed ${token} from ${claimed} monke${claimed > 1 ? 's' : ''}!`, 'success');
    renderMonkeList();
  } catch (err) {
    console.error('[monke] claim_all failed:', err);
    showToast('Claim all failed: ' + (err?.message || err), 'error');
  }
}

// ============================================================
// POOL METRICS — enriched stats from DataPI /pools/{address}
// ============================================================

function updatePoolMetrics(poolData) {
  const metricsEl = document.getElementById('poolMetrics');
  if (!metricsEl) return;

  const apr = poolData.apr;
  const feeTvl = poolData.fee_tvl_ratio?.['24h'];
  const dynFee = poolData.dynamic_fee_pct ?? poolData.pool_config?.base_fee_pct;
  const cumVol = poolData.cumulative_metrics?.volume;

  if (apr != null || feeTvl != null) {
    const aprEl = document.getElementById('poolApr');
    const feeTvlEl = document.getElementById('poolFeeTvl');
    const dynFeeEl = document.getElementById('poolDynFee');
    const cumVolEl = document.getElementById('poolCumVol');

    if (aprEl) aprEl.textContent = apr != null ? (apr * 100).toFixed(1) + '%' : '—';
    if (feeTvlEl) feeTvlEl.textContent = feeTvl != null ? (feeTvl * 100).toFixed(2) + '%' : '—';
    if (dynFeeEl) dynFeeEl.textContent = dynFee != null ? dynFee.toFixed(2) + '%' : '—';
    if (cumVolEl) cumVolEl.textContent = cumVol != null ? formatVolume(cumVol) : '—';
    metricsEl.style.display = '';
  } else {
    metricsEl.style.display = 'none';
  }
}

// ============================================================
// OHLCV CHART — candlestick/line chart from DataPI
// ============================================================

async function fetchAndRenderOHLCV(poolAddress, timeframe) {
  const section = document.getElementById('ohlcvSection');
  if (!section) return;

  let data = null;
  try {
    const relayData = await relayFetch(`/api/pool-ohlcv/${poolAddress}?timeframe=${timeframe}`);
    if (relayData?.data?.length) data = relayData;
  } catch {}

  if (!data) {
    try {
      const resp = await fetch(`${METEORA_API_BASE()}/pools/${poolAddress}/ohlcv?timeframe=${timeframe}`);
      if (resp.ok) data = await resp.json();
    } catch {}
  }

  if (!data?.data?.length) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  renderOHLCVCanvas(data.data, timeframe);
}

function renderOHLCVCanvas(candles, timeframe) {
  const canvas = document.getElementById('ohlcvCanvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  if (!wrap) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = wrap.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;
  ctx.clearRect(0, 0, W, H);

  if (candles.length === 0) return;

  const font = "'IBM Plex Mono', monospace";
  const axisColor = '#714BA6';
  const gridColor = 'rgba(113, 75, 166, 0.12)';
  const fontSize = 8;

  const marginRight = 52;
  const marginBottom = 20;
  const marginTop = 6;
  const marginLeft = 4;

  const chartW = W - marginLeft - marginRight;
  const chartH = H - marginTop - marginBottom;

  const prices = candles.flatMap(c => [c.high, c.low]);
  let minP = Math.min(...prices);
  let maxP = Math.max(...prices);
  const pRange = maxP - minP || 1;
  minP -= pRange * 0.02;
  maxP += pRange * 0.02;
  const fullRange = maxP - minP;

  const toY = (p) => marginTop + (1 - (p - minP) / fullRange) * chartH;
  const gap = Math.max(1, chartW * 0.08 / candles.length);
  const barW = Math.max(2, (chartW / candles.length) - gap);
  const step = chartW / candles.length;

  ctx.font = `400 ${fontSize}px ${font}`;

  const gridSteps = 5;
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 0.5;
  ctx.fillStyle = axisColor;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= gridSteps; i++) {
    const p = minP + (fullRange * i) / gridSteps;
    const y = toY(p);
    ctx.beginPath();
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(marginLeft + chartW, y);
    ctx.stroke();
    ctx.fillText('$' + formatPrice(p), marginLeft + chartW + 4, y);
  }

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const x = marginLeft + i * step + step / 2;
    const isUp = c.close >= c.open;
    const color = isUp ? '#ADD96C' : '#D984AC';

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, toY(c.high));
    ctx.lineTo(x, toY(c.low));
    ctx.stroke();

    const bodyTop = toY(Math.max(c.open, c.close));
    const bodyBot = toY(Math.min(c.open, c.close));
    const bodyH = Math.max(1, bodyBot - bodyTop);
    ctx.fillStyle = color;
    ctx.fillRect(x - barW / 2, bodyTop, barW, bodyH);
  }

  ctx.fillStyle = axisColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelY = marginTop + chartH + 4;
  const isDaily = timeframe === '24h' || timeframe === '12h';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const labelWidth = isDaily ? 46 : 36;
  const maxTimeLabels = Math.floor(chartW / labelWidth);
  const timeStep = Math.max(1, Math.ceil(candles.length / maxTimeLabels));
  for (let i = 0; i < candles.length; i += timeStep) {
    const c = candles[i];
    const ts = c.timestamp ? c.timestamp * 1000 : Date.parse(c.timestamp_str);
    if (!ts || isNaN(ts)) continue;
    const d = new Date(ts);
    const label = isDaily
      ? months[d.getUTCMonth()] + ' ' + d.getUTCDate()
      : d.getUTCHours().toString().padStart(2, '0') + ':' + d.getUTCMinutes().toString().padStart(2, '0');
    const x = marginLeft + i * step + step / 2;
    ctx.fillText(label, x, labelY);
  }

  const lastCandle = candles[candles.length - 1];
  const lastPrice = lastCandle.close;
  const lastY = toY(lastPrice);
  ctx.strokeStyle = 'rgba(113, 75, 166, 0.4)';
  ctx.lineWidth = 0.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(marginLeft, lastY);
  ctx.lineTo(marginLeft + chartW, lastY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#714BA6';
  ctx.font = `600 ${fontSize + 1}px ${font}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('$' + formatPrice(lastPrice), marginLeft + chartW + 4, lastY);
}

// ============================================================
// POSITION HISTORY MODAL — events from DataPI
// ============================================================

async function showPositionHistory(meteoraPositionAddress) {
  const modal = document.getElementById('positionHistoryModal');
  const eventsEl = document.getElementById('historyEvents');
  if (!modal || !eventsEl) return;

  eventsEl.innerHTML = '<div class="empty-state">loading...</div>';
  modal.classList.add('visible');

  let data = null;
  try {
    const relayData = await relayFetch(`/api/position-history/${meteoraPositionAddress}`);
    if (relayData?.events) data = relayData;
  } catch {}

  if (!data) {
    try {
      const resp = await fetch(
        `${METEORA_API_BASE()}/positions/${meteoraPositionAddress}/historical?order_direction=desc`
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
// RECON PAGE — private protocol analytics dashboard
// ============================================================

let reconPnlData = null;
let reconFilter = 'all';

async function loadReconDashboard() {
  try {
    const data = await relayFetch('/api/protocol-pnl');
    if (!data) {
      document.getElementById('reconPoolBreakdown').innerHTML =
        '<div class="empty-state">bot relay unavailable — protocol PnL requires the bot</div>';
      return;
    }
    reconPnlData = data;
    renderReconDashboard(data);
  } catch {
    document.getElementById('reconPoolBreakdown').innerHTML =
      '<div class="empty-state">failed to load protocol data</div>';
  }
}

function renderReconDashboard(data) {
  const el = id => document.getElementById(id);

  const wr = el('reconWinRate');
  if (wr) {
    const pct = (data.winRate * 100).toFixed(1);
    wr.textContent = pct + '%';
    wr.className = 'stat-value ' + (data.winRate >= 0.5 ? 'green' : '');
  }

  const netPnl = parseFloat(data.netPnlUsd);
  if (el('reconNetPnl')) {
    el('reconNetPnl').textContent = (netPnl >= 0 ? '+' : '') + '$' + Math.abs(netPnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    el('reconNetPnl').className = 'stat-value ' + (netPnl >= 0 ? 'pnl-positive' : 'pnl-negative');
  }

  if (el('reconPosCount')) el('reconPosCount').textContent = `${data.openPositions} open / ${data.closedPositions} closed`;
  if (el('reconFeesEarned')) el('reconFeesEarned').textContent = '$' + parseFloat(data.totalFeesUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (el('reconAvgReturn')) {
    el('reconAvgReturn').textContent = (data.avgReturnPct >= 0 ? '+' : '') + data.avgReturnPct.toFixed(2) + '%';
    el('reconAvgReturn').className = 'stat-value ' + (data.avgReturnPct >= 0 ? 'pnl-positive' : 'pnl-negative');
  }

  // Side stats
  const buy = data.bySide?.buy || {};
  const sell = data.bySide?.sell || {};
  if (el('reconBuyWr')) el('reconBuyWr').textContent = ((buy.winRate || 0) * 100).toFixed(1) + '%';
  if (el('reconBuyCount')) el('reconBuyCount').textContent = (buy.count || 0) + ' positions';
  if (el('reconBuyPnl')) {
    const v = parseFloat(buy.netPnlUsd || '0');
    el('reconBuyPnl').textContent = (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);
    el('reconBuyPnl').className = 'recon-side-pnl ' + (v >= 0 ? 'pnl-positive' : 'pnl-negative');
  }
  if (el('reconSellWr')) el('reconSellWr').textContent = ((sell.winRate || 0) * 100).toFixed(1) + '%';
  if (el('reconSellCount')) el('reconSellCount').textContent = (sell.count || 0) + ' positions';
  if (el('reconSellPnl')) {
    const v = parseFloat(sell.netPnlUsd || '0');
    el('reconSellPnl').textContent = (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2);
    el('reconSellPnl').className = 'recon-side-pnl ' + (v >= 0 ? 'pnl-positive' : 'pnl-negative');
  }

  // Rover
  if (data.roverPortfolio?.total) {
    const rt = data.roverPortfolio.total;
    const roverPnl = parseFloat(rt.totalPnlUsd || '0');
    if (el('reconRoverPnl')) {
      el('reconRoverPnl').textContent = (roverPnl >= 0 ? '+$' : '-$') + Math.abs(roverPnl).toFixed(2);
      el('reconRoverPnl').className = 'stat-value ' + (roverPnl >= 0 ? 'pnl-positive' : 'pnl-negative');
    }
    const roverSection = el('reconRoverSection');
    if (roverSection) {
      const openPools = data.roverPortfolio.open?.pools || [];
      if (openPools.length > 0) {
        roverSection.innerHTML = openPools.map(p => `
          <div class="recon-pool-row">
            <span>${escapeHtml(p.tokenX || '?')}/${escapeHtml(p.tokenY || '?')}</span>
            <span>${p.openPositionCount || 0}</span>
            <span>—</span>
            <span>$${parseFloat(p.balances || '0').toFixed(2)}</span>
            <span class="${parseFloat(p.pnl || '0') >= 0 ? 'pnl-positive' : 'pnl-negative'}">
              ${parseFloat(p.pnl || '0') >= 0 ? '+' : ''}$${parseFloat(p.pnl || '0').toFixed(2)}
            </span>
          </div>
        `).join('');
      } else {
        roverSection.innerHTML = '<div class="empty-state">no open rover positions</div>';
      }
    }
  } else {
    if (el('reconRoverPnl')) el('reconRoverPnl').textContent = '—';
    const roverSection = el('reconRoverSection');
    if (roverSection) roverSection.innerHTML = '<div class="empty-state">rover data unavailable</div>';
  }

  renderReconPoolBreakdown(data.byPool || []);
}

function renderReconPoolBreakdown(pools) {
  const container = document.getElementById('reconPoolBreakdown');
  if (!container) return;

  let filtered = pools;
  if (reconFilter === 'profitable') filtered = pools.filter(p => parseFloat(p.netPnlUsd) > 0);
  else if (reconFilter === 'unprofitable') filtered = pools.filter(p => parseFloat(p.netPnlUsd) <= 0);

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">no pools match filter</div>';
    return;
  }

  container.innerHTML = filtered.map(p => {
    const pnl = parseFloat(p.netPnlUsd);
    return `<div class="recon-pool-row">
      <span>${escapeHtml(p.name)}</span>
      <span>${p.positions}</span>
      <span>${(p.winRate * 100).toFixed(0)}%</span>
      <span>$${parseFloat(p.depositedUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
      <span class="${pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}</span>
    </div>`;
  }).join('');
}

async function handleRoverDeposit() {
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

async function renderOpsStats() {
  const el = id => document.getElementById(id);
  try {
    const [stats, pending] = await Promise.all([
      relayFetch('/api/stats'),
      relayFetch('/api/pending-harvests'),
    ]);
    if (stats) {
      if (el('opsPositionCount')) el('opsPositionCount').textContent = stats.positionCount || 0;
      if (el('opsTotalHarvested')) el('opsTotalHarvested').textContent = (stats.totalHarvests || 0) + ' txs';
      if (el('opsBotStatus')) el('opsBotStatus').textContent = stats.grpcConnected ? 'connected' : 'offline';
    } else {
      if (el('opsBotStatus')) el('opsBotStatus').textContent = 'offline';
    }
    if (pending) {
      if (el('opsPendingCount')) el('opsPendingCount').textContent = pending.count || 0;
    }
  } catch {
    if (el('opsBotStatus')) el('opsBotStatus').textContent = 'offline';
  }

  // Fee pipeline balances (SOL + $PEGGED)
  try {
    if (state.connection) {
      const roverAuthority = getRoverAuthorityPDA()[0];
      const distPool = getDistPoolPDA()[0];
      const [roverBal, distBal] = await Promise.all([
        state.connection.getBalance(roverAuthority),
        state.connection.getBalance(distPool),
      ]);
      if (el('opsSweepBalance')) el('opsSweepBalance').textContent = (roverBal / 1e9).toFixed(4) + ' SOL';

      // Show $PEGGED balance if configured, otherwise show SOL
      if (CONFIG.PEGGED_MINT) {
        try {
          const peggedMint = new solanaWeb3.PublicKey(CONFIG.PEGGED_MINT);
          const distPoolAta = getAssociatedTokenAddressSync(peggedMint, distPool, true);
          const info = await state.connection.getAccountInfo(distPoolAta);
          const peggedBal = info && info.data.length >= 72 ? Number(info.data.readBigUInt64LE(64)) : 0;
          if (el('opsDepositBalance')) el('opsDepositBalance').textContent = (peggedBal / 1e9).toFixed(4) + ' $PEGGED';
        } catch {
          if (el('opsDepositBalance')) el('opsDepositBalance').textContent = (distBal / 1e9).toFixed(4) + ' SOL';
        }
      } else {
        if (el('opsDepositBalance')) el('opsDepositBalance').textContent = (distBal / 1e9).toFixed(4) + ' SOL';
      }
    }
  } catch {}
}

async function renderBountyBoard() {
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

function addFeedEvent(text, ts) {
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

async function preloadFeed() {
  try {
    const data = await relayFetch('/api/feed');
    if (data?.events?.length) {
      const feed = document.getElementById('activityFeed');
      if (feed) feed.innerHTML = '';
      for (const evt of [...data.events].reverse()) {
        addFeedEvent(evt.text || formatRelayEvent(evt), evt.timestamp);
      }
    }
  } catch {
    // Feed pre-load is best-effort
  }
}

async function handleCrankSweep() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
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
  }
}

async function handleCrankDistribute() {
  return handleCrankDeposit();
}

async function handleCrankDeposit() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
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
  }
}

async function handleHarvestPosition(positionPDAStr, lbPairStr, ownerStr, side) {
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

async function handleHarvestAll() {
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

// ============================================================
// PNL CARD — Canvas rendering with scaffold vocabulary
// ============================================================

function renderPnlCard(position) {
  const canvas = document.getElementById('pnlCanvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const w = 1200, h = 675;
  canvas.width = w;
  canvas.height = h;

  ctx.fillStyle = '#F2E0D0';
  ctx.fillRect(0, 0, w, h);

  const arcR = 60;
  const margin = 30;
  ctx.strokeStyle = '#714BA6';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 6]);

  // Top-left arc
  ctx.beginPath();
  ctx.arc(margin + arcR, margin + arcR, arcR, Math.PI, Math.PI * 1.5);
  ctx.stroke();
  // Top-right arc
  ctx.beginPath();
  ctx.arc(w - margin - arcR, margin + arcR, arcR, Math.PI * 1.5, Math.PI * 2);
  ctx.stroke();
  // Bottom-left arc
  ctx.beginPath();
  ctx.arc(margin + arcR, h - margin - arcR, arcR, Math.PI * 0.5, Math.PI);
  ctx.stroke();
  // Bottom-right arc
  ctx.beginPath();
  ctx.arc(w - margin - arcR, h - margin - arcR, arcR, 0, Math.PI * 0.5);
  ctx.stroke();

  ctx.setLineDash([]);

  // Determine profit/loss
  const pnl = position.amount * (position.filled / 100) + (position.lpFees || 0) - position.amount;
  const isProfit = pnl >= 0;
  const accentColor = isProfit ? '#ADD96C' : '#F2B6C6';

  // Accent: colored inner arcs
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  const innerR = 40;
  ctx.beginPath();
  ctx.arc(margin + arcR, margin + arcR, innerR, Math.PI, Math.PI * 1.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(w - margin - arcR, margin + arcR, innerR, Math.PI * 1.5, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(margin + arcR, h - margin - arcR, innerR, Math.PI * 0.5, Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(w - margin - arcR, h - margin - arcR, innerR, 0, Math.PI * 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  const fontBase = "'IBM Plex Mono', monospace";

  ctx.font = `500 28px ${fontBase}`;
  ctx.fillStyle = '#180E26';
  ctx.textAlign = 'left';
  ctx.fillText(position.pool, margin + 20, margin + 70);

  ctx.font = `500 15px ${fontBase}`;
  ctx.fillStyle = position.side === 'buy' ? '#ADD96C' : '#F2B6C6';
  ctx.fillText(position.side.toUpperCase(), margin + 20, margin + 100);

  ctx.font = `400 17px ${fontBase}`;
  ctx.fillStyle = '#714BA6';
  ctx.fillText(`$${formatPrice(position.minPrice)} - $${formatPrice(position.maxPrice)}`, margin + 20, h / 2 - 20);

  ctx.font = `400 15px ${fontBase}`;
  ctx.fillStyle = '#714BA6';
  ctx.fillText(`${position.filled}% filled`, margin + 20, h / 2 + 10);

  ctx.fillText(`LP fees: ${(position.lpFees || 0).toFixed(4)} SOL`, margin + 20, h / 2 + 40);

  ctx.font = `700 50px ${fontBase}`;
  ctx.fillStyle = accentColor;
  ctx.textAlign = 'right';
  const pnlText = (isProfit ? '+' : '') + pnl.toFixed(4) + ' SOL';
  ctx.fillText(pnlText, w - margin - 20, h / 2 + 15);

  ctx.font = `400 13px ${fontBase}`;
  ctx.fillStyle = '#714BA6';
  ctx.fillText('NET P/L', w - margin - 20, h / 2 - 30);

  ctx.font = `400 11px ${fontBase}`;
  ctx.fillStyle = '#714BA6';
  ctx.textAlign = 'center';
  ctx.letterSpacing = '2px';
  ctx.fillText('HARVESTED BY CRANK.MONEY', w / 2, h - margin - 10);
}

function showPnlModal(positionIndex) {
  const position = state.positions[positionIndex];
  if (!position) return;

  renderPnlCard(position);

  const modal = document.getElementById('pnlModal');
  if (modal) modal.classList.add('visible');
}

function closePnlModal() {
  const modal = document.getElementById('pnlModal');
  if (modal) modal.classList.remove('visible');
}

async function downloadPnlCard() {
  const canvas = document.getElementById('pnlCanvas');
  if (!canvas) return;

  canvas.toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'monke-pnl.png';
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

async function copyPnlCard() {
  const canvas = document.getElementById('pnlCanvas');
  if (!canvas) return;

  try {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (blob) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('Copied to clipboard', 'success');
    }
  } catch {
    showToast('Copy failed — try download instead', 'error');
  }
}

// ============================================================
// UNCLAIMED REWARDS WARNING
// ============================================================

function showUnclaimedWarning(amount) {
  const modal = document.getElementById('unclaimedWarning');
  const amountEl = document.getElementById('unclaimedAmount');
  const token = CONFIG.PEGGED_MINT ? '$PEGGED' : 'SOL';
  if (amountEl) amountEl.textContent = amount.toFixed(4) + ' ' + token;
  if (modal) modal.classList.add('visible');
}

function closeUnclaimedWarning() {
  const modal = document.getElementById('unclaimedWarning');
  if (modal) modal.classList.remove('visible');
}

// ============================================================
// SUB-TAB NAVIGATION (within mushrooms page)
// ============================================================

function showSubPage(subName) {
  state.currentSubPage = subName;
  // Toggle orbital active state in top-left corner
  document.querySelectorAll('.orbital').forEach(o => {
    o.classList.toggle('sub-active', o.dataset.sub === subName);
  });
  // Toggle content visibility
  document.querySelectorAll('.sub-content').forEach(c => {
    c.classList.toggle('active', c.dataset.sub === subName);
  });
  // Show active sigil at low opacity (ambient), others hidden
  document.querySelectorAll('.orbital-sigil').forEach(g => {
    g.setAttribute('opacity', g.dataset.sub === subName ? '0.4' : '0');
  });
}

// ============================================================
// RECON ACCESS CONTROL
// ============================================================

function activateReconPage() {
  const reconEl = document.getElementById('page-recon');
  if (!reconEl) return;
  reconEl.style.display = '';
  reconEl.style.removeProperty('display');
  showPage(PAGE_IDS.indexOf('page-recon'));
  loadReconDashboard();
  showToast('Recon dashboard activated', 'info');
}

// ============================================================
// NAVIGATION — bottom panel tabs + dots
// ============================================================

const PAGE_IDS = ['page-trade', 'page-positions', 'page-rank', 'page-ops', 'page-recon'];
const PAGE_BODY_CLASSES = ['on-trade', 'on-positions', 'on-rank', 'on-ops', 'on-recon'];
const PAGE_ACCENT = ['#F2B6C6', '#F2B6C6', '#F2B6C6', '#F2B6C6', '#F2B6C6'];

function showPage(idx) {
  state.currentPage = idx;

  // Toggle site-page visibility
  PAGE_IDS.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', i === idx);
  });

  // Toggle body class for corner/tangent-ray repositioning
  PAGE_BODY_CLASSES.forEach((cls, i) => {
    document.body.classList.toggle(cls, i === idx);
  });

  // Sigil navigator: orbits + dots with per-page accent color
  const accent = PAGE_ACCENT[idx];
  document.querySelectorAll('.sigil-orbit').forEach(o => {
    const isActive = parseInt(o.dataset.page) === idx;
    o.classList.toggle('active', isActive);
    if (isActive) {
      o.setAttribute('stroke', accent);
    } else {
      o.setAttribute('stroke', 'var(--wire-cyan-dim)');
    }
  });
  document.querySelectorAll('.sigil-dot').forEach(d => {
    const isActive = parseInt(d.dataset.page) === idx;
    d.classList.toggle('active', isActive);
    if (isActive) {
      d.setAttribute('fill', accent);
    } else {
      d.setAttribute('fill', 'var(--wire-cyan-dim)');
    }
  });

  // Nav arrows: show dot on boundaries, arrow when navigable
  const leftArrow = document.getElementById('navLeft');
  const rightArrow = document.getElementById('navRight');
  if (leftArrow) {
    if (idx === 0) {
      leftArrow.innerHTML = '<svg width="40" height="56" viewBox="0 0 40 56"><circle cx="20" cy="28" r="3" fill="var(--nerv-orange)"/></svg>';
      leftArrow.style.cursor = 'default';
    } else {
      leftArrow.innerHTML = '<svg width="40" height="56" viewBox="0 0 40 56"><path d="M 18 28 Q 24 26, 34 18 Q 28 28, 34 38 Q 24 30, 18 28 Z" fill="var(--nerv-orange)"/></svg>';
      leftArrow.style.cursor = 'pointer';
    }
  }
  if (rightArrow) {
    const maxPublicPage = 3;
    if (idx >= maxPublicPage) {
      rightArrow.innerHTML = '<svg width="40" height="56" viewBox="0 0 40 56"><circle cx="20" cy="28" r="3" fill="var(--nerv-orange)"/></svg>';
      rightArrow.style.cursor = 'default';
    } else {
      rightArrow.innerHTML = '<svg width="40" height="56" viewBox="0 0 40 56"><path d="M 22 28 Q 16 26, 6 18 Q 12 28, 6 38 Q 16 30, 22 28 Z" fill="var(--nerv-orange)"/></svg>';
      rightArrow.style.cursor = 'pointer';
    }
  }

  // Highlight active pool orbital on Trade page (idx 0)
  if (idx === 0) {
    const orbitals = document.querySelectorAll('.orbital');
    orbitals.forEach((o, i) => o.classList.toggle('sub-active', i === state.activePoolOrbital));
    setTimeout(renderBinViz, 50);
  }

  // Positions page (idx 1)
  if (idx === 1) {
    renderPositionsPage();
  }

  // Activate/deactivate orbital sub-nav based on page (Rank = idx 2)
  if (idx === 2) {
    showSubPage(state.currentSubPage);
  } else {
    // Off Rank page: clear all orbital highlights + sigils
    document.querySelectorAll('.orbital').forEach(o => o.classList.remove('sub-active'));
    document.querySelectorAll('.orbital-sigil').forEach(g => g.setAttribute('opacity', '0'));
  }
}

// ============================================================
// TOAST
// ============================================================

function showToast(msg, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = msg;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'fadeOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
window.showToast = showToast;

// ============================================================
// INITIALIZATION
// ============================================================

async function init() {
  await loadConfig();

  // Connect to bot relay (LaserStream WebSocket + REST)
  connectRelay();

  // Pre-load feed events via HTTP so feed is populated immediately
  preloadFeed();

  // Demo mode banner
  if (CONFIG.CORE_PROGRAM_ID.includes('1111111111')) {
    const banner = document.createElement('div');
    banner.textContent = 'DEMO MODE — no real transactions';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:var(--alert-red);color:var(--void);text-align:center;padding:4px;z-index:9999;font-size:12px;font-family:inherit;letter-spacing:0.1em;text-transform:uppercase;';
    document.body.prepend(banner);
  }

  // Wallet
  document.getElementById('connectWallet')?.addEventListener('click', toggleWalletMenu);

  // Pool
  document.getElementById('loadPool')?.addEventListener('click', loadPool);
  document.getElementById('poolAddress')?.addEventListener('keypress', e => {
    if (e.key === 'Enter') loadPool();
  });

  // Zoom controls (price-percentage)
  const ZOOM_STEPS = [10, 20, 50];
  document.getElementById('zoomIn')?.addEventListener('click', () => {
    const curIdx = ZOOM_STEPS.indexOf(vizState.zoomPct);
    const newIdx = Math.max(0, (curIdx >= 0 ? curIdx : 1) - 1);
    vizState.zoomPct = ZOOM_STEPS[newIdx];
    document.getElementById('zoomLevel').textContent = '±' + vizState.zoomPct + '%';
    loadBinVizData();
  });
  document.getElementById('zoomOut')?.addEventListener('click', () => {
    const curIdx = ZOOM_STEPS.indexOf(vizState.zoomPct);
    const newIdx = Math.min(ZOOM_STEPS.length - 1, (curIdx >= 0 ? curIdx : 1) + 1);
    vizState.zoomPct = ZOOM_STEPS[newIdx];
    document.getElementById('zoomLevel').textContent = '±' + vizState.zoomPct + '%';
    loadBinVizData();
  });

  // Side tabs
  document.querySelectorAll('.side-tab').forEach(tab => {
    tab.addEventListener('click', () => { updateSide(tab.dataset.side); updateBinVizPreview(); });
  });

  // Range inputs → update bin strip
  document.getElementById('rangeNear')?.addEventListener('input', () => { updateBinStrip(); updateBinVizPreview(); });
  document.getElementById('rangeFar')?.addEventListener('input', () => { updateBinStrip(); updateBinVizPreview(); });

  // Amount
  document.getElementById('amount')?.addEventListener('input', () => { updateFee(); updateBinVizPreview(); });

  // Action
  document.getElementById('actionBtn')?.addEventListener('click', createPosition);

  // Sigil navigator: orbits + dots are clickable
  document.querySelectorAll('.sigil-orbit').forEach(o => {
    o.addEventListener('click', () => showPage(parseInt(o.dataset.page)));
  });
  document.querySelectorAll('.sigil-dot').forEach(d => {
    d.addEventListener('click', () => showPage(parseInt(d.dataset.page)));
  });

  // Nav arrows
  document.getElementById('navLeft')?.addEventListener('click', () => {
    if (state.currentPage > 0) showPage(state.currentPage - 1);
  });
  document.getElementById('navRight')?.addEventListener('click', () => {
    const maxPublicPage = 3; // ops is last public page; recon (4) is hidden
    if (state.currentPage < maxPublicPage) showPage(state.currentPage + 1);
  });

  // Arrow hover highlights target orbit
  const sigDots = document.querySelectorAll('.sigil-dot');
  const leftArrow = document.getElementById('navLeft');
  const rightArrow = document.getElementById('navRight');
  if (leftArrow) {
    leftArrow.addEventListener('mouseenter', () => {
      const prev = sigDots[Math.max(0, state.currentPage - 1)];
      if (prev) prev.classList.add('hover');
    });
    leftArrow.addEventListener('mouseleave', () => sigDots.forEach(d => d.classList.remove('hover')));
  }
  if (rightArrow) {
    rightArrow.addEventListener('mouseenter', () => {
      const next = sigDots[Math.min(3, state.currentPage + 1)];
      if (next) next.classList.add('hover');
    });
    rightArrow.addEventListener('mouseleave', () => sigDots.forEach(d => d.classList.remove('hover')));
  }

  // Orbital nav (top-left corner circles) — dual purpose
  const orbitals = document.querySelectorAll('.orbital');
  const orbitalArray = Array.from(orbitals);
  orbitals.forEach((o, i) => {
    o.addEventListener('click', () => {
      if (state.currentPage === 2 && o.dataset.sub) {
        showSubPage(o.dataset.sub);
      }
    });
    // Reactive sigil on hover (Rank page)
    o.addEventListener('mouseenter', () => {
      if (state.currentPage === 2 && o.dataset.sub) {
        document.querySelectorAll('.orbital-sigil').forEach(g => {
          g.setAttribute('opacity', g.dataset.sub === o.dataset.sub ? '1' : '0');
        });
      }
    });
    o.addEventListener('mouseleave', () => {
      if (state.currentPage === 2) {
        document.querySelectorAll('.orbital-sigil').forEach(g => {
          g.setAttribute('opacity', g.dataset.sub === state.currentSubPage ? '0.4' : '0');
        });
      }
    });
  });

  // Rank: feed + claim
  document.getElementById('feedMonkeBtn')?.addEventListener('click', () => {
    if (!state.selectedMonkeMint) { showToast('Select a monke first', 'error'); return; }
    const nft = (state.monkeNfts || []).find(n => n.mint === state.selectedMonkeMint);
    if (nft && nft.gen === 'goose') handleFeedGoose(state.selectedMonkeMint);
    else handleFeedMonke(state.selectedMonkeMint);
  });
  document.getElementById('claimAllBtn')?.addEventListener('click', handleClaimAll);

  // Rank: MonkeBurn lookup
  document.getElementById('monkeBurnSearchBtn')?.addEventListener('click', handleMonkeBurnLookup);
  document.getElementById('monkeBurnLookup')?.addEventListener('keypress', e => {
    if (e.key === 'Enter') handleMonkeBurnLookup();
  });

  // Recon: bribe deposit + dashboard
  document.getElementById('roverDepositBtn')?.addEventListener('click', handleRoverDeposit);
  document.getElementById('historyClose')?.addEventListener('click', () => {
    document.getElementById('positionHistoryModal')?.classList.remove('visible');
  });

  // OHLCV timeframe toggles
  document.querySelectorAll('.ohlcv-tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ohlcv-tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.ohlcvTimeframe = btn.dataset.tf;
      if (state.poolAddress) fetchAndRenderOHLCV(state.poolAddress, btn.dataset.tf);
    });
  });

  // Recon filter buttons
  document.querySelectorAll('.recon-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.recon-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      reconFilter = btn.dataset.filter;
      if (reconPnlData) renderReconPoolBreakdown(reconPnlData.byPool || []);
    });
  });

  // Recon access: ?recon=1 or Ctrl+Shift+R
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('recon') === '1') activateReconPage();
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'R') {
      e.preventDefault();
      activateReconPage();
    }
  });

  // Ops: crank buttons
  document.getElementById('crankSweep')?.addEventListener('click', handleCrankSweep);
  document.getElementById('crankDistribute')?.addEventListener('click', handleCrankDistribute);
  document.getElementById('crankDeposit')?.addEventListener('click', handleCrankDeposit);
  document.getElementById('harvestAllBtn')?.addEventListener('click', handleHarvestAll);

  // PNL modal
  document.getElementById('pnlClose')?.addEventListener('click', closePnlModal);
  document.getElementById('pnlDownload')?.addEventListener('click', downloadPnlCard);
  document.getElementById('pnlCopy')?.addEventListener('click', copyPnlCard);

  // Unclaimed warning modal
  document.getElementById('warningClaimBtn')?.addEventListener('click', () => {
    closeUnclaimedWarning();
    handleClaimAll();
  });
  document.getElementById('warningDismissBtn')?.addEventListener('click', closeUnclaimedWarning);

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.remove('visible');
    });
  });

  // Render pages
  initBurnFireCanvas();
  renderMonkeList();
  renderRoster();
  renderGlobalStats();
  renderOpsStats();
  renderBountyBoard();
  loadReconDashboard();

  fetchTrendingPools();
  setInterval(fetchTrendingPools, 60_000);

  if (CONFIG.DEFAULT_POOL) {
    const poolInput = document.getElementById('poolAddress');
    if (poolInput) {
      poolInput.value = CONFIG.DEFAULT_POOL;
      // Bypass relay check on startup — DEFAULT_POOL is always a token mint,
      // so go straight to discovery for an instant aggregated view.
      discoverAllPoolsForToken(CONFIG.DEFAULT_POOL).then(({ dlmm, damm }) => {
        if (dlmm.length > 0) loadAggregatedView(dlmm, damm);
        else loadPool();
      }).catch(() => loadPool());
    }
  }

  // Initial render
  requestAnimationFrame(() => {
    showPage(0);
  });

  // Auto-connect if wallet was previously connected
  setTimeout(() => {
    try {
      if (phantomSDK.solana?.isConnected?.()) connectWallet();
    } catch (_) {}
  }, 500);
}

// Canvas resize handler
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderBinViz, 100);
});

// Start
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
