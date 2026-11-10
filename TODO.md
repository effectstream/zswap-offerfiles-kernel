# TODO

Open work for this repository, written 2026-11-10. Three sections:

1. [Publish the backend packages to npm](#publish-the-backend-packages-to-npm)
2. [COW solver follow-ups (`effectstream/cow-solver`)](#cow-solver-follow-ups-effectstreamcow-solver)
3. [Kernel follow-ups](#kernel-follow-ups)

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

- The COW solver's e2e suite reaches into kernel internals
  (`packages/database/test-pglite.ts`, `packages/database/mod.ts`,
  `packages/node/offer-consumption-read.ts`, `packages/tests/lib/*`). These are
  not meant to be published as they are. The suite has to move onto published
  APIs, or keep its own copies, before the submodule can go (step 6).

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
3. Move its e2e suite off the kernel internals listed under "What to publish".
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
- [ ] Run the moved grand-e2e solver runners against the pinned backend.
- [ ] Re-audit the solver for real funds and get a new owner decision. Real
  funds are NO-GO: the last conditional approval covered only the audited
  commit `381022d`, and the solver has changed since, including its ledger-9
  port. The mainnet dry-run default and `SOLVER_MAINNET_LIVE_TRADING_ACK` stay.
- [ ] Switch from the kernel submodule to the published npm packages (see
  "Publish the backend packages to npm", step 6).
- [ ] `effectstream/cow-solver` PR #1 (the submodule wiring): delete the copies
  of `wallet.ts`, `api-client.ts` and `batcher.ts` (with
  `batcher.test-support.ts` and their tests) that the history filter carried
  into its `solver-core`, and import them from `@zswap-da/kernel-client`
  through the submodule, so that no copy is kept.
- [ ] Carry the two solver-only files the history filter did not include. They
  lived outside the solver paths and were removed here with the solver; the
  last copy of each is at `ee82ff4`: `packages/node/offer-updates-mirror.test.ts`
  (the solver's book mirror against the node's real API; it needs the kernel
  through the submodule) and `docs/protocol-scope.md` (the superseded scoping
  draft of the solver, history only).
- [ ] Deploy the solver. It is not deployed anywhere today.

## Kernel follow-ups

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
