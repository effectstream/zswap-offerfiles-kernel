# Deployment scripts

These scripts exercise the real wallet, kernel, relay, solver and Celestia
paths. They do not deploy an issuer or create token inventory.

| Script | Caller | Responsibility |
|---|---|---|
| `provision-solver-fees.ts` | `solver-provision` one-shot | Validate explicit pair IDs, externally prefunded NIGHT and usable DUST; write the ladder and factual receipt. |
| `post-maker-offer.ts` | `maker-offer` one-shot | Post one real offer using explicit token IDs and an already funded maker wallet. |
| `offer-poster.ts` | opt-in `offer-poster` loop | Adopt matching spendable coins, journal before build, quote, post, verify and re-offer released inventory. |
| `e2e.ts` | `scripts` service in profile `e2e` | Run local end-to-end offer/solver/settlement assertions using explicit, externally funded tokens. |
| `read-wallet.ts` | manual, with the target service stopped | Measure and assert wallet balances without changing them. |
| `probe-backend-currentness.ts` | manual diagnosis | Inspect backend sync/currentness. |

Both swap token IDs must be 64 hexadecimal characters, distinct, and nonzero.
Token amounts are base units; use the network registry to determine decimals.
Wallet seeds must be funded through the selected network's supported external
issuer or funding process before these scripts start.

`provision-solver-fees.ts` calls `registerNightForDust` only for the solver's
already held NIGHT. A `false` return or error is fatal and includes the external
NIGHT/DUST prerequisite. Its receipt records `inventorySource`, `dustReady`, the
explicit pair and measured balances. It does not claim a successful state after
a failed registration.

The poster's decision code lives in `lib/poster-{config,journal,tick,scheduler,
health}.ts`. Tests cover arbitrary explicit token IDs, wallet inventory filters,
durable recovery, reconciliation, exact-input/nullifier safety, quote and
sponsorship failures, retry/refusal taxonomy, cadence and health reporting.
