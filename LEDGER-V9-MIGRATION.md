# ledger-v9 migration — audit, and where it is blocked

Branch `00001-ledger-v9`. Target: move this workspace off the ledger-v8 line
(`@midnight-ntwrk/ledger-v8@8.1.0`, midnight-js 4.1.1, wallet-SDK v1 facade,
`@effectstream/*` 0.103.x, compactc 0.30) onto the node-2.x line so the kernel
runs against Midnight node 2.0.0-rc.4 / indexer 4.4.0-rc.1.

| Component | From | To |
| --- | --- | --- |
| Ledger | `@midnight-ntwrk/ledger-v8` 8.1.0 | `@midnightntwrk/ledger-v9` 1.0.0-rc.3 (**new scope, no hyphen**) |
| midnight-js | 4.1.1 | 5.0.0-beta.6 |
| wallet-sdk | v1 facade | 2.0.0-beta.2 (`WalletFacade.init`) |
| compactc | 0.30.0 | **0.34.0** (language 0.26.0, runtime 0.19.0, compact-js 2.5.5-rc.7) |

**Current status (2026-09-04): the unified `ledger-v9` line has resolved the
original SDK blocker and now uses the Compact 0.34 compatibility boundary
below.** The original 0.30/0.31/0.33 investigation remains in this document as
migration history.

---

## Compact 0.34.0 compatibility boundary (2026-09-04)

The active line compiles with compactc **0.34.0**, language **0.26.0**, and
generated-code runtime **0.19.0**. `infra/compact-version.txt` is the only
compiler-version pin; `infra/compact-checksums.sha256` authenticates the exact
release archive selected for each supported Linux architecture before unzip.

| Linux asset | Exact release URL | SHA-256 |
|---|---|---|
| aarch64 musl | `https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v0.34.0/compactc_v0.34.0_aarch64-unknown-linux-musl.zip` | `d3e292c4f48e257dcd6b3d3e3e4743d7d8ea0729f48953eab91a366d44cd026d` |
| x86_64 musl | `https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v0.34.0/compactc_v0.34.0_x86_64-unknown-linux-musl.zip` | `775ccddf5a71399835329bbf7471ba5a8c54fcc825d372c75e19ba7042069584` |

> **BREAKING runtime requirement:** compactc 0.34-generated
> `contract/index.js` calls `checkRuntimeVersion('0.19.0')`. Every process that
> loads it must resolve `@midnight-ntwrk/compact-runtime` exactly to `0.19.0`.
> A controlled 0.18.0-rc.1 consumer fails at module load with `Version mismatch`.

> **BREAKING mint API/key requirement:** `mint_shielded` now takes an explicit
> `Either<ZswapCoinPublicKey, ContractAddress>` recipient as its fourth
> argument; `mint_unshielded` takes
> `Either<ContractAddress, UserAddress>` as its third. Both reject zero amounts.
> The changed mint ZKIRs produce new verifier keys, so **every ledger-v9
> OfferFiles contract instance must redeploy** and every caller must migrate in
> the same rollout.

The base source SHA-256 is
`6fde5f8e2cfc5d5559f1468f3997f72810aec3093c6a87a54036b9175dadd3f0`;
the final recipient-typed source is
`3cf4cb51a5bc6ad9ac02adf828254caeee68c5b861d31d7319106289ee0d2546`.
The 0.33 baseline was compiled twice, proving all nine files repeatable. An
intermediate compile of the unchanged source with 0.34 was byte-identical in all
nine rows, so compiler 0.34 alone causes no circuit/key drift. The shipping
old-source/0.33 to recipient-source/0.34 result is:

