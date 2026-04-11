# issue.md — open work, pickup notes

Written 2026-04-09 after the bin-farm program upgrade landed on mainnet
(slot 412072595, 12:47 UTC) and the bot was redeployed to the droplet.

**UPDATE 2026-04-11:** All threads below are RESOLVED. Committed as `3599816` (one big commit). npm fixes deployed with the commit. Decision points answered: one big commit, npm fixes batched, Meteora vulns accepted. Registry empty state was (a) — force-close happened, no users on new binary yet.

## TL;DR (RESOLVED)

~~Three threads are live at once. Two Claudes are touching the same working
tree, nothing is committed since `fd9f2aa cleanup`, and a round of npm
vulnerability fixes is sitting uncommitted + undeployed. Before doing
anything further, **commit the current state as a recovery point**.~~

All committed 2026-04-11 as commit `3599816`. 110 files, +17,940 / -7,888 lines.

---

## Thread 1: npm audit cleanup — in progress, local only

**Status:** 14 vulns → 4 vulns. Fixes are in the working tree (`package.json`
+ `package-lock.json`) but have NOT been deployed. The running bot on the
droplet still has the pre-fix `node_modules/` from the 13:42 UTC deploy.

### 10 fixes applied (uncommitted, undeployed)

All minor/patch bumps, no breaking changes expected.

| Package | Before → After | Severity | Source | How |
|---|---|---|---|---|
| `undici` | 6.21.3 → 6.24.1 | 4× high + 2× mod (6 CVEs) | `@discordjs/*`, `fetch()` | `npm audit fix` |
| `lodash` | 4.17.23 → 4.18.1 | high (code injection) + mod (prototype pollution) | transitive | `npm audit fix` |
| `path-to-regexp` | 0.1.12 → 0.1.13 | high (ReDoS) | transitive | `npm audit fix` |
| `picomatch` | 4.0.3 → 4.0.4 | high (ReDoS) + mod (method injection) | vitest, tinyglobby | `npm audit fix` |
| `rollup` | 4.57.1 → 4.60.1 | high (path traversal) | dev tool | `npm audit fix` |
| `yaml` | 2.8.2 → 2.8.3 | moderate (stack overflow) | transitive | `npm audit fix` |
| `qs` | 6.14.1 → 6.14.2 | low (DoS) | transitive | `npm audit fix` |
| `discord.js` | 14.25.1 → 14.26.2 | moderate (via undici) | direct | `npm audit fix` |
| `bn.js` | 5.2.2 → 5.2.3 | moderate (infinite loop) | direct, exact-pinned | Manual edit to `package.json:27` |

