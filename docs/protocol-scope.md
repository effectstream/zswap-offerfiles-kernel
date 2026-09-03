# Posted-Price Solver Protocol Scope

> # ⛔ SUPERSEDED — HISTORICAL DRAFT, NOT A DESCRIPTION OF THIS SOLVER
>
> This 2026-08-13 draft was never approved, and the product it proposes is **not**
> the solver in this repository. It describes a *public offer-book market maker*
> that reads the kernel book and submits directly; the implemented solver is a
> **Midnight Intents relay solver** — it connects outbound to a relay, publishes
> price ladders, and settles the swap jobs the relay dispatches to it.
> Decisions 1 and 4 below therefore contradict the shipped system, and Decision 2's
> "Path B" language predates the current relay job lifecycle.
>
> **Authoritative documentation** for what actually exists:
> [`README.md` → "Running the COW solver"](../README.md#running-the-cow-solver)
> and [`API.md` → "The COW solver (Midnight Intents side)"](../API.md#the-cow-solver-midnight-intents-side)
> — executable topology, supported domain (Midnight 2.x / ledger-v9, single-leg
> distinct-token shielded, ≤ 8 makers, optional shielded residual), `payFees:false`
> fee ownership, lower-demand/surplus job semantics, and the executability bounds
> on published liquidity.
>
> Retained only as a record of the original scoping decisions and of the
> default-off safety posture they justified (that posture still holds: mainnet
> live trading is off unless explicitly acknowledged, unsupported offer shapes
> fail closed, and solver ladders never replace the `/v1/quote` contract).
> Do not cite it as a specification, and do not implement from it.

## Status

**SUPERSEDED DRAFT — NEVER APPROVED, NOT APPROVED FOR REAL-FUND EXECUTION**

| Field | Value |
|---|---|
| Project | `00001-zswap-posted-price-solver` |
| Midnight target | 2.x / ledger-v9 |
| Drafted | 2026-08-13 |
| Approver | **UNASSIGNED** |
| Approval date | **UNAPPROVED** |
| Approval evidence | **NONE** |
| Superseded | 2026-08-28 — relay-solver architecture; see README.md / API.md |

This document proposes one narrow initial protocol so implementation and tests have a
decidable target. It is not organizational approval. Until the fields above are completed,
the runtime safety defaults in the final section are mandatory.

## Decision 1 — product and privacy boundary

> **SUPERSEDED.** The implemented solver IS a Midnight Intents relay solver: it publishes
> ladders to a relay and settles relay-dispatched jobs. It still makes no privacy claim
> beyond what the kernel book already publishes.

The initial product is a **public offer-book market maker**, not the Phase-1 private relay
solver. It reads fully published ZSwap offers from the KERNEL REST/SSE book and may use its own
inventory to accept a supported offer. It must not claim the privacy properties of a relay
solver that sees only private deltas.

This forecloses silently reusing Phase-1 relay assumptions about information disclosure,
job identity, or submission ownership. The Phase-1 implementation remains a lifecycle and
recovery reference only.

## Decision 2 — submission authority

> **PARTLY SUPERSEDED.** Solver-owned submission and exactly-once commit/revert with restart
> reconciliation are what the durable operation journal implements, and that part still holds.
> The "Path B / batcher-submitted" framing predates the relay job lifecycle, where the relay
> owns job identity and the solver owns its wallet mutation.

The initial supported execution protocol is **Path A only, submitted by the solver that owns
the wallet mutation**. The solver retains the exact recipe/finalized transaction and owns its
idempotent submit, confirm, commit, revert, timeout, stop, and restart reconciliation state.

Path B merging, batcher-submitted exact crossings, N-cycles, and residual top-ups are a
separate experimental protocol and remain disabled. Before Path B can be approved, it needs a
separate transition table in which the batcher owns one stable job identity and the solver has
no orphaned wallet mutation. This decision removes split authority from the initial protocol
and makes the rollback acceptance criterion exact: every retained Path A wallet operation
reaches one durable `committed` or `reverted` terminal state, including after restart.

## Decision 3 — supported offer shape

The initial protocol accepts only offers that normalize to **one SHIELDED input leg and one
SHIELDED output leg**, with distinct configured token colors and positive integer amounts.
Unknown leg kinds, unshielded legs, multi-leg offers, mixed value layers, duplicate spend
identities, and pairs outside the configured allowlist are rejected before admission.

This deliberately forecloses layer-collapsing accounting and partial support. Expanding the
shape requires layer-aware balance keys, conflict identities, wallet builders, and an oracle
test for the enlarged matcher.

## Decision 4 — quote semantics

> **STILL TRUE, DIFFERENT CONSUMER.** Ladders remain indicative rather than reservations, but
> they are published to the Midnight Intents relay (which interpolates them and dispatches
> jobs), not exposed through this backend's `/v1/quote`. A dispatched job's `amountOut` is the
> taker's exact demand and may be below the interpolated output — see API.md.

Published ladders are **authenticated indicative market data**, not executable reservations.
They carry publisher identity, declaration version, and freshness, but no inventory hold or
guarantee. They must not be described as a price “someone will actually honour.” An
executable quote would require a separate quote ID, exact amount, expiry, solver binding, and
atomic capacity reservation.

The established `/v1/quote` contract must either retain its token-price semantics or be
explicitly versioned. Solver ladder data may be exposed as an authenticated indicative source,
but cannot silently replace fields or precedence in the existing contract.

## Required implementation consequences

| Decision | Required change before approval |
|---|---|
| Public market maker | Documentation names the public-book privacy boundary and never labels this the Phase-1 relay solver |
| Solver-owned Path A | Stable operation ID, retained wallet handle, strict acknowledgement, absolute deadlines, exactly-once commit/revert, restart reconciliation |
| Single-leg SHIELDED | Exhaustive parser and allowlist reject every unsupported shape before scheduling or wallet work |
| Indicative levels | Authenticated per-solver declarations, full-declaration withdrawal, monotonic versions, eager expiry, no executable promise language |

## Mandatory default-off boundary while unapproved

- Mainnet/live trading defaults off and requires an explicit live acknowledgement.
- Path B, batcher settlement, N-cycles, and residual top-ups default off.
- Unsupported offer kinds and shapes fail closed.
- Missing levels authentication disables publication acceptance; it never falls back to an
  unauthenticated mode.
- Unknown status, timeout, malformed response, or ambiguous acknowledgement causes no wallet
  mutation or resubmission.
- Solver levels are not allowed to replace the established quote contract as executable data.

## Approval checklist

- [x] Each scope question has one proposed decision.
- [x] Each proposed decision names what it forecloses and the implementation it requires.
- [x] The Path A rollback acceptance sentence is decidable without another protocol ruling.
- [x] Contradictions with the current implementation are named as required changes.
- [x] Default-off behavior is explicit while this document remains a draft.
- [ ] A named owner approved the four decisions.
- [ ] Approval date and durable evidence are recorded above.