| Relative artifact | 0.33 bytes | 0.33 SHA-256 | 0.34 bytes | 0.34 SHA-256 | Result |
|---|---:|---|---:|---|---|
| `keys/incrementNoun.prover` | 76,645 | `cc812f6b7cd2e10734fc7093ba5d59ba0a3c79f74a01ceffae1aeae024b2d36d` | 76,645 | `cc812f6b7cd2e10734fc7093ba5d59ba0a3c79f74a01ceffae1aeae024b2d36d` | SAME |
| `keys/incrementNoun.verifier` | 1,351 | `76d622c599cbf1cc68fd9f698a41f71d3be45ec2fc18c28c01269c6105306e62` | 1,351 | `76d622c599cbf1cc68fd9f698a41f71d3be45ec2fc18c28c01269c6105306e62` | SAME |
| `keys/mint_shielded.prover` | 5,214,494 | `5e9d656c1c39a68992ee170a39296b82a9ffbc6dae731c59b7433dd7e68a070a` | 5,215,614 | `27f5fee2454c64ed76f8ca77fe4b773fc68e3509542880f8f4caae5bf62bc5a2` | CHANGE |
| `keys/mint_shielded.verifier` | 2,119 | `88669abef686f746a8f1e37224e326898388008ab4cfa54aa0a9e57042596537` | 2,119 | `568987e35fc11d205d8c8c08858a85833e535f13b6b0c77b3a95f5c1f9eb4839` | CHANGE |
| `keys/mint_unshielded.prover` | 2,820,616 | `7d6301b0a6147238a434984983af6476bc0f1362ec68274d440901333735686b` | 2,821,420 | `f556576d54a7bc17b48be78c6daa8e7a6a60eb1df9bcab69f97c7e5fb076e2f1` | CHANGE |
| `keys/mint_unshielded.verifier` | 2,119 | `a1f7a4aea726d5b59a143b0ffb92d1bb65198b9046fdfae00a547ddd910d3be8` | 2,119 | `04f25d78fc43f59e2ccf0cf95df8176b9c6b53be96d588808457e433037582e8` | CHANGE |
| `zkir/incrementNoun.bzkir` | 117 | `33465f34039cfaf9a81229bd202182254f653e42faa9e5ad1915af2ed9fa0e68` | 117 | `33465f34039cfaf9a81229bd202182254f653e42faa9e5ad1915af2ed9fa0e68` | SAME |
| `zkir/mint_shielded.bzkir` | 470 | `2778d50b9221d19eb06834ba6fffa17f3a43a02a0c4c6396de7ae878ad25a0c7` | 670 | `574f94bc0574e726a54dc9ae1dff5372d0f73d872fac05d396f3a6b996f569d1` | CHANGE |
| `zkir/mint_unshielded.bzkir` | 471 | `0edbeaecb343c9e5395a843c9efa1873918e476625f74c0b021ce5ef95250ef5` | 826 | `26ade2bd308a3b728432d01f1877e6f383667794c224bc3ff6419a9d4298d12e` | CHANGE |

**Both mint verifier keys moved; every ledger-v9 OfferFiles instance must
redeploy.** `incrementNoun` is unchanged. ZKIR remains version 2.0 and verifier
keys remain `midnight:verifier-key[v6]`, compatible with the plain digest-pinned
proof server `9.0.0-rc.5`.

The common shielded caller passes `left(ownCoinPublicKey)` explicitly. A contract
recipient is `right(contractAddress)`, but ledger v9 requires its matching
receive circuit in the same transaction segment. Without that receive, the
installed ledger-v9 rc.3 WASM identifies
`a contract-owned coin output was left unclaimed`, and the live node rejects
submission with `1010: Invalid Transaction: Custom error: 218`; the coin is not
stranded. Both mint circuits reject `amount == 0` with
`mint amount must be positive`.

The generated `src/managed/` tree stays gitignored and is produced locally, in
the real CI compile job, and inside the kernel image. Downstream rollout is a
single compatibility-boundary update:

- `midnight-2-offers/images/offerfiles-kernel`: repin this kernel branch/commit
  and regenerate the OfferFiles manifest/key material.
- `midnight-2-offers/images/aa-contracts`: repin the AA source and its
  `runner/package.json` to compact-runtime 0.19.0 so AA and OfferFiles load
  under one runtime. Update `runner/aa-console.ts` so its OfferFiles faucet call
  adds `left(ownCoinPublicKey)`.
- `midnight-2-offers/images/zswap-da/ledger-v9.patch`: update its
  `@midnight-ntwrk/compact-runtime` pin to 0.19.0; patch the v9
  `browserContract.ts` faucet call; regenerate `src/contract/manifest.json` and
  the patched key hashes. The upstream Effectstream template still targets
  ledger v8/kernel `main`, so this stays in the v9 patch until upstream migrates.
- Check `images/offerfiles-kernel/entrypoint-register-tokens.sh` (artifact names
  only) and `compose/offerfiles.yml` (comment only); neither contains a mint
  call today.
- Re-run AA project 00029's T-M1 one-transaction mint-into-Manager measurement
  with the contract recipient plus receive circuit composed in one transaction.
- Kernel `main` and `midnight-1-offers` remain ledger-v8/1.x and are unchanged;
  they keep the old circuit API and require no 1.x redeploy from this branch.

---

## What landed on this branch

### 1. A pinned, containerised compactc 0.33.0-rc.2

