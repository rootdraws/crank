import { state } from '../../state.js';
import { CONFIG, getMonkeStatePDA, getMonkeBurnPDA, getDistPoolPDA, getProgramVaultPDA, getMetadataPDA, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, SYSVAR_RENT_PUBKEY, METAPLEX_PROGRAM_ID, computePendingClaim, PRECISION, createAssociatedTokenAccountIx } from '../../constants.js';
import { formatPrice, escapeHtml, showToast } from '../../helpers.js';
import { kitIxToWeb3, asSigner, walletSendTransaction, confirmAndCheck, toEncodedAccount, makeComputeUnitPriceIx, DEFAULT_PRIORITY_MICROLAMPORTS, ensureAccountsSetup } from '../../wallet.js';
import { relayFetch } from '../../relay.js';
import { getFeedMonkeInstructionAsync, getFeedGooseInstructionAsync, getClaimPeggedInstructionAsync, getDepositPeggedInstructionAsync, getClaimInstructionAsync, decodeMonkeBurn, decodeMonkeState, MONKE_BANANAS_PROGRAM_ADDRESS, getStakeAndForwardInstructionAsync } from '../../instructions.js';
import { address } from '@solana/kit';
import { buildSanctumEpochUpdateIxs, SANCTUM_PROGRAM, STAKE_PROGRAM_ID, SYSVAR_CLOCK, SYSVAR_STAKE_HISTORY } from '../../pages/ops.js';

let burnFireRAF = null;

export function ensureBurnFireRunning() {
  if (!burnFireRAF && window._burnFireStep) {
    burnFireRAF = requestAnimationFrame(window._burnFireStep);
  }
}

