# Helius → Alchemy gRPC migration prep

## Why

The current Helius LaserStream subscription is paid; Root has 90 days of free Alchemy gRPC sitting in the trial. Net-zero option-value to migrate before the trial expires. This doc captures every surface that would change so the actual cutover is a single-file diff plus an env rename.

This is *prep*, not the migration. No code changes here.

## Today (Helius footprint)

The bot's gRPC coupling is intentionally narrow — `bot/geyser-subscriber.ts` is the only file that talks to Helius directly. Everything else (executor, keeper, relay) consumes the subscriber's callbacks.

### Imports + dependencies

- `bot/geyser-subscriber.ts:534` — `const { subscribe, CommitmentLevel } = await import('helius-laserstream');`
- `bot/geyser-subscriber.ts:703` — `const { shutdownAllStreams } = await import('helius-laserstream');`
- `scripts/test-laserstream.ts:15` — `import { subscribe, CommitmentLevel } from 'helius-laserstream';`
- `package.json` — `"helius-laserstream": "^0.3.1"` in `dependencies`.

### Endpoint + auth

- `bot/geyser-subscriber.ts:539` — auth resolution: `url.searchParams.get('api-key')` or `'x-token'` query, fallback to `process.env.GRPC_TOKEN`.
- Endpoint pulled from constructor param `grpcEndpoint` (env var: `GRPC_ENDPOINT`).
- `scripts/preflight-check.ts:14` — also reads `RPC_URL`. (HTTP RPC, not gRPC — separate concern but worth flagging during the cutover.)
- `packages/discord-bot/src/index.ts:199` — `process.env.HELIUS_RPC_URL ?? process.env.RPC_URL` fallback (HTTP). Already collapsed to `RPC_URL` post-demolition.

### Subscription shape

- `bot/geyser-subscriber.ts:528-602` — `subscribe()` callback model: `(message) => …` for accounts/transactions, plus error handler.
- `CommitmentLevel.CONFIRMED` enum (line 556).
- Account filter syntax: `{ account: [poolPubkey], filters: [{ datasize: 904 }] }` for Meteora `LbPair` accounts.
- `replay: true` flag (line 543) — gives 24h replay on reconnect, important for not missing bin transitions during connection drops.
- Health check: SDK exposes `pongs` / connection state (lines 606-710).

### Latency baseline

`bot/geyser-subscriber.ts:528-540` reports ~180ms bin-change → harvest in steady state. This is the number to beat (or at least match) on Alchemy.

## Target (Alchemy gRPC)

Open questions to resolve before cutover (need to read Alchemy's current docs):

- **Package name.** Likely `@alch/yellowstone-grpc-client` or similar Yellowstone-compatible SDK; needs verification.
- **Auth model.** Alchemy typically uses header-based API keys (`Authorization: Bearer …`). Helius uses URL-query `api-key`. Auth-resolution code in `geyser-subscriber.ts:539` will need adjustment.
- **Endpoint pattern.** `solana-mainnet.g.alchemy.com:443` vs Helius `mainnet.helius-rpc.com:443`. Confirm protocol scheme.
- **Subscription schema.** Both are Yellowstone-derived, so the message shape *should* be compatible — but Alchemy may use `CommitmentLevel` strings (`"confirmed"`) instead of enum values.
- **Account + datasize filter.** The `{ account, filters: [{ datasize }] }` shape is core Yellowstone. Should port directly. Verify before cutover.
- **Replay window.** Helius gives 24h replay with `replay: true`. Alchemy's replay support and window need verification — if shorter, reconnect handling needs tighter timeouts.
- **Health/heartbeat semantics.** Helius pings; Alchemy may use a different mechanism.
- **Rate limits.** Helius LaserStream has generous account-subscription limits; Alchemy's caps need confirmation against the bot's current ~2-15 watched pools.

## Migration plan (when ready to execute)

1. **Env vars.** Add `ALCHEMY_GRPC_ENDPOINT` + `ALCHEMY_API_KEY` (or whatever Alchemy expects). Keep `GRPC_ENDPOINT` + `GRPC_TOKEN` as fallback during the dual-run period.
2. **Package swap.** `npm uninstall helius-laserstream && npm install <alchemy-grpc-package>` once verified.
3. **Single-file edit.** `bot/geyser-subscriber.ts`:
   - Swap dynamic imports (lines 534, 703).
   - Adjust auth resolution (line 539) to match Alchemy's pattern.
   - Verify `CommitmentLevel` enum vs string (line 556).
   - Verify account+datasize filter shape (lines ~551-557).
4. **Caller surface unchanged.** Subscriber's external callback signatures (`onHarvestJob`, `onCloseJob`, `onPositionUpdate`) stay the same — orchestrator, executor, keeper, relay don't change.
5. **`scripts/test-laserstream.ts`** gets the same import swap. Useful as a pre-flight before cutting over the bot.
6. **Update file header comment** in `geyser-subscriber.ts:7` ("Optimized for Helius LaserStream") to reflect the new provider.

## Validation plan

1. **Local dry-run.** Run `scripts/test-laserstream.ts` (Alchemy variant) against a live CRANK/SOL pool, confirm account updates flow through and `LbPair` deserializes correctly.
2. **Latency measurement.** Tee the bot's bin-change → harvest log for 1 hour; compare median + p99 to the Helius ~180ms baseline.
3. **Dual-run on dev droplet.** Run a parallel instance pointed at Alchemy for 24h. Cross-check harvest tx signatures against the prod (Helius) instance — they should be identical (same pool, same active-bin transitions).
4. **Replay test.** Force a disconnect (kill the gRPC connection); verify the bot catches up on missed bin transitions when it reconnects.
5. **Cut over prod.** Update `bot/.env` on the droplet, `pm2 restart crank-harvester`, monitor for 60 min. Roll back is a one-line env edit + restart.

## Out of scope for this prep

- HTTP-RPC migration (separate concern, lower urgency — current Helius RPC URL works fine).
- Helius Webhooks, Enhanced Transactions API, priority fee API — none used by the bot.
- Pricing-API migration — DexScreener-fronted (not Helius-coupled).
