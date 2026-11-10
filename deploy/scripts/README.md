# Deployment scripts

These scripts exercise the real wallet, kernel and Celestia paths. They do not
deploy an issuer or create token inventory.

| Script | Caller | Responsibility |
|---|---|---|
| `post-maker-offer.ts` | `maker-offer` one-shot | Post one real offer using explicit token IDs and an already funded maker wallet. |
| `offer-poster.ts` | opt-in `offer-poster` loop | Adopt matching spendable coins, journal before build, quote, post, verify and re-offer released inventory. |
| `read-wallet.ts` | manual, with the target service stopped | Measure and assert wallet balances without changing them. |
| `probe-backend-currentness.ts` | manual diagnosis | Inspect backend sync/currentness. |

Both swap token IDs must be 64 hexadecimal characters, distinct, and nonzero.
Token amounts are base units; use the network registry to determine decimals.
Wallet seeds must be funded through the selected network's supported external
issuer or funding process before these scripts start.

The poster's decision code lives in `lib/poster-{config,journal,tick,scheduler,
health}.ts`. Tests cover arbitrary explicit token IDs, wallet inventory filters,
durable recovery, reconciliation, exact-input/nullifier safety, quote and
sponsorship failures, retry/refusal taxonomy, cadence and health reporting.

The COW solver's provisioning, end-to-end and live acceptance scripts live in
[effectstream/cow-solver](https://github.com/effectstream/cow-solver).