export function initBurnFireCanvas() {
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

  window._burnFireStep = step;
  function step(ts) {
    if (!window._isRankPageVisible) { burnFireRAF = null; return; }
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

export function renderCarouselFrame(nfts, idx) {
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

export async function enrichNftsWithBurnData(nfts) {
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

export async function updateUserMonkeStats(nfts) {
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
        state.crankBalance = amount;
        if (el('bananasBalance')) el('bananasBalance').textContent = (Number(amount) / 1e6).toLocaleString();
      } else {
        state.crankBalance = 0n;
        if (el('bananasBalance')) el('bananasBalance').textContent = '0';
      }
    } catch (err) {
      console.warn('[monke] Bananas balance fetch failed:', err.message);
    }
  }
}

export async function renderMonkeList() {
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

export function selectMonke(nft) {
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

export function highlightMonkeRow(mint) {
  const container = document.getElementById('monkeList');
  if (!container) return;
  container.querySelectorAll('.monke-row').forEach(row => {
    row.classList.toggle('selected', row.dataset.mint === mint);
  });
}

export async function fetchSMBNfts() {
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

export async function renderGlobalStats() {
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

export async function renderRoster() {
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

export function handleMonkeBurnLookup() {
  const mint = document.getElementById('monkeBurnLookup')?.value.trim();
  const container = document.getElementById('monkeBurnResult');
  if (!container) return;
  if (!mint) { container.innerHTML = ''; return; }
  container.innerHTML = '<div class="empty-state">MonkeBurn lookup requires deployed programs</div>';
}

// ============================================================
// RANK ACTIONS — feed_monke, claim, claim_all
// ============================================================

export async function handleFeedMonke(nftMintStr, count = 1) {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  const required = BigInt(count) * 1_000_000_000_000n;
  if (state.crankBalance < required) {
    showToast(`Need ${count}M $CRANK (have ${(Number(state.crankBalance) / 1e6).toLocaleString()})`, 'error');
    return;
  }
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
      count,
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
    showToast(`${count}M $CRANK burned!`, 'success');
    renderMonkeList();
  } catch (err) {
    console.error('[monke] feed_monke failed:', err);
    showToast('Feed failed: ' + (err?.message || err), 'error');
  }
}

export async function handleFeedGoose(nftMintStr, count = 1) {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  const required = BigInt(count) * 1_000_000_000_000n;
  if (state.crankBalance < required) {
    showToast(`Need ${count}M $CRANK (have ${(Number(state.crankBalance) / 1e6).toLocaleString()})`, 'error');
    return;
  }
  const conn = state.connection;
  const user = state.publicKey;
  const gooseNftMint = new solanaWeb3.PublicKey(nftMintStr);
  const bananasMint = new solanaWeb3.PublicKey(CONFIG.BANANAS_MINT);

  const nftData = (state.monkeNfts || []).find(n => n.mint === nftMintStr);
  const gooseDaoAssetStr = nftData?.gooseDaoAsset || '11111111111111111111111111111111';

  try {
    const [metadataPDA] = getMetadataPDA(gooseNftMint);
    const userGooseNftAccount = getAssociatedTokenAddressSync(gooseNftMint, user);
    const userBananasAccount = getAssociatedTokenAddressSync(bananasMint, user, false, TOKEN_2022_PROGRAM_ID);

    const tx = new solanaWeb3.Transaction();
    tx.add(solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.add(makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS));
    const feedIx = await getFeedGooseInstructionAsync({
      count,
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
    showToast(`${count}M $CRANK burned!`, 'success');
    renderMonkeList();
  } catch (err) {
    console.error('[monke] feed_goose failed:', err);
    showToast('Feed failed: ' + (err?.message || err), 'error');
  }
}

export async function handleClaimMonke(nftMintStr) {
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

export async function handleClaimAll() {
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

export async function handleMintPegged() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  if (!CONFIG.STAKE_POOL || !CONFIG.PEGGED_MINT) {
    showToast('Stake pool not configured', 'error'); return;
  }

  const conn = state.connection;
  const user = state.publicKey;
  const amountStr = document.getElementById('peggedMintAmount')?.value;
  const solAmount = parseFloat(amountStr);
  if (!solAmount || solAmount <= 0) { showToast('Enter a valid SOL amount', 'error'); return; }

  const lamports = BigInt(Math.round(solAmount * 1e9));

  try {
    showToast('Fetching stake pool state...', 'info');
    const epoch = await buildSanctumEpochUpdateIxs(conn);

    const peggedMint = new solanaWeb3.PublicKey(CONFIG.PEGGED_MINT);
    const userPeggedAta = getAssociatedTokenAddressSync(peggedMint, user);

    const depositData = new Uint8Array(9);
    depositData[0] = 14;
    const dv = new DataView(depositData.buffer);
    dv.setBigUint64(1, lamports, true);

    const depositIx = new solanaWeb3.TransactionInstruction({
      programId: SANCTUM_PROGRAM,
      keys: [
        { pubkey: epoch.stakePoolPk,    isSigner: false, isWritable: true  },
        { pubkey: epoch.withdrawAuth,   isSigner: false, isWritable: false },
        { pubkey: epoch.reserveStake,   isSigner: false, isWritable: true  },
        { pubkey: user,                 isSigner: true,  isWritable: true  },
        { pubkey: userPeggedAta,        isSigner: false, isWritable: true  },
        { pubkey: epoch.managerFeeAcct, isSigner: false, isWritable: true  },
        { pubkey: userPeggedAta,        isSigner: false, isWritable: true  },
        { pubkey: epoch.poolMintPk,     isSigner: false, isWritable: true  },
        { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID,     isSigner: false, isWritable: false },
      ],
      data: depositData,
    });

    const tx = new solanaWeb3.Transaction();
    tx.add(solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS));
    for (const ix of epoch.ixs) tx.add(ix);
    tx.add(createAssociatedTokenAccountIx(user, userPeggedAta, user, peggedMint));
    tx.add(depositIx);

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = user;

    showToast('Approve mint $PEGGED...', 'info');
    const sig = await walletSendTransaction(tx);
    showToast('Confirming...', 'info');
    await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);
    showToast(`Minted $PEGGED from ${solAmount} SOL!`, 'success');
    document.getElementById('peggedMintAmount').value = '';
    loadPeggedSection();
  } catch (err) {
    console.error('[pegged] mint failed:', err);
    showToast('Mint failed: ' + (err?.message || err), 'error');
  }
}

export async function handleRedeemPegged() {
  if (!state.connected) { showToast('Connect wallet first', 'error'); return; }
  if (!CONFIG.STAKE_POOL || !CONFIG.PEGGED_MINT) {
    showToast('Stake pool not configured', 'error'); return;
  }

  const conn = state.connection;
  const user = state.publicKey;
  const amountStr = document.getElementById('peggedRedeemAmount')?.value;
  const peggedAmount = parseFloat(amountStr);
  if (!peggedAmount || peggedAmount <= 0) { showToast('Enter a valid $PEGGED amount', 'error'); return; }

  const poolTokenLamports = BigInt(Math.round(peggedAmount * 1e9));

  try {
    showToast('Fetching stake pool state...', 'info');
    const epoch = await buildSanctumEpochUpdateIxs(conn);

    const peggedMint = new solanaWeb3.PublicKey(CONFIG.PEGGED_MINT);
    const userPeggedAta = getAssociatedTokenAddressSync(peggedMint, user);

    const reserveBal = await conn.getBalance(epoch.reserveStake);
    const reserveAvailable = reserveBal - 2_282_880;
    if (reserveAvailable <= 0) {
      showToast('No reserve liquidity available for withdrawal', 'error'); return;
    }

    const withdrawData = new Uint8Array(9);
    withdrawData[0] = 16;
    const wdv = new DataView(withdrawData.buffer);
    wdv.setBigUint64(1, poolTokenLamports, true);

    const withdrawIx = new solanaWeb3.TransactionInstruction({
      programId: SANCTUM_PROGRAM,
      keys: [
        { pubkey: epoch.stakePoolPk,    isSigner: false, isWritable: true  },
        { pubkey: epoch.withdrawAuth,   isSigner: false, isWritable: false },
        { pubkey: user,                 isSigner: true,  isWritable: false },
        { pubkey: userPeggedAta,        isSigner: false, isWritable: true  },
        { pubkey: epoch.reserveStake,   isSigner: false, isWritable: true  },
        { pubkey: user,                 isSigner: false, isWritable: true  },
        { pubkey: epoch.managerFeeAcct, isSigner: false, isWritable: true  },
        { pubkey: epoch.poolMintPk,     isSigner: false, isWritable: true  },
        { pubkey: SYSVAR_CLOCK,         isSigner: false, isWritable: false },
        { pubkey: SYSVAR_STAKE_HISTORY, isSigner: false, isWritable: false },
        { pubkey: STAKE_PROGRAM_ID,     isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID,     isSigner: false, isWritable: false },
      ],
      data: withdrawData,
    });

    const tx = new solanaWeb3.Transaction();
    tx.add(solanaWeb3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
    tx.add(makeComputeUnitPriceIx(DEFAULT_PRIORITY_MICROLAMPORTS));
    for (const ix of epoch.ixs) tx.add(ix);
    tx.add(withdrawIx);

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight; tx.feePayer = user;

    showToast('Approve redeem $PEGGED...', 'info');
    const sig = await walletSendTransaction(tx);
    showToast('Confirming...', 'info');
    await confirmAndCheck(conn, sig, blockhash, lastValidBlockHeight);
    showToast(`Redeemed ${peggedAmount} $PEGGED for SOL!`, 'success');
    document.getElementById('peggedRedeemAmount').value = '';
    loadPeggedSection();
  } catch (err) {
    console.error('[pegged] redeem failed:', err);
    showToast('Redeem failed: ' + (err?.message || err), 'error');
  }
}

export async function loadPeggedSection() {
  if (!CONFIG.STAKE_POOL || !CONFIG.PEGGED_MINT) return;

  const conn = state.connection;
  const peggedMint = new solanaWeb3.PublicKey(CONFIG.PEGGED_MINT);
  const stakePoolPk = new solanaWeb3.PublicKey(CONFIG.STAKE_POOL);

  const balEl = document.getElementById('peggedUserBalance');
  const rateEl = document.getElementById('peggedExchangeRate');
  const reserveEl = document.getElementById('peggedReserveLiquidity');
  const mintBtn = document.getElementById('peggedMintBtn');
  const redeemBtn = document.getElementById('peggedRedeemBtn');

  try {
    const stakePoolInfo = await conn.getAccountInfo(stakePoolPk);
    if (!stakePoolInfo || stakePoolInfo.data.length < 258) return;

    const spData = stakePoolInfo.data;
    const reserveStakePk = new solanaWeb3.PublicKey(spData.subarray(130, 162));

    // Pool total lamports at offset 258 (u64 LE)
    const poolTotalLamports = new DataView(spData.buffer, spData.byteOffset).getBigUint64(258, true);

    // Mint supply from mint account (offset 36, u64 LE)
    const mintInfo = await conn.getAccountInfo(peggedMint);
    let mintSupply = 0n;
    if (mintInfo && mintInfo.data.length >= 44) {
      mintSupply = new DataView(mintInfo.data.buffer, mintInfo.data.byteOffset).getBigUint64(36, true);
    }

    let exchangeRate = 1.0;
    if (mintSupply > 0n) {
      exchangeRate = Number(poolTotalLamports) / Number(mintSupply);
    }
    if (rateEl) rateEl.textContent = `1 $PEGGED ≈ ${exchangeRate.toFixed(6)} SOL`;

    // Store for estimate calculations
    state.peggedExchangeRate = exchangeRate;

    // Reserve liquidity
    const reserveBal = await conn.getBalance(reserveStakePk);
    const reserveAvailable = Math.max(0, reserveBal - 2_282_880);
    state.peggedReserveAvailable = reserveAvailable;
    if (reserveEl) reserveEl.textContent = (reserveAvailable / 1e9).toFixed(4) + ' SOL';

    // User balance
    if (state.connected && state.publicKey) {
      const userAta = getAssociatedTokenAddressSync(peggedMint, state.publicKey);
      const ataInfo = await conn.getAccountInfo(userAta);
      let userBalance = 0n;
      if (ataInfo && ataInfo.data.length >= 72) {
        userBalance = new DataView(ataInfo.data.buffer, ataInfo.data.byteOffset).getBigUint64(64, true);
      }
      state.peggedUserBalance = userBalance;
      if (balEl) balEl.textContent = (Number(userBalance) / 1e9).toFixed(4) + ' $PEGGED';

      if (mintBtn) mintBtn.disabled = false;
      if (redeemBtn) redeemBtn.disabled = userBalance === 0n;
    } else {
      if (balEl) balEl.textContent = 'connect wallet';
      if (mintBtn) mintBtn.disabled = true;
      if (redeemBtn) redeemBtn.disabled = true;
    }
  } catch (err) {
    console.error('[pegged] loadPeggedSection failed:', err);
  }
}

export function updatePeggedEstimates() {
  const rate = state.peggedExchangeRate || 1.0;
  const reserveAvail = state.peggedReserveAvailable || 0;

  const mintInput = document.getElementById('peggedMintAmount');
  const mintEst = document.getElementById('peggedMintEstimate');
  if (mintInput && mintEst) {
    const sol = parseFloat(mintInput.value) || 0;
    const est = sol > 0 ? (sol / rate) : 0;
    mintEst.textContent = sol > 0 ? `≈ ${est.toFixed(4)} $PEGGED` : '≈ 0 $PEGGED';
  }

  const redeemInput = document.getElementById('peggedRedeemAmount');
  const redeemEst = document.getElementById('peggedRedeemEstimate');
  const reserveWarn = document.getElementById('peggedReserveWarning');
  const redeemBtn = document.getElementById('peggedRedeemBtn');
  if (redeemInput && redeemEst) {
    const pegged = parseFloat(redeemInput.value) || 0;
    const estSol = pegged > 0 ? (pegged * rate * 0.999) : 0;
    redeemEst.textContent = pegged > 0 ? `≈ ${estSol.toFixed(4)} SOL (after 0.1% fee)` : '≈ 0 SOL';

    const exceedsReserve = estSol > 0 && (estSol * 1e9) > reserveAvail;
    if (reserveWarn) reserveWarn.style.display = exceedsReserve ? '' : 'none';
    if (redeemBtn && state.connected) {
      redeemBtn.disabled = pegged <= 0 || (state.peggedUserBalance || 0n) === 0n;
    }
  }
}

export function showSubPage(subName) {
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
  // Sync rank sub-tabs (mobile + desktop)
  document.querySelectorAll('.rank-sub-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.sub === subName);
  });
  if (subName === 'pegged') loadPeggedSection();
}
