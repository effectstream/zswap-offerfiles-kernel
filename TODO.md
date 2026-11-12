# TODO

Open work for this repository, written 2026-11-10. Four sections:

1. [Publish the backend packages to npm](#publish-the-backend-packages-to-npm)
2. [COW solver follow-ups (`effectstream/cow-solver`)](#cow-solver-follow-ups-effectstreamcow-solver)
3. [Kernel follow-ups](#kernel-follow-ups)
4. [Upstream (effectstream)](#upstream-effectstream)

The items added on 2026-11-10, after the kernel's first production host ran
it on preprod, carry what that host showed, so that each one can be acted on
without the host's notes.

## Publish the backend packages to npm

Status: not started.

Today every workspace package here is private (`"private": true`, version
`0.1.0`), and its `exports` point at TypeScript source that Bun runs directly.
Code outside this repository can reach these packages only through a git
checkout of the repository. The COW solver, which lives in
`effectstream/cow-solver`, does this with a git submodule. This section lists
what it takes to publish the backend packages that outside code imports, so
that consumers can depend on versions instead.

### What to publish

| Package | Path | What it is | Imported by |
|---|---|---|---|
| `@zswap-da/validator` | `packages/validator` | Offer decoding and validation: `validateZswapOffer`, reference state, liveness, pinned ledger parameters (`./reference-parameters`) | node, batcher, offer-guard, the COW solver |
| `@zswap-da/offer-guard` | `packages/offer-guard` | Offer hash, guard ladder, dedup store, fee sponsorship; `./public-networks` (supported networks, endpoint and dev-seed rules, log redaction) | node, batcher, the deploy scripts, the COW solver |
| `@zswap-da/api-contracts` | `packages/api-contracts` | The versioned wire contracts of the kernel API: `./amount`, `./receipt-client`, `./exact-files-contract`, `./offer-updates-contract`, `./validation-contract` | node, the docs playground, the COW solver and its monitor site |
| `@zswap-da/kernel-client` | `packages/kernel-client` (available) | The client side of the kernel: the wallet helpers (`./wallet`), the kernel REST / SSE / websocket client (`./api-client`) and the offer merging and token-balance checks (`./batcher`) | the offer poster, maker-offer, `read-wallet`, the `packages/tests` e2e helpers, the node's update-stream test, the COW solver |

Dependency order: `validator` first, then `offer-guard`, which depends on it.
`api-contracts` has no dependencies. `kernel-client` depends on
`api-contracts`, so it is published after it.

Not meant to be published:

- The COW solver's tests reach into kernel internals through the submodule:
  its book-mirror test and its release-hardening e2e harness import
  `packages/database/pglite.test-support.ts`, `packages/database/mod.ts`,
  `packages/node/offer-consumption-read.ts`, `packages/node/api.ts`,
  `packages/node/event-bus.ts` and `packages/node/sync-health.ts`. These are
  not meant to be published as they are. Those tests have to move onto
  published APIs, or keep their own copies, before the submodule can go
  (step 6).

### 1. Naming and scope

- No `@zswap-da/*` package exists on npm (checked 2026-11-10), and the scope's
  owner is unverified. There are two choices:
  - create the `zswap-da` npm organization and keep the names;
  - publish under `@effectstream`, which already carries
    `@effectstream/mip-zswap-offer`, with names such as
    `@effectstream/offer-files-validator`.
- Decide before the first publish: renaming a published package breaks every
  consumer. Rename the workspace package to match the published name, so that
  the in-repo name and the npm name are the same.

### 2. Manifests

- Remove `"private": true` from the published packages only.
- Add `description`, `license` (the repository has no `LICENSE` file yet; add
  one first), `repository` with `directory`, `files` (built output, README,
  LICENSE), `sideEffects: false` and `engines`.
- Ranges between our own packages: `offer-guard` depends on
  `"@zswap-da/validator": "workspace:*"`. `bun publish` rewrites `workspace:*`
  to the exact version; `npm publish` does not, so use `bun publish` or rewrite
  the range in the release job.
- Make the Midnight ledger a peer dependency (`@midnightntwrk/ledger-v9`
  `^1.0.0`), and `@effectstream/mip-zswap-offer` too (`^0.4.0`). The ledger is a
  WASM module that has to exist exactly once in a consumer's tree; the kernel's
  own lockfile guard (`scripts/check-midnight-stack.test.ts`) enforces one copy.
  `validator` keeps `@noble/*` and `@scure/base` as ordinary dependencies.
- `offer-guard` has no `tsconfig.json` and no strict typecheck gate. Add both
  before publishing it, as `packages/api-contracts` has.

### 3. Build output

- Node and bundlers cannot load `.ts` exports. Emit ESM JavaScript and type
  declarations into `dist/`, with an exports map of `types` and `import` per
  subpath, as `@effectstream/mip-zswap-offer` does.
- The sources import siblings with a `.ts` extension
  (`./validation-contract.ts`). Compile with `tsc` using
  `rewriteRelativeImportExtensions: true` (TypeScript 5.7 or later) and
  `declaration: true`. The other way is `bun build` per entry plus
  `tsc --emitDeclarationOnly`.
- Keep the workspace on the source: in-repo consumers should keep resolving
  the `.ts` exports. The release job builds `dist/` and writes the
  `dist`-based `exports` into the manifest of the copy it packs, never into the
  committed `package.json`.
- Leave tests, test kits and `packages/validator/scripts/` out of the tarball.
  The `api-contracts` fixtures under `fixtures/offer-validation/v1/` are
  conformance vectors for the validation contract; decide whether to ship them
  for consumers' tests.
- Check every tarball before publishing: `npm pack --dry-run`, then install the
  packed file into an empty Node project and an empty Bun project and import
  every subpath.

### 4. Version policy

- Semver, starting at `0.1.0`, versioned per package (they change at different
  rates), with a changelog per package.
- `api-contracts`: each contract carries its own schema version
  (`OFFER_VALIDATION_SCHEMA_VERSION`, `EXACT_FILES_SCHEMA_VERSION`, the
  `offer-updates-v1` protocol). Changing a schema is a breaking release of the
  package: major from 1.0, minor while it is 0.x. The node release that serves
  the new schema ships together with it.
- `validator`: accepting or refusing a different set of offers is a breaking
  change.
- A new Midnight ledger major (ledger-v9 to a later one) is a breaking release of
  `validator` and `offer-guard`.

### 5. Release workflow

- A workflow `.github/workflows/release-packages.yml`, run by a tag
  `<package>@<version>` (for example `api-contracts@0.2.0`) or by a manual
  dispatch that names the package.
- Steps:
  1. Check out the tag. Pin Bun to the version CI uses.
  2. `bun install --frozen-lockfile`.
  3. Run the package's unit tests and its typecheck gate.
  4. Build `dist/` and fail if the manifest's version differs from the tag.
  5. Pack and smoke-test as in step 3.
  6. Publish with provenance: `npm publish --provenance --access public`, or
     `bun publish` plus an attestation step. Use npm trusted publishing (OIDC,
     `permissions: id-token: write`), not a long-lived token.
  7. Create a GitHub release with the changelog section.
- Publish `validator` before `offer-guard`.

### 6. Switch `effectstream/cow-solver` from the submodule to versions

1. Publish the packages the solver imports: every package in the table above,
   `kernel-client` included.
2. In `effectstream/cow-solver`, replace the submodule-backed dependency entries
   with exact versions (for example `"@zswap-da/api-contracts": "0.1.0"`), and
   regenerate the lockfile.
3. Move its tests off the kernel internals listed under "What to publish".
4. Remove the submodule (`git submodule deinit`, `git rm`, `.gitmodules`) and
   the submodule checkout step from its CI.
5. Run its unit tests, typecheck and e2e suite against a kernel image of the
   matching release, and record in its README which kernel release serves which
   contract versions.

### Checklist before the first publish

- [ ] Scope and names decided (step 1).
- [ ] `LICENSE` added; manifests completed (step 2).
- [ ] `offer-guard` has a tsconfig and a strict typecheck gate.
- [ ] Build, pack and smoke test pass for each package (step 3).
- [ ] Release workflow merged; trusted publisher configured on npm (step 5).
- [ ] First publish; then `effectstream/cow-solver` switches (step 6).

## COW solver follow-ups (`effectstream/cow-solver`)

The COW solver moved to `effectstream/cow-solver` with its history, and this
repository no longer contains it. Everything below happens there.

- [ ] Port the Midnight Intents relay to ledger 9. The reference relay is
  `shieldedtech/midnight-intents-swaps`, subtree `phase1-native-swaps`, which
  pins `@midnight-ntwrk/ledger-v8` 8.1.0 and `wallet-sdk` 1.1.0, so it cannot
  run against a ledger-9 chain. Three ways:
  - revive the earlier ledger-9 port, made in 2026-08 on the release-candidate
    stack in a private copy (`acedward/midnight-intents-swaps`). Its commits
    were never pushed (the remote branch still points at the base commit
    `061f4d3`); the only copy is an archive on an external drive;
  - a pull request upstream, in `shieldedtech/midnight-intents-swaps`;
  - a minimal relay of our own, built from the frozen seven-message solver
    contract (`relay-ws-contract.ts` and its byte-pinned fixtures in
    `fixtures/relay-ws/v1/`).
- [ ] Run the Compose e2e through the relay on the ledger-9 stack: taker intent
  → relay → solver → settlement.
- [ ] Run the moved grand-e2e solver runners against the pinned backend
  (`solver-offerfiles-e2e.ts`, `solver-release-hardening-e2e.ts`,
  `relay-fixture-e2e.ts`). They need a running kernel stack, and the
  relay-driven ones need the ledger-9 relay. `effectstream/cow-solver` PR #1
  found two more blockers:
  - they still assume this repository's single-repository layout: for
    example `REAL_E1_REQUIRED_SOURCE_PATHS` in `solver-offerfiles-e2e.ts`
    names `packages/node/offer-validation.ts`, which sits under `kernel/`
    there;
  - `lib/solver-offerfiles-real-runtime-smoke.ts` imports a hard-coded Bun
    store path of `@effectstream/runtime` 0.103.1, which neither repository
    installs (both pin `@effectstream/*` 0.300.x).
- [ ] Re-audit the solver for real funds and get a new owner decision. Real
  funds are NO-GO: the last conditional approval covered only the audited
  commit `381022d`, and the solver has changed since, including its ledger-9
  port. The mainnet dry-run default and `SOLVER_MAINNET_LIVE_TRADING_ACK` stay.
- [ ] Switch from the kernel submodule to the published npm packages (see
  "Publish the backend packages to npm", step 6).
- [ ] Follow the PGlite test helper's new name when the kernel submodule is
  bumped. Test-only files here carry `.test` in their name, so
  `packages/database/test-pglite.ts` is now
  `packages/database/pglite.test-support.ts`. Two solver files import it
  through the submodule: `packages/solver/offer-updates-mirror.test.ts` and
  `packages/tests/grand-e2e/solver-release-hardening-e2e.ts`. Each import is a
  one-line path change; without it the solver's unit suite fails to load after
  the bump.
- [ ] Merge `effectstream/cow-solver` PR #1
  (https://github.com/effectstream/cow-solver/pull/1). It wires this
  repository in as a git submodule and makes the solver build and test on its
  own:
  - it deletes the copies of `wallet.ts`, `api-client.ts` and `batcher.ts`
    (with `batcher.test-support.ts` and their tests) that the history filter
    carried into its `solver-core`, and imports `@zswap-da/kernel-client`
    through the submodule instead, so that no copy is kept;
  - it carries the two solver-only files the history filter did not include
    (they lived outside the solver paths and were removed here with the
    solver; the last copy of each is at `ee82ff4`):
    `packages/node/offer-updates-mirror.test.ts`, now
    `packages/solver/offer-updates-mirror.test.ts` (the solver's book mirror
    against the node's real API), and `docs/protocol-scope.md` (the superseded
    scoping draft of the solver, history only);
  - it ports the 13 solver and relay launch gates that this repository's
    `deploy/gates.sh` dropped with the solver.
- [ ] Deploy the solver. It is not deployed anywhere today.
- [ ] Keep the solver's wallet state across restarts, together with the kernel
  item "Keep wallet state across restarts" below. On the production host every
  solver restart resynced its wallet from genesis, about 55 minutes on preprod,
  and the solver quoted nothing meanwhile.
- [ ] Do not withdraw the ladder on a single health flip. The solver reads
  `GET /v1/health/sync`, whose `status` is the latest sample's own verdict, and
  withdrew its whole ladder each time one slow light-node read made it
  `syncing`. Either read the damped verdict the kernel now publishes on
  `GET /v1/health` (`status` changes only after `SYNC_HEALTH_HYSTERESIS_SAMPLES`
  consecutive tip reads disagree; `raw_status`, `reasons` and `hysteresis` say
  why), or damp on the solver side with the same rule.
- [ ] Add a migration note for the removed `SOLVER_LADDER_CONFIG` to the
  solver's README or changelog. A deployment whose environment still set it
  crash-looped about 80 times before anyone noticed; the note says what replaces
  it and that the variable must be deleted.
- [ ] Say in the solver's README that its monitor has no authentication of its
  own and must be deployed behind one (the production host put nginx basic
  auth in front of it).

## Kernel follow-ups

- [ ] Repository owner: review the real-funds NO-GO when the first ledger-9
  version of this backend is ready for review (README, "Real funds: NO-GO").
- [ ] Pin mainnet's ledger-9 reference parameters (the `TODO(mainnet)` in
  `packages/validator/reference-parameters.ts`). Until then a mainnet kernel
  refuses to start.
- [ ] Remove the duplicate DUST provisioning script. This repository keeps a
  copy of `effectstream/cow-solver`'s `deploy/scripts/provision-solver-fees.ts`
  and `deploy/scripts/lib/solver-provision.ts` (with its test) only so that the
  README's funding runbook can register the batcher's NIGHT for DUST. Replace
  it with a backend-named script (a batcher-named seed input instead of
  `SOLVER_SEED`) or with one package both repositories share, and delete the
  duplicate.
- [ ] Drop the PGlite forwarder (`deploy/images/kernel/pglite-forwarder.ts` and
  its supervision in `entrypoint-pglite.sh`) once `@effectstream/db`'s
  `start-pglite` can bind a non-loopback address (a host option in
  `@effectstream/db`, an upstream change).
- [ ] Add a test-only token minter for ledger 9, once the ledger-9 line is
  stable. Required: the `unshielded-only` e2e case needs a second unshielded
  token, nothing on the local `undeployed` chain issues one, so the case cannot
  run today. Until 2026-09-08 the kernel had such a minter, built on the mint
  circuits of the `offer-files` contract; it was removed when the kernel became
  contract-free.
- [ ] Make the Midnight sync's step and poll settable: `MIDNIGHT_STEP_SIZE` and
  `MIDNIGHT_POLLING_INTERVAL_MS`, validated by the public-network profile and
  `check-env.ts` (exit 78 naming the variable), with conservative defaults for
  hosted indexers. Today `packages/node/config.preview.ts`, which the public
  node runs, hard-codes `stepSize: 500` and `pollingInterval: 1000` for the
  parallel Midnight protocol. Upstream `MidnightFetcher.readData` sends one
  GraphQL request per block, all heights of a step in parallel, so one catch-up
  step is 500 concurrent requests to Blockfrost: rate limits and the plan's
  request quota. The production host had to patch it down to a step of 10 and
  a poll of 6000 ms. Size the defaults from Blockfrost's limits, and document
  them in `deploy/PRODUCTION.md`. The upstream fix is in "Upstream
  (effectstream)" below.
- [ ] Keep wallet state across restarts. Every kernel wallet tool (the offer
  poster, maker-offer, `read-wallet`, the DUST provisioning script, and the
  COW solver through `@zswap-da/kernel-client`) builds its facade from the seed
  and resyncs from genesis: 10 to 55 minutes per start on preprod. The wallet
  SDK can save and restore wallet state (each wallet's `serializeState()`, and
  `ShieldedWallet(…).restore`, `UnshieldedWallet(…).restore`,
  `DustWallet(…).restore`; the batcher already restores its DUST state from
  `BATCHER_STORAGE_DIR/dust-state`). Save the shielded, unshielded and DUST
  state on a persistent volume after each sync, restore it at start, and fall
  back to a full sync when the saved state is from another network or ledger
  version. Share the code with the solver (kernel-client). Until then
  `MIDNIGHT_WALLET_SYNC_TIMEOUT_MS` lets the first sync finish.
- [ ] Let the operator supply the token list. Preview and preprod import no
  token names today: the published registry files are still in the 1.x format,
  and the import (`packages/database/import-token-registry.ts`) accepts only
  2.x documents, so the web app shows hex colours. The registry write route
  has no authentication and stays off (`ENABLE_TOKEN_REGISTRY`). Options: read a
  local file, or a URL from env, in the 2.x registry format through the
  existing import; or put authentication on the write route.
- [ ] A "start from now" bootstrap for a fresh database. Today the operator
  reads the Midnight tip (height and block time) and the light node's head and
  sets `MIDNIGHT_START_BLOCK`, `NTP_START_TIME` and `CELESTIA_START_HEIGHT` by
  hand (`deploy/PRODUCTION.md`, "First start"). A one-shot command that reads
  both tips, refuses a non-empty database, and prints or writes those three
  values removes that step. It must not change `BLOCK_TIME_MS`, which a
  database keeps for its whole life.
- [ ] Bound the batcher's NIGHT-bootstrap proof. `packages/batcher/night-utxo-bootstrap.ts`
  proves its self-split with `finalizeRecipe` on the batcher-sdk wallet and no
  deadline, so a proof server that never answers holds the batcher's start.
  Apply `MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS` there with
  `@zswap-da/kernel-client/wallet-timeouts` (the batcher does not depend on
  kernel-client yet), or get the hook upstream.
- [ ] Forward the new optional variables in `deploy/compose.yml`
  (`SYNC_HEALTH_*` to the kernel; `MIDNIGHT_WALLET_SYNC_TIMEOUT_MS` and
  `MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS` to the poster and the one-shot scripts).
  Compose lists each service's environment explicitly, so today those
  services run with the defaults whatever `.env` says. The native deployment
  (`deploy/PRODUCTION.md`) reads them from its env files.

## Upstream (effectstream)

Changes that belong in `effectstream/effectstream` (the runtime, the sync
protocols and the batcher this kernel runs on) or in the Midnight wallet SDK.
The paths are effectstream's, as of 0.300.3. The kernel carries a stop-gap for
each where it can; it is named in the item.

- [ ] Celestia: classify "below Tail" as fatal.
  `packages/node-sdk/sync/src/sync-protocols/celestia/CelestiaClient.ts`
  `rpc()` retries every error except `blob: not found`, with a backoff capped
  at 30 s. A light node that pruned the heights the node still needs answers
  `requested header … is below Tail` for ever: the production host logged more
  than 61,000 attempts while `/v1/health` said `syncing`. Treat below-Tail /
  pruned answers as fatal (exit non-zero with the reason, or report an error
  state with the reason) instead of retrying. Kernel stop-gap: the recovery
  runbook and the external light-node watchdog in `deploy/PRODUCTION.md`.
- [ ] Midnight fetcher: bound the requests.
  `packages/node-sdk/sync/src/sync-protocols/midnight/fetcher.ts` `readData`
  sends one GraphQL request per height, all heights of a step in parallel
  (`all(heights.map(...))`), and does not back off on 403, 429 or 503. Bound the
  concurrency, prefer range queries where the indexer has them, and back off on
  those statuses. Kernel stop-gap: the kernel follow-up "Make the Midnight
  sync's step and poll settable".
- [ ] Batcher: never report a landed transaction as failed.
  `packages/batcher/adapters/midnight-balancing-adapter.ts`
  (`waitForSingleReceipt`) polls the indexer every second, calls
  `response.json()` without checking the HTTP status (hence "Failed to parse
  JSON" on an HTML 403 or 503 page), never backs off, and throws on its timeout
  (at least 300 s per hash). `packages/batcher/core/storage.ts`
  (`incrementRetryCount`) then drops the input after 3 retries. On the
  production host a trade that landed on chain was reported as failed this
  way. Check the status and back off; before re-submitting or dropping an
  input, look its transaction hash up on chain; expose each input's final
  state.
- [ ] Batcher: an asynchronous `/send-input`. `packages/batcher/core/batcher.ts`
  returns `null` for `confirmationLevel: "no-wait"` (no input id), and the
  routes in `packages/batcher/server/batcher-server.ts` are `/health`,
  `/status`, `/queue-stats`, `/send-input` and `/force-batch`: nothing reports
  one input's state. So a client that needs the outcome holds `/send-input`
  open with `wait-receipt` for minutes. Add a mode that returns an input id at
  once, and a status route for that id. Kernel stop-gap: the reverse-proxy
  timeouts in `deploy/PRODUCTION.md`.
- [ ] Proof requests need deadlines. The wallet SDK's HTTP prover client
  (`@midnightntwrk/wallet-sdk-prover-client`, `HttpProverClient`) has no
  timeout and takes no `AbortSignal`, so a proof server that accepts a request
  and never answers (an out-of-memory kill of a worker looks like that) holds
  the caller for ever. Upstream changes, by owner:
  - Midnight wallet SDK: a timeout or an `AbortSignal` on proof requests;
  - effectstream `buildWalletFacade` (`@effectstream/midnight-contracts`): accept
    a `provingService` factory or a proof deadline, as `WalletFacade.init` does;
  - effectstream `registerNightForDust`, and the batcher's
    `MidnightBalancingAdapter` (`@effectstream/batcher-sdk`): a deadline on the
    proofs they request.

  Kernel stop-gap: `MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS` bounds the proofs the
  kernel's own code requests (the offer poster's facade, maker-offer,
  kernel-client `transferShielded`). The proof-server binary itself needs
  nothing: the 9.0.0-rc.6 asset needed a dynamic-loader wrapper on Debian, and
  9.0.1 from `effectstream/binaries` 0.3.120 runs on stock Debian 13 (the
  kernel's proof-server image checks it with `ldd` and `--help` at build).
