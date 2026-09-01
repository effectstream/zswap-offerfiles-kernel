# `deploy/scripts/` — provisioning and the cross-stack E2E driver

Runs as the `scripts` Compose service (profile `e2e`, `restart: no`), inside the
stack's own network, so it reaches every component by the same service name the
components use for each other rather than through published host ports.

```bash
docker compose --profile e2e run --rm scripts
```

**D1 wired this component; the driver is E1's deliverable.** Until
`deploy/scripts/e2e.ts` exists, `entrypoint-scripts.sh` exits 69
(`EX_UNAVAILABLE`) rather than 0 — an E2E gate whose "pass" is indistinguishable
from doing nothing is the one failure mode it must not have.

## What the driver owes (spec FR-009 / SC-005)

1. **Provision.** Fund maker, taker and solver dev wallets.
   The solver needs **both** tokens of every pair it should quote, not just the
   payout token — publication is bounded by spendable tokenIn as well as
   reservable tokenOut, so an inventory-light solver publishes an empty ladder
   while looking perfectly healthy. `mint-test-tokens` (run by the
   `offerfiles-deploy` one-shot) credits the **genesis** wallet only, so moving
   the tokens is this driver's job.
2. **Maker offer.** Post a real zswap Offer File into the kernel; assert it
   appears in `GET /v1/offers` and in the solver's ladder at the relay
   (`GET /tokens` cross-container, `GET /state` from inside the relay container).
3. **Case A — exact advertised.** Taker quotes via `POST /quote` and consumes at
   the advertised output; assert on-chain settlement, the maker offer consumed,
   the taker credited exactly `amountOut`, a terminal SUCCESS in the solver
   journal, and no leaked Stock claim.
4. **Case B — lower exact output.** The P4-F01 proof, and the first time R1's
   surplus path meets the real wallet facade: its settlement leg can have an
   EMPTY `initSwap` input map, and whether the facade tolerates that (and
   whether `revertTransaction` accepts a leg that reserved no coins) is not
   verifiable offline. Assert settlement plus the solver's surplus retention.
5. **Case C — above advertised.** Refused; assert no settlement, no wallet
   mutation, no leaked claim.
6. **Evidence** to `E2E_EVIDENCE_DIR` (`/var/lib/e2e`, on the `e2e-evidence`
   volume): service logs, terminal states, transaction hashes.

Exit 0 means every assertion passed. Anything else is a failure.