`compact compile +0.33.0-rc.2` cannot work: the `compact` version manager does
not publish the 0.33 line (`compact list` tops out at 0.31.1, `compact check`
reports "Up to date -- 0.31.1"). The 0.33 release candidates ship as prebuilt
release assets on `LFDT-Minokawa/compact` instead.

* `infra/compact-version.txt` — the pin, single source of truth.
* `infra/compact-toolchain.Dockerfile` — fetches the pinned release asset;
  asserts at build time that the default `zkir` backend is present.
* `infra/compact.sh` — uses `$COMPACTC` if set, else builds the image once and
  runs it. `bun run --filter @zswap-da/contract-offer-files compact` goes
  through this.

Two non-obvious things this had to solve, worth knowing if you package the
toolchain again (e.g. in a kernel Docker image):

* We run the container as the host uid/gid so `src/managed/` is not root-owned.
  That makes the image's default `HOME=/root` unwritable, and zkir then fails
  with `Permission denied (os error 13)` → `Exception: zkir returned a non-zero
  exit status 1` — printed *after* "Compiling 3 circuits", so it reads like a
  compiler bug. Fix: `-e HOME=/tmp -e XDG_CACHE_HOME=/cache`.
* `compactc` must not be symlinked onto `PATH`; the bundled wrapper resolves
  `compactc.bin` from `dirname $0`. The Dockerfile writes a two-line exec shim.

The SRS/params cache is persisted in `.compact-cache/` (gitignored), so repeat
compiles need no network.

### 2. `offer-files.compact` recompiled — clean, with no source edits

`packages/contracts-midnight/contract-offer-files` now pins
`@midnight-ntwrk/compact-runtime` `0.18.0-rc.1` and `@midnight-ntwrk/compact-js`
`2.5.5-rc.7`. The container self-reports compiler `0.33.0`, language `0.25.0`,
ledger target `ledger-9.1.0.0-rc.3`, runtime `0.18.0-rc.1`.

The language-0.25 tripwire — `Field` is no longer a supertype of `Uint`, so bare
numeric literals need `as Field` — does not bite here: the contract's only
arithmetic is `counter = counter + 1 as Uint<128>`, already annotated. No
cross-contract calls, so none of the new CCC guards apply either.

Two independent builds produce byte-identical output across all 17 files,
prover keys included.

### 3. We do NOT pass `--feature-zkir-v3`, and that decides the proof-server tag

compactc 0.33 defaults to ZKIR version 2; `--feature-zkir-v3` opts into version
3. We stay on the default. Verified on the emitted artifacts:

* `zkir/*.zkir` → `"version": {"major": 2, "minor": 0}`
* `zkir/*.bzkir` → tagged `midnight:ir-source[v2]`
* `keys/*.verifier` → tagged **`midnight:verifier-key[v6]`**

The ledger maps `verifier-key[v6]` to `ProofVersioned::V2` and `verifier-key[v7]`
to `V3` (`ledger/src/prove.rs` at `ledger-9.1.0.0-rc.3`). So these artifacts are
proven by the **plain `midnightntwrk/proof-server:9.0.0-rc.5`** image. The
`9.0.0-rc.5_experimental` build is required only for the zkir-v3 lane, where the
plain tag answers *"Unsupported ZKIR version"*. Nothing here needs it.

Do not add `--feature-zkir-v3` without also switching every deployment to the
`_experimental` proof server.

### 4. Historical 0.31 → 0.33 result: circuits did not change

The `zswap-da` frontend template records a sha256 manifest of this same contract
source built with compactc **0.31.0**. Against this 0.33.0-rc.2 build:

| Group | Result |
| --- | --- |
| `zkir/*.zkir`, `zkir/*.bzkir` (6 files) | identical |
| `keys/*.prover`, `keys/*.verifier` (6 files) | identical |
| `contract/index.{d.ts,js,js.map}`, `compiler/contract-info.json` | changed |
| `compiler/contract-manifest.json` | new in 0.33 (16 files → 17) |

This is historical compiler provenance only. The final recipient-typed mint
source at the active 0.34 boundary changes both mint verifier keys and requires
every ledger-v9 OfferFiles instance to redeploy, as recorded above.

All twelve ZK artifacts are byte-identical, so **verifier keys are unchanged**:
an already-deployed OfferFiles contract stays valid across this toolchain bump,
and the frontend's `FetchZkConfigProvider` serves the same key bytes. Only the
generated TypeScript moved, which is what a runtime 0.15 → 0.18 change should
look like.

(The template's manifest still needs its four changed hashes, the new entry, and
`COMPILER_VERSION` updated — that edit lives in the effectstream monorepo and is
gated on the same blocker.)

---

