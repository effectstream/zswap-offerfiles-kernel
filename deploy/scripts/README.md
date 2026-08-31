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

1. **Provision.** Fund maker and taker dev wallets. Since 00006 the solver needs
   **no swap-token inventory** to quote or settle whole-maker rungs — fee sizing
   no longer spends its tokenIn, and the publication cap that forced is gone.
   tokenOut still buys *interior* (interpolated) sizes: with none, the solver
   publishes each pair's first rung and no more. `mint-test-tokens` (run by the
   `offerfiles-deploy` one-shot) credits the **genesis** wallet only, so moving
   any tokens the cases need is this driver's job. 00006-V1 reruns exactly this
   flow with solver token provisioning DISABLED as its real-boundary proof.
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
