# `@zswap-da/mip5-offer-files`

**MIP-0005 (Offer Files)** reference codec for this template.

Encodes a proven, imbalanced Midnight `Transaction` as a bech32m string with
HRP `swapoffer`, and decodes it back to transaction bytes / a `Transaction`.

See the draft at the repo root: `WIP MIP5`.

## API

| Export | Role |
|--------|------|
| `OFFER_HRP` | `"swapoffer"` |
| `encodeOffer(bytes)` | Raw tx bytes → `swapoffer1…` |
| `decodeOffer(text)` | `swapoffer1…` → raw tx bytes |
| `offerToBech32(tx)` | `Transaction` → `swapoffer1…` |
| `offerFromBech32(text)` | `swapoffer1…` → `Transaction` |

The bech32 90-character limit is **not** enforced (MIP-0005).