`bn.js` required a manual pin bump because `npm audit fix` respects semver
ranges and the pin was exact (`"5.2.2"`, not `"^5.2.2"`). Exact-pinning is
preserved per the 2026-04-01 security audit hardening ("npm deps pinned to
exact versions"). After the pin bump + `npm install`, all Solana-ecosystem
parents dedup to 5.2.3 cleanly. No overrides needed.

### 4 vulns remaining — Meteora SDK chain, unfixable

```
bigint-buffer (no fix available — maintainer has not shipped a patch)
  └─ @solana/buffer-layout-utils
      └─ @solana/spl-token (>=0.2.0-alpha.0)
          └─ @meteora-ag/dlmm
```

All four report as **high** severity, but they all resolve to the same root
cause: `bigint-buffer.toBigIntLE()` has an unpatched buffer overflow
(GHSA-3gc7-fjrx-p6mg). Every Solana project that uses `@meteora-ag/dlmm` is
stuck with this chain.

### Trust-boundary analysis — why these 4 are defensible as accepted risk

The exploit requires an **attacker-controlled byte buffer** to reach
`toBigIntLE()`. In crank-money's trust model:

| Source of bytes reaching this function | Trust level | Attacker control? |
|---|---|---|
| Solana RPC responses (Helius Pro) | Trusted | No |
| Helius LaserStream gRPC | Trusted | No |
| On-chain account data (SPL Token accounts) | Trusted (protocol layout) | No |
| Local bot keypair file | Trusted | No |
| User input to Discord bot | Untrusted, **BUT** — user input is parsed via `parseInt`/`parseFloat`/`new BN()`, never hits `bigint-buffer` | No |

There is no data path from untrusted input to `toBigIntLE()`. The SPL Token
account layout is fixed-width (u64 at offset 64, always 8 bytes), and the
function is called on known-size slices — the oversized-input exploit
condition does not apply.

### Options for dealing with the 4 remaining

1. **Accept and document** (recommended) — write a note in `security.md`
   (check if one exists; one is implied by the CLAUDE.md audit section but
   may not be a real file) acknowledging the 4 vulns with this
   trust-boundary rationale. Re-evaluate on every Meteora SDK bump.
2. **Override experiment** — try `"overrides": { "@solana/spl-token": "0.4.14" }`
   in `package.json` to force the whole tree to latest. The audit range
   says `>=0.2.0-alpha.0` has the vuln, so this is likely a no-op, but worth
   30 seconds to verify.
3. **Fork Meteora SDK** — huge maintenance cost, not worth it.

---

## Thread 2: deploy coordination — shared working tree

**Status:** Uncommitted changes from multiple sources in a single working
tree. No commits since `fd9f2aa cleanup`. No git recovery anchor.

### What's in the working tree (as of this doc)

Approximately 60+ modified files, spanning:
- **The other Claude's PDA vault migration work** — `programs/bin-farm/src/lib.rs`,
  all of `packages/core-sdk/generated/bin-farm/*` (regenerated Codama
  clients), `bot/idl/bin_farm.json`, `bot/idl/epoch_vault.json`, etc.
- **This Claude's audit/cleanup sweep** — header comments in
  `programs/bin-farm/src/lib.rs` + `programs/merkle-distributor/src/lib.rs`,
  bot doc drift fixes (`bot/claude-bot.md`, `bot/anchor-harvest-bot.ts:80`),
  `/api/fees` endpoint extension (`bot/relay-server.ts` + `bot/anchor-harvest-bot.ts:259`),
  scripts cleanup (`scripts/preflight-check.ts` full rewrite,
  `scripts/fee-dashboard.ts` deleted), discord-bot cosmetic fixes
  (`src/deploy-commands.ts:29`, `src/notifier.ts:148`, `src/commands/balance.ts`),
  `packages/core-sdk/constants.ts` + `pda.ts` rename
  (`PEGGED_BRIDGE_PROGRAM_ID` → `EPOCH_VAULT_PROGRAM_ID`),
  `claude.md` + `README.MD` file map updates.
- **The npm audit fix changes** — `package.json` + `package-lock.json`
  (Thread 1 above).

### Why this matters for sequencing

`scripts/deploy.sh` does `rsync --delete` of the entire project dir. Any
deploy ships **everything** in the working tree, not just one thread's
changes. The last deploy (13:42 UTC) already pushed the bulk of the
PDA migration + my audit/cleanup work. The npm fixes are the net-new
uncommitted work since then.

### Recommended sequence on return

1. **Commit what's already in the tree as a recovery anchor.** Even a messy
   WIP commit. Right now there's no rollback point between `fd9f2aa` and
   "whatever happens next." Suggested: one commit for the PDA migration
   work (other Claude's scope) and one commit for the audit sweep + npm
   fixes (this Claude's scope). Or even just one big commit — better than
   zero commits.
2. **Confirm with the other Claude that their work is in a shippable state.**
   Specifically: did they run force-close on the ~2 pre-migration user
   positions? Did the epoch dry-run pass? Without that, deploying again
   may not be appropriate.
3. **Decide on npm deploy timing** — see Thread 3.

---

## Thread 3: do the npm fixes need a redeploy?

**Technical answer:** Yes, to actually protect the running bot. The fixes
live in `package.json` + `package-lock.json` locally. On next
`./scripts/deploy.sh`, rsync pushes the updated lockfile, and the droplet
runs `npm install --omit=dev` which resolves to the new patched versions.
No special handling needed — it's a normal deploy.

**Deploy impact:**
- Fresh bot restart (brief gRPC drop, ~5s reconnect)
- Position registry rebuilds from gRPC stream
- No on-chain state change, no data migration

**Urgency:** Low. The highest-severity runtime-relevant fix is `undici`
(Discord gateway uses undici WebSocket; a malicious intermediate could
theoretically crash the client). Discord's gateway is Cloudflare-fronted
and operationally trusted. Not actively being exploited anywhere.

**Options:**
1. **Deploy standalone now** — push the npm fixes as their own deploy,
   after committing. Cleanest blame surface.
2. **Batch with next natural deploy** — whenever the next change lands,
   the npm fixes ride along.
3. **Hold and test locally first** — `npm run bot` for a smoke test
   before deploying (catches any runtime surprises from the undici bump).
   Probably overkill for minor version bumps but safest.

---

## Observation — position registry state after the redeploy

The `/api/stats` health check shows `positionCount: 1` post-restart. The
one position is:

- `positionPDA: 9mfjS4o6YxiUNFr2JrPwTod1wkonvenJjy34knsYVP6D`
- `owner: 56UrucGXHYPfsXS8BMZG82UA632fHDB1o6aXWwt9i6PR` (**RoverAuthority PDA,
  not a user vault**)
- `lbPair: 9R9gcCqPazHZt217aqh3fYDNBGnqENcupWYd97LYiUDp` (**CRANK/SOL**, binStep 80)
- `side: Sell`, 70 bins wide (`-1115` → `-1046`), `fillPercent: 0`

This is a **fee rover position**, protocol-owned, not a user position. It's
the keeper recycling accumulated CRANK fees into a sell-side DLMM position
to convert them back to SOL. No user positions are currently in the
registry — either because:
- (a) The other Claude force-closed the ~2 pre-migration user positions
  before the upgrade, and no new user positions have been opened on the
  new binary yet.
- (b) User positions exist on-chain but the bot's in-memory registry
  hasn't rediscovered them post-restart (the registry is event-driven
  via gRPC; positions get indexed when they next emit an event).

**Ask the other Claude** which one it is. If (a), things are clean. If
(b), consider triggering a registry rebuild or waiting for natural
activity to populate it.

Also: `roverPoolCount: 0` and `roverTotalTvl: 0` despite the rover being
tracked. This is rover-TVL aggregation, which the keeper populates on its
daily tick. Not populated yet post-restart. Expected.

---

## Decision points on return — ALL RESOLVED (2026-04-11)

1. **Commit strategy** — One big commit (`3599816`). Done.
2. **Coordinate with other Claude** — Force-close + epoch dry-run were complete. Confirmed.
3. **npm fixes** — Batched with the commit. Deployed.
4. **4 remaining Meteora vulns** — Accepted risk. Trust-boundary analysis above stands.
5. **User position registry** — Was (a): force-close happened, no user positions on new binary.

---

## Resume commands

```bash
# See current working tree state
git status --short

# See what npm thinks post-fix
npm audit

# Test locally before deploying (optional smoke test)
npm install && npm run bot   # ^C after a few seconds if gRPC connects OK

# Deploy (when ready)
./scripts/deploy.sh

# Post-deploy verification
ssh -i ~/.ssh/id_ed25519_deploy root@159.223.133.9 \
  'curl -s http://localhost:8080/api/stats | python3 -m json.tool'
ssh -i ~/.ssh/id_ed25519_deploy root@159.223.133.9 \
  'curl -s http://localhost:8080/api/fees | python3 -m json.tool'
```
