# monke.army — TODO

---

## E2E test runbook

Run with bot active and wallet connected. 0.01-0.1 SOL per test.

- [ ] **Open position** — Trade page, SOL/USDC (default pool). Buy side, 5%-35% range, 0.01 SOL. Approve. Verify position on Positions page.
- [ ] **Wait for harvest** — Watch Ops activity feed. Bot harvests when price crosses bins.
- [ ] **Test user_close** — Positions page, click "close". Approve. Verify SOL returns minus 0.3% fee.
- [ ] **Test claim_fees** — Open position, wait for LP fees to accrue, click "fees" on Positions page.
- [ ] **Test sweep** — Ops page, check rover_authority balance. If > 0, click "sweep". Verify SOL splits 60/40: 60% to bridge_vault, 40% to Config.bot.
- [ ] **Test stake_and_forward** — After sweep, crank bridge. Verify $PEGGED minted to dist_pool ATA.
- [ ] **Test deposit_pegged** — Ops page, check dist_pool $PEGGED balance. If > 0, click "deposit". Verify $PEGGED moves to program_vault ATA.
- [ ] **Test feed_monke** — Rank page, select SMB Gen2 or Gen3 NFT, click "Burn 1M $BANANAS to your Monke." Verify weight increments by 1.
- [ ] **Test feed_goose** — Rank page, connect wallet with GooseDAO Core membership + gooseswtf pixel goose. Verify goose appears in carousel. Click feed. Verify weight increments. Then test with a wallet that has a gooseswtf but NO GooseDAO membership and no prior feed — verify goose is excluded from carousel.
- [ ] **Test once-in-always-in** — Feed a gooseswtf once (with GooseDAO membership). Remove GooseDAO membership (transfer Core NFT out). Reload page. Verify the already-fed goose still appears in carousel and can still feed + claim.
- [ ] **Test claim_pegged** — After deposit_pegged, click "claim" on fed monke. Verify $PEGGED arrives in wallet ATA.
- [ ] **Test permissionless fallback** — Stop bot for 60s. Go to Ops bounty board. Click "harvest" on a pending position. Verify keeper tip.
- [ ] **Validate Saturday keeper** — Wait for Saturday or manually trigger. Verify 6-step sequence: unwrap WSOL -> sweep_rover -> stake_and_forward -> fee rovers -> deposit_pegged -> cleanup.

---

## Feature work

- [x] **Resolve Phantom blockage** — Switched all single-signer flows to `signAndSendTransaction`, fixed `preSimulate` to pass `sigVerify: false`, refactored open-position multi-signer to `partialSign` keypair first then `signAndSendTransaction`, removed all `skipPreflight: true`. Per Phantom support ticket #190752 (Joey). Verify warning is gone in E2E.
- [x] **$PEGGED LST integration** — SPL stake pool deployed (`SVhYu...`), $PEGGED mint live (`GmqNK...`), bridge program deployed + initialized (`7oHSU...`), monke_bananas upgraded with deposit_pegged/claim_pegged, set_pegged_mint called, revenue_dest redirect proposed. Bot keeper + frontend + relay code updated.
  - [x] **apply_revenue_dest()** — Applied Mar 4. revenue_dest now points to bridge_vault (`B9gTfe...`). sweep_rover 60% flows through bridge → Sanctum pool → $PEGGED.
  - [ ] **$PEGGED token metadata** — Set name/symbol/icon via Metaplex `CreateMetadataAccountV3` on mint `GmqNKeVoKJiF52xRriHXsmmgvTWpkU4UVn2LdPgEiEX1`.
  - [ ] **Register $PEGGED with Sanctum** — Contact Sanctum team (Discord/partnerships) to whitelist pool `9tkzwS...` for Infinity routing. Enables Jupiter swaps, instant unstaking, LST-to-LST conversion. Requires token metadata first.
  - [ ] **Frontend deploy to Vercel** — Code is ready, push + deploy.
  - [ ] **$PEGGED E2E test** — Full Saturday cycle with real SOL: harvest → sweep → stake_and_forward → deposit_pegged → claim_pegged.
- [ ] **Recon page** — Rover TVL leaderboard, top-5 analytics, bribe deposit, click-to-trade. Pure frontend, depends on relay data.
- [ ] **Rover TVL computation** — Bot-side dollar-value computation for rover positions. Wire callback to relay.
- [ ] **Add BANANAS/SOL to Trade page** — DAMM v2 pool is live. Add as selectable pair on Trade page (needs DLMM pool or adapter).
- [ ] **compost_monke crank** — Requires an observation indexer to scan for burned NFTs (supply == 0) with active MonkeBurn PDAs.
- [ ] **Transfer hook support** — Resolve transfer hook extra accounts from mint extension data via DLMM SDK. Add when demand exists.
- [ ] **Program split** — Move rover system to separate program. Add if stack pressure or code separation justifies it.

---

## BD

- [ ] **Apply MonkeFoundry Cohort 2**
- [ ] **Apply Meteora Rising**
- [ ] **Pitch Helius for LaserStream sponsorship**
- [ ] **Share with LP Army**

---

## Ideas

- Aggregated order profiles across DLMM pools
- NFT metadata for commonly traded pairs
- Question Market Workflow (one token CA -> pool launch flow)
- Discord Bot for bin fill notifications

---

*Last updated: Mar 4, 2026.*
