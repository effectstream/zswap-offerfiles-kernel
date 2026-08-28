# COW Solver container handoff

This directory and `Dockerfile.solver` are the complete infrastructure handoff.
The image runs only the solver. Midnight node, indexer, proof server, Offer
Files backend, and relay stay external. The solver is outbound-only, so no
application port is exposed or published.

The locked client line is Midnight Node 1.x / ledger-v8
(`@midnight-ntwrk/ledger-v8@8.1.0`, Midnight.js network ID `4.1.1`). The smoke
test proves this exact closure loads; it does not certify every Node 1.x release
or claim Node 2.x compatibility.

## Build

Build from a clean committed checkout. Choose the platform used by your
infrastructure; the Dockerfile contains no AMD64- or ARM64-specific application
branch.

```sh
test -z "$(git status --porcelain)"
SOURCE_REVISION="$(git rev-parse HEAD)"
SOURCE_ALIAS="$(git rev-parse --short=12 HEAD)"
SOLVER_VERSION="0.1.0"
PLATFORM="linux/amd64" # or linux/arm64

# Refuse to overwrite an existing append-only SHA alias.
! docker image inspect "cow-solver:sha-${SOURCE_ALIAS}" >/dev/null 2>&1

docker build \
  --platform "${PLATFORM}" \
  --file Dockerfile.solver \
  --build-arg "SOURCE_REVISION=${SOURCE_REVISION}" \
  --build-arg "SOLVER_VERSION=${SOLVER_VERSION}" \
  --tag "cow-solver:sha-${SOURCE_ALIAS}" \
  .

IMAGE_ID="$(docker image inspect "cow-solver:sha-${SOURCE_ALIAS}" --format '{{.Id}}')"
docker image inspect "${IMAGE_ID}" --format '{{json .Config.Labels}}'
printf 'Record this accepted local image ID: %s\n' "${IMAGE_ID}"
```

The Bun builder/runtime bases are versioned and pinned to immutable
multi-platform index digests. Infrastructure still must build and smoke its
selected target. No dependency install occurs at container startup.

An unused application-version alias may be added once:

```sh
! docker image inspect "cow-solver:${SOLVER_VERSION}" >/dev/null 2>&1
docker image tag "${IMAGE_ID}" "cow-solver:${SOLVER_VERSION}"
```

Tags are append-only lookup aliases, not immutable identities. Never move,
overwrite, or reuse either a SHA or version alias. If source changes without a
version bump, add only the new SHA alias and leave the existing version mapping
alone until an intentional version bump.

## Configure and dry-run

Copy `deploy/solver/solver.env.example` to an infrastructure-owned secret/config
location and replace every active placeholder. Do not commit the populated
file. `ZSWAP_API` must not contain credentials because the current solver logs
that URL. Mount the ladder as a read-only file.

`SOLVER_DRY_RUN=true` is not offline: it constructs and synchronizes the real
wallet and needs a dedicated seed plus reachable Offer Files backend, Midnight
indexer, node, and proof-server endpoints. Only the disabled packaging smoke
(`SOLVER_ENABLED=false`) is offline.

```sh
docker run --detach \
  --name cow-solver \
  --read-only \
  --env-file /infrastructure/secrets/cow-solver.env \
  --mount type=bind,src=/infrastructure/cow-solver/ladders.json,dst=/etc/cow-solver/ladders.json,readonly \
  "${IMAGE_ID}"
```

Set `MIDNIGHT_NETWORK_ID=preview` or `mainnet`; the container rejects every
other value before loading a solver wrapper. Mainnet dry-run still uses
`SOLVER_DRY_RUN=true` and does not require the live-trading acknowledgement.
The image runs as numeric `10001:10001`, supports a read-only root filesystem,
and needs no writable `/tmp` or Bun cache mount.

Stop it with a normal container signal so the solver owns shutdown directly:

```sh
docker stop --time 30 cow-solver
docker rm cow-solver
```

## Admission policy

`SOLVER_SUPPORTED_PAIRS`, `SOLVER_MIN_JOB_OUTPUT`, and the three-value DUST
group (`SOLVER_DUST_MAX_PER_JOB`, `SOLVER_DUST_MAX_PER_WINDOW`,
`SOLVER_DUST_WINDOW_MS`) are optional under current source behavior. An unset
group remains open and emits periodic warnings; the DUST values must be all set
or all unset. `SOLVER_ADMISSION_WARNING_INTERVAL_MS` changes only that warning
interval. This handoff does not change these semantics.

## Live mode and journal

Live mode is not exercised by this handoff. Before enabling it, provide all
relay inputs in the example and set `SOLVER_DRY_RUN=false`. Mainnet live mode
also requires `SOLVER_MAINNET_LIVE_TRADING_ACK=true`.

The live journal schema is `2`. Persist the whole dedicated directory—not only
the SQLite file—so the DB, WAL, and SHM siblings survive together:

```sh
install -d -m 0700 -o 10001 -g 10001 /infrastructure/state/cow-solver

docker run --detach \
  --name cow-solver \
  --read-only \
  --env-file /infrastructure/secrets/cow-solver-live.env \
  --mount type=bind,src=/infrastructure/cow-solver/ladders.json,dst=/etc/cow-solver/ladders.json,readonly \
  --mount type=bind,src=/infrastructure/state/cow-solver,dst=/var/lib/cow-solver \
  "${IMAGE_ID}"
```

Use local/block POSIX storage, never shared/network storage. Run exactly one
solver owner for a wallet seed/journal directory and configure
`SOLVER_JOURNAL_PATH=/var/lib/cow-solver/operations.sqlite`. A bind mount hides
the image directory ownership, so precreate the host directory with restrictive
permissions writable by numeric `10001:10001`. If infrastructure overrides the
container user, update both the configured UID/GID and volume ownership (or its
group/fsGroup equivalent) together; never make the directory world-writable.

## Update and rollback

An image is rebuilt, never patched in place:

1. commit the solver/dependency change and keep the checkout clean;
2. repeat the same build with the new full revision and a new unused SHA alias;
3. run the committed smoke and record its local `sha256:...` image ID;
4. if infrastructure imports/publishes it, record the repository/manifest
   digest produced by that process; and
5. stop the old container before starting the replacement selected by recorded
   local image ID or registry digest—not by a tag alone.

For rollback, first stop the replacement, verify the prior image documents a
compatible schema-2 journal and environment contract, then start the prior
recorded image ID/digest against the retained directory. If journal schema or
configuration is incompatible, stop and scope a migration or forward fix;
never guess or run two owners concurrently.

This repository does not publish the image, create Git tags, or provide a
registry, Kubernetes, VM, or cloud deployment manifest.
