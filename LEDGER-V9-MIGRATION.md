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
| compactc | 0.30.0 | 0.33.0-rc.2 (language 0.25, runtime 0.18.0-rc.1, compact-js 2.5.5-rc.7) |

**Status: the toolchain and contract half is done. The SDK half is blocked
upstream — see "The blocker" below.**

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

### 4. The compiled circuits did not change — no redeploy is forced

The `zswap-da` frontend template records a sha256 manifest of this same contract
source built with compactc **0.31.0**. Against this 0.33.0-rc.2 build:

| Group | Result |
| --- | --- |
| `zkir/*.zkir`, `zkir/*.bzkir` (6 files) | identical |
| `keys/*.prover`, `keys/*.verifier` (6 files) | identical |
| `contract/index.{d.ts,js,js.map}`, `compiler/contract-info.json` | changed |
| `compiler/contract-manifest.json` | new in 0.33 (16 files → 17) |

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