## The blocker: five `@effectstream/*` packages pin ledger-v8 as hard deps

The kernel cannot finish this migration on its own. These are exact
`dependencies`, not peer ranges, so bumping our own pins does not redirect them:

| Package | How it pins |
| --- | --- |
| `@effectstream/batcher-sdk` 0.103.1 | `"@midnight-ntwrk/ledger-v8": "8.1.0"` + midnight-js 4.1.1 ×8 + `wallet-sdk-facade` 4.1.0 |
| `@effectstream/midnight-contracts` 0.103.1 | same |
| `@effectstream/sync` 0.103.1 | `"@midnight-ntwrk/ledger-v8": "8.1.0"` (transitive-only, under `@effectstream/runtime`) |
| `@effectstream/config` 0.103.1 | `onchain-runtime` → `npm:onchain-runtime-v3@3.0.0` |
| `@effectstream/mip-zswap-offer` 0.3.0 | peer range is `"*"`, but `dist/mip5/OfferFiles.js:10` **value**-imports `@midnight-ntwrk/ledger-v8` — the specifier is baked in |

`effectstream/effectstream@v-next` HEAD has not started this work
(`midnight-contracts` 0.104.1 still reads ledger-v8 8.1.0 / midnight-js 4.1.1 /
facade 4.1.0), so there is no newer package to bump to.

**Why there is no partial migration.** `packages/validator` looked like a
migratable slice — its only non-stdlib deps are the ledger, `@scure/base`,
noble and `mip-zswap-offer`, and it has its own `bun test` suite. But because
`mip-zswap-offer` hard-codes the v8 specifier, migrating the validator alone
loads **two ledger wasm modules in one process**. That is the failure this
repo's own root `overrides` comment documents: two copies in one bundle make
every cross-copy value fail an `instanceof` check. So the specifier rename has
to land together with the `@effectstream/*` upgrade, in one step — which is why
this branch does not contain it.

---

## Prepared work: the v8 → v9 API delta over the surface this repo uses

Diffed `@midnight-ntwrk/ledger-v8@8.1.0` against
`@midnightntwrk/ledger-v9@1.0.0-rc.3` typings.

**Byte-for-byte identical — a pure specifier rename suffices:** `Transaction`
(entire class: `deserialize`, `wellFormed`, `serialize`, `identifiers`, `merge`,
`guaranteedOffer`/`fallibleOffer`/`intents`), `UnprovenTransaction` (still just
`Transaction<SignatureEnabled, PreProof, PreBinding>` — not renamed, not
re-generified), `FinalizedTransaction`, `Intent`, `WellFormedStrictness` (all
five boolean fields), `ZswapSecretKeys`, `DustSecretKey`, `shieldedToken`,
`LedgerState` constructor / `apply` / `postBlockUpdate` / `updateIndex`,
`ZswapChainState` constructor / `deserialize` / `tryApply`.

**Only two breaking changes, both easy to miss:**

1. `SignatureVerifyingKey`, `SigningKey` and `Signature` change from `string` to
   `{ tag: SignatureKind, value: string }`, with new
   `type SignatureKind = 'schnorr' | 'ecdsa'`. The declarations of
   `verifySignature(vk, data, sig)` and `addressFromKey(key)` are *textually
   unchanged*, so a rename-only migration compiles at those call sites and then
   misbehaves at runtime. Affected here: `packages/validator/derive.ts`
   (`addressFromKey`), plus anywhere a signing key is threaded as a string.
