# Canonical token-registry fixtures

`registry-v2.preprod.synthetic.json` is a **synthetic** registry document in the
mint-test-tokens registry format (`schemaVersion` 1.0.0), labelled for the
ledger-9 line: `network.protocolFamily` `midnight-2.x` and
`compatibility.profile` `v2`, with the stable Midnight 2.x versions (compactc
0.36.0, compact-runtime 0.21.0, ledger-v9 1.0.0, midnight-js 5.0.0, wallet-sdk
2.0.0).

Its contract addresses, token ids, transactions and block hashes are not real:
each is `sha256("registry-fixture-v2:preprod:<symbol>:<field>")`, so no colour in
it can be mistaken for a deployed token. On 2026-11-09 no public network had a
published ledger-9 registry (`metadata.preview.json` and
`metadata.preprod.json` at `https://mint-test-tokens.pages.dev/` are labelled
`midnight-1.x` / `v1`, and `metadata.mainnet.json` does not exist), so the
importer's accept path is tested against this document. The 1.x skip path is
tested by relabelling it in memory the way the published files are labelled.

| File | Registry revision | SHA-256 |
|---|---|---|
| `registry-v2.preprod.synthetic.json` | `09cfd670d5670755d49e9162ba268166f78713f75bb518539dcf9165aecd4ce0` | `710a6fce5c8ca13864df4b6d9c4182a209deb6d4a9e9697c485374d0c4af4497` |

Consumed by `token-registry.test.ts`.
