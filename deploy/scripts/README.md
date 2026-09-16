# Deployment scripts

These scripts exercise the real wallet, kernel, relay, solver and Celestia
paths. They do not deploy an issuer or create token inventory.

| Script | Caller | Responsibility |
|---|---|---|
| `provision-solver-fees.ts` | `solver-provision` one-shot | Validate externally prefunded NIGHT and usable DUST; write a factual fee-inventory receipt. |
| `post-maker-offer.ts` | `maker-offer` one-shot | Post one real offer using explicit token IDs and an already funded maker wallet. |
| `offer-poster.ts` | opt-in `offer-poster` loop | Adopt matching spendable coins, journal before build, quote, post, verify and re-offer released inventory. |
| `e2e.ts` | `scripts` service in profile `e2e` | Run local end-to-end offer/solver/settlement assertions using explicit, externally funded tokens. |
| `read-wallet.ts` | manual, with the target service stopped | Measure and assert wallet balances without changing them. |
| `probe-backend-currentness.ts` | manual diagnosis | Inspect backend sync/currentness. |
| `live-cow-case.ts` | isolated acceptance harness | Execute a declarative whole-offer live case with pre-offer balances, live quote/refusal samples, exact physical-file statuses, journal receipts and pinned source/image identity. |
| `live-cow-read.ts` | isolated acceptance harness, after solver stop | Reopen every actor and solver through fresh synchronized wallet facades and reconcile all listed assets plus the no-unlisted-assets condition. |
| `live-cow-export-journal.ts` | isolated acceptance harness, after solver stop | Export complete operation, relay/backend receipt and DUST reservation rows from the preserved SQLite journal. |

Both swap token IDs must be 64 hexadecimal characters, distinct, and nonzero.
Token amounts are base units; use the network registry to determine decimals.
Wallet seeds must be funded through the selected network's supported external
issuer or funding process before these scripts start.

`provision-solver-fees.ts` calls `registerNightForDust` only for the solver's
already held NIGHT. A `false` return or error is fatal and includes the external
NIGHT/DUST prerequisite. Its receipt records `inventorySource`, `dustReady`, the
live-book pricing source and measured balances. It accepts no pair or ladder
input and does not claim a successful state after a failed registration.

The poster's decision code lives in `lib/poster-{config,journal,tick,scheduler,
health}.ts`. Tests cover arbitrary explicit token IDs, wallet inventory filters,
durable recovery, reconciliation, exact-input/nullifier safety, quote and
sponsorship failures, retry/refusal taxonomy, cadence and health reporting.

The `live-cow-*` scripts are reusable acceptance tools, not production startup
services. `live-cow-case.ts` requires a version-1 scenario JSON, a factual
asset receipt, a solver provisioning receipt, an evidence directory, and exact
source/tree/image and relay pins through `COW_LIVE_*`, `COW_SOURCE_*`, and
`COW_RELAY_*` environment variables. It measures maker and taker balances
before any offer reserves a coin. A phased scenario can prove a refusal while
a control quote is live, then add a valid control offer. A contention scenario
requires admission and advertised relay capacity of at least two, captures both
quotes before concurrent intent dispatch, and rejects capacity/saturation as a
shared-file-contention result. Every positive settlement also binds every
consumed physical file to one backend ledger transaction/height, matches that
binding to the journal and relay receipt, verifies empty new-job claim payouts,
requires terminal `SPENT` DUST with the built transaction's measured fee
contribution, and waits for zero active claims and DUST holds. Stop the solver
before `live-cow-read.ts` opens its seed. Run `live-cow-export-journal.ts` only
after that stop with `COW_SOLVER_STOPPED_ASSERTED=true`; it creates a coherent
SQLite serialization from the stopped volume, checks terminal rows and writes
the authoritative journal export. Preserve service logs before resetting case
volumes.