2. `ZswapChainState.postBlockUpdate(tblock)` gains a required second argument,
   `retentionDuration: bigint`. (`LedgerState.postBlockUpdate` is unchanged —
   don't confuse the two.)

New in v9 and harmless: `LedgerState.testingFromGenesis`,
`testingUnlockToTreasury`, `testingUnlockToReserve`.

## Prepared work: the compact-runtime 0.18 delta

Nothing in this workspace uses the broken APIs directly — a grep for
`currentPrivateState|currentQueryContext|currentZswapLocalState|createCircuitContext|.proofData|CircuitContext|convertBytesToField`
over the whole repo (excluding `node_modules` and generated `src/managed/`)
returns zero hits. All `CircuitContext` handling lives in
`@effectstream/midnight-contracts` and `@midnight-ntwrk/midnight-js-contracts`,
and our circuit calls go through midnight-js `callTx`, already awaited.

For whoever does that upstream work, the delta as it appears in generated code
(same source, compactc 0.30/runtime 0.15 vs 0.33/runtime 0.18):

| | runtime 0.15 | runtime 0.18 |
| --- | --- | --- |
| context fields | `currentPrivateState`, `currentQueryContext`, `currentZswapLocalState`, `gasCost` | **`callContext` only** — all four collapsed under it |
| helpers added | — | `copyCircuitContext`, `finalizeCallProofData` |
| helpers replaced | `convertBytesToField` | `convertBytesToUint` |
| circuit return | `CircuitResults<PS, T>` | **`Promise<CircuitResults<PS, T>>`** — `ImpureCircuits`, `ProvableCircuits` and `Contract.initialState` are all async now |
| new export | — | `expectedVk: Record<string, string>` (implementation-binding guard) |

The async flip has the widest blast radius: `initialState` returning a promise
touches every deploy path.

---

## Unified branch: `ledger-v9` (2026-09-03)

`00001-ledger-v9` (this migration, PR #49) and `00001-solver-v9` (the COW
solver port stacked on it, PR #50) are folded into one branch, `ledger-v9`,
with `main` merged in. Everything `main` gained after the branches forked at
`feat/cow-solver` @ `381022d` — the token price service (#54–#56), the offer
poster and its deployment (#57, #60), the solver status listener and console
(#58, #59), sNight seeding (#61) — was written against the ledger-v8 line and
is ported here rather than merged as-is:

* **Root manifest.** The wallet-sdk set `main` added for the offer poster
  (`abstractions` 2.1.0, `capabilities` 3.3.1, `dust-wallet` 4.2.0, `facade`
  4.1.0, `hd` 3.0.3, `shielded` 3.0.2, `unshielded-wallet` 3.1.0) moves to the
  v2 line `@effectstream/midnight-contracts@0.200.2` itself resolves
  (`3.0.0-beta.0` / `4.0.0-beta.2` / `5.0.0-beta.2` / `5.0.0-beta.2` /
  `3.1.0-beta.1` / `4.0.0-beta.2` / `4.0.0-beta.2`). `packages/price-feed`'s
  `@effectstream/{db,utils}@0.103.1` — the last thing still dragging
  `ledger-v8@8.1.0` into the store — moves to `0.200.2`. The lockfile again
  carries exactly one ledger: `@midnightntwrk/ledger-v9@1.0.0-rc.3`.
* **`deploy/scripts/lib/pinned-wallet.ts`** — the offer poster's copy of
  `buildWalletFacade` is re-diffed against `midnight-contracts@0.200.2`:
  tagged `createKeystore({kind: "schnorr", secret})`, facade sub-wallet
  factories that receive their configuration, `DustAddress.encodePublicKey`
  from the DUST public key instead of `getInitialDustState` + `MidnightBech32m`,
  `TransactionHistoryEntryCommonSchema`, `setNetworkId`, HD key material
  cleared after derivation. The pinned coin selector — the reason the file
  exists — is untouched.
* **`waitForDustFunds`** now resolves a readiness record, not a bigint; the
  poster reads `.balance`.
* Import-site rename `@midnight-ntwrk/ledger-v8` → `@midnightntwrk/ledger-v9`
  in the seven files `main` added (faucet mint, fee sizing, asset-price and
  batcher tests, the deploy e2e driver); the two sync `signData` callbacks in
  `deploy/scripts` moved to `signDataAsync`. The fee-sizing model measured on
  ledger-v8 8.1.0 passes its structure tests unchanged on v9.
* **`deploy/` Compose stack** moves to the 2.x chain: midnight-node
  `2.0.0-rc.4` and indexer-standalone `v4.4.0-rc.3` from binaries 0.3.120
  (sha256-pinned, both linux arches), the official multi-arch
  `midnightntwrk/proof-server:9.0.0-rc.5` image pinned by digest (release
  0.3.120 has no linux-arm64 rc.5 binary), the kernel image compiling with the
  same LFDT `compactc` 0.33.0-rc.2 asset `infra/compact-toolchain.Dockerfile`
  fetches (handed to `infra/compact.sh` as `$COMPACTC`), indexer config from
  `npm-midnight-indexer@0.200.2`, `/api/v4` as the default indexer path on both
  the kernel and relay sides.
* **`start.dev.ts`** `compact-check` no longer demands a `compact`-manager
  install of 0.30.0; it reads `infra/compact-version.txt` and verifies the
  route `infra/compact.sh` will take (`$COMPACTC`, else Docker).

Not re-verified here: the Midnight Intents reference relay (`deploy/relay`,
built from the reference checkout at `061f4d3`) was never run against a 2.x
chain from this stack; the ledger-v9 demo stack (`acedward/midnight-2-offers`)
runs the solver in OBSERVATION mode without it.
