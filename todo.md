# crank.money — TODO

Shipped items live in `claude.md` (Current state) and the audit addenda.
This file is only open work, blockers, and roadmap.

---

## OPEN

### BANK Metadata
Blocked on the logo. Everything downstream follows from that.
- [ ] Create $BANK logo image
- [ ] Host off-chain metadata JSON + image (Arweave or GitHub)
- [ ] Register Metaplex token metadata on mint `BtHc83DaTbbtmZwqy7WNUgDM7jUXVULcAtuPYgx2J1TA`
- [ ] Verify renders in Phantom / Solflare / Jupiter

### Keypair Separation (Audit C-02)
Blocked on Ledger acquisition. Runbook: `runbooks/keypair-separation.md`.

### X tweet auto-submit
Baseline-flex currently posts a tweet draft to the ops channel for manual copy/paste. Wire to crank-crm's drafter for auto-submit when crank-crm exposes an inbound HTTP endpoint.

"If you had bought this on Jup, you would have gotten X% less or more."

---

## BUILDS (roadmap, not close-to-ship)

### Telegram Adapter
Core-SDK is platform-agnostic. ~300-400 lines. After Discord is proven.

### Envoys
Analytics for Bots // AI which pulls and evaluates data for placement on select pools to seed market making.
