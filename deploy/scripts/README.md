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

## The scripts

| Script | Run by | What it does |
|---|---|---|
| `e2e.ts` | the `scripts` service (profile `e2e`) | the cross-stack proof — provisioning, four cases, global assertions |
| `provision-solver-fees.ts` | the `solver-provision` one-shot when `SOLVER_PROVISION_MINT_TOKENS=false` | gives the solver **fee currency only**: NIGHT from genesis, dust registration, ladder config from the published colors, and a receipt of the wallet's measured balances. **Mints nothing.** The funded counterpart is `packages/solver/scripts/bootstrap-dev.ts`, unchanged |
| `post-maker-offer.ts` | the `maker-offer` one-shot | a thin CLI over `lib/maker-offer.ts` |
| `offer-poster.ts` | the `offer-poster` service (profile `poster`) | the only LONG-RUNNING script here. Every `POST_INTERVAL_MS` it posts one Offer File whose single input is a coin it can name — a released coin from its journal, or one it mints that tick. Decisions live in `lib/poster-{config,tick,scheduler,health}.ts` behind injected dependencies; this file wires the real wallet, contract, kernel client and journal to them. `DRY_RUN=true` does everything except mint and post, prints a JSON report and exits 0 |
| `read-wallet.ts` | by hand, after `docker compose stop solver` | reads and asserts one wallet's balances — the solver-surplus gate. `EXPECT_SHIELDED_ONLY=true` additionally asserts the wallet holds nothing beyond the listed colors |
| `probe-backend-currentness.ts` | by hand | reproduces the E1 §9.2 sync diagnosis |

## The capital-free (SC-004) configuration

```
SOLVER_PROVISION_MINT_TOKENS=false      # fee currency only
E2E_REQUIRE_UNFUNDED_SOLVER=true        # the driver asserts the premise
SOLVER_DUST_MAX_PER_JOB=100000000000000000
SOLVER_DUST_MAX_PER_WINDOW=10000000000000000000
SOLVER_DUST_WINDOW_MS=3600000           # so the live DUST estimate is journalled
```

With it, the driver additionally asserts that the solver held **zero of every
shielded token** when it booted (from the provisioning receipt — this driver
cannot open that facade itself while the solver holds it), that a token-less
solver still publishes non-empty whole-rung price levels at the unmodified
reference relay, and that every settled job journalled a live-chain DUST
reservation and was accepted first try. It records those figures to
`94-fee-sizing-chain-facts.json`.

## What the driver owes (spec FR-009 / SC-005)

1. **Provision.** Fund maker and taker dev wallets. Since 00006 the solver needs
   **no swap-token inventory** to quote or settle whole-maker rungs — fee sizing
   no longer spends its tokenIn, and the publication cap that forced is gone.
   tokenOut still buys *interior* (interpolated) sizes: with none, the solver
   publishes each pair's first rung and no more. `mint-test-tokens` (run by the
   `offerfiles-deploy` one-shot) credits the **genesis** wallet only, so moving
   any tokens the cases need is this driver's job. 00006-V1 reran exactly this
   flow with solver token provisioning DISABLED (`SOLVER_PROVISION_MINT_TOKENS=
   false`) as its real-boundary proof — see "The capital-free (SC-004)
   configuration" above.
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
