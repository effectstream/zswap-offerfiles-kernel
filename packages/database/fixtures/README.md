# Canonical mint-test-tokens registry snapshots

These fixtures pin the public registry documents used to verify database seeds
and selected-network replacement without requiring network access during tests.
They were downloaded from `https://mint-test-tokens.pages.dev/metadata.<network>.json`
on 2026-09-07/08 and are consumed by `token-registry.test.ts`.

| Network | Registry revision | SHA-256 |
|---|---|---|
| Preprod | `ebd5eaba58ab2a7789d1e13cac3c1cc793f163e2e6f372f7839029c7f2d9f4bc` | `9e0087b1ffd83b5ebf2a11b8690a3b48bd84728dc67d5ddd488b72dbbd544350` |
| Preview | `c15d38f3a00a319c15ff10e39a2d4926763a4438e7fbb3bfc202bd15aa5a7d28` | `0edf2aaab3c9a7e770d2097809213e5c84304deb4f47710d5f7620ac451c4fc6` |
| Stagenet | `59041d2fd2acfdad53e437e5a4d2ba88a6f24e4f9e55869b66f465f3da11a0d1` | `973977bc0dbf7eae6afd4b1d92f365326b2b69d257f3597cdaffa9dac34839d0` |

The published Preprod document semantically matches
`metadata/metadata.preprod.json` in
`effectstream/mint-test-tokens` commit
`4a6aee1ed50dea17875f28b2d2cf398bfee315fb`. Preprod is the authoritative
source for `000-init.sql`; Preview and Stagenet are replacement-test inputs and
must never be substituted for Preprod defaults.
