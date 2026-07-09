# `@zswap-da/mip6-p2p-swaps`

**MIP-0006 (Peer-to-Peer Atomic Swaps)** core library for this template.

Owns payload types, authoritative gives/wants derivation (with
`SHIELDED` / `UNSHIELDED` tags), the two-sided swap rule, and helpers to build
on-chain / off-chain offer payloads.

This package does **not** publish to Celestia or serve the indexer REST API —
those stay in `@zswap-da/node` / `@zswap-da/batcher` for now. Full DA/API
alignment (raw `OnchainOfferPayload` on Celestia, `OffchainOfferPayload`
responses, `mn-swap-v1` namespace) is deferred.

See the draft at the repo root: `WIP MIP6`. Depends on MIP-0005 via
`@zswap-da/mip5-offer-files`.

## API

| Export | Role |
|--------|------|
| `TokenKind`, `TokenLeg`, `OnchainOfferPayload`, `OffchainOfferPayload` | Spec types (`version: 1`) |
| `deriveTokenLegs(tx)` | Gives/wants with layer tags |
| `isTwoSidedSwap` / `assertTwoSided` | Reject give-only offers |
| `buildOnchainOfferPayload` | DA payload constructor (not posted yet) |
| `toOffchainOfferPayload` | Discovery payload builder (API not switched) |
| `earliestIntentTtl` | Intent TTL → `expiresAt` helper |
| `UnknownTokenTagError` | Unexpected token tag |
