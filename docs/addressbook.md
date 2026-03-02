# Address Book — Reference

> Pool discovery + server-side address book shipped Mar 1, 2026. This doc retains the architectural decision record, Meteora DataPI reference, and Phase 2 on-chain trade passport plan.

---

## Why Server-Side, Not On-Chain

The original idea was a Metaplex Core NFT with AppData. After analysis, the server-side approach wins on every axis that matters:

| | Server-side (relay) | On-chain (AppData NFT) |
|-|---|---|
| **Cost to user** | Free | ~0.003 SOL first time, tx fees per write |
| **Wallet interactions** | Zero | Extra tx per trade (signAllTransactions) |
| **Capacity** | Unlimited | ~25 entries (tx size limit) |
| **Dead pool filtering** | Server enriches with live Meteora data | Client must fetch separately |
| **Ranking/sorting** | Server-side, tunable without redeploy | Client-side only |
| **Includes closed positions** | Yes (historical) | Only what was written |
| **Implementation effort** | ~1 relay endpoint + frontend fetch | Umi SDK, mpl-core, signAllTransactions, esbuild config |
| **Availability** | Depends on DO server | Always on-chain |
| **Portability** | Locked to monke.army | User-owned, readable by any app |

The portability/on-chain angle is cool but not needed for "the platform remembers." See Phase 2 below.

---

## Meteora DataPI Reference

**Base URL:** `https://dlmm.datapi.meteora.ag`
**Rate limit:** 30 RPS
**Auth:** None

### Endpoints

**GET `/pools`** — paginated pool list with sort

| Param | Type | Example |
|-------|------|---------|
| `page_size` | int | `10` (default 10, max 100) |
| `page` | int | `1` (1-indexed) |
| `sort_by` | string | `volume_24h:desc`, `tvl:desc`, `fee_tvl_ratio:desc` |

**GET `/pools/groups`** — pools grouped by token pair

| Param | Type | Example |
|-------|------|---------|
| `page_size` | int | `10` |
| `sort_by` | string | `volume_24h:desc` |

**GET `/pools/groups/{lexical_order_mints}`** — all pools for a specific token pair

The `{lexical_order_mints}` path param is both mint addresses joined with `-`, sorted lexicographically. Example for BONK-SOL:
```
DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263-So11111111111111111111111111111111111111112
```

Returns all pools (different bin steps) for that pair, with sort/pagination.

**GET `/pools/{address}`** — single pool detail

### Response shape (from `/pools`)

```json
{
  "total": 99432,
  "pages": 9944,
  "current_page": 1,
  "page_size": 10,
  "data": [
    {
      "address": "BGm1tav58oGc...",
      "name": "SOL-USDC",
      "token_x": {
        "address": "So111...",
        "name": "Wrapped SOL",
        "symbol": "SOL",
        "decimals": 9,
        "is_verified": true,
        "holders": 3820662,
        "price": 84.72,
        "market_cap": 48262681187
      },
      "token_y": {
        "address": "EPjFW...",
        "name": "USD Coin",
        "symbol": "USDC",
        "decimals": 6,
        "is_verified": true,
        "price": 1.0,
        "market_cap": 8970098169
      },
      "pool_config": {
        "bin_step": 10,
        "base_fee_pct": 0.1,
        "max_fee_pct": 0.0,
        "protocol_fee_pct": 5.0
      },
      "tvl": 5291752.33,
      "current_price": 84.77,
      "apr": 0.7519,
      "volume": {
        "30m": 732510, "1h": 1374743, "2h": 3388417,
        "4h": 6954488, "12h": 16948635, "24h": 40486843
      },
      "fees": { "30m": 722, "1h": 1346, "24h": 39788 },
      "fee_tvl_ratio": { "30m": 0.0136, "24h": 0.7519 },
      "is_blacklisted": false,
      "is_verified": true,
      "has_farm": false
    }
  ]
}
```

### Legacy API (fallback)

**Base URL:** `https://dlmm-api.meteora.ag`

**GET `/pair/all_with_pagination`** — paginated, sortable

| Param | Example |
|-------|---------|
| `page` | `0` (0-indexed) |
| `limit` | `10` |
| `sort_key` | `volume` |
| `order_by` | `desc` |

Response shape: `{ pairs: [...], total: N }`. Each pair has `address`, `name`, `mint_x`, `mint_y`, `bin_step`, `liquidity`, `trade_volume_24h`, `fees_24h`, `current_price`, `apr`, `is_blacklisted`, `is_verified`, `volume: { min_30, hour_1, ... }`, `fees: { ... }`, `fee_tvl_ratio: { ... }`.

Does NOT include token metadata (name, symbol, decimals, price) — only mints.

### Token CA resolution strategy

Lexical-order key for pair lookup: both mint addresses sorted lexicographically, joined with `-`. Try token/SOL and token/USDC pairs in parallel via `/pools/groups/{key}`. Merge, sort by `volume_24h:desc`. Single result auto-loads; multiple results show picker.

---

## Phase 2 — On-Chain Trade Passport (Future)

The server-side address book covers the core UX. If there's later demand for a user-owned, portable, on-chain record, the Metaplex Core AppData approach is still viable:

- Mint a "monke trade passport" Core NFT per user
- AppData plugin (Binary schema, dataAuthority = user wallet)
- 40 bytes/entry (32B pubkey + 8B timestamp), max ~25 entries per tx
- Write via `signAllTransactions` alongside position tx
- LRU eviction at 25 entries
- DAS-indexed for off-chain queries
- Management page: user can edit/remove entries directly (they're the dataAuthority)
- Full SDK reference, serialization code, Umi integration details preserved from earlier research

This is a standalone feature. Ship when there's user demand for portable trade history or if the product expands to multi-frontend scenarios where server-side data isn't accessible.
