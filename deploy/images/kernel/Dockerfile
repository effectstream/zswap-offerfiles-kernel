# deploy/images/kernel/Dockerfile — one image, single-process entrypoints.
#
# Build context: the repository ROOT of this working clone (never a git clone of
# it: the branch this deployment belongs to is deliberately unpushed, so a
# context that fetched from a remote would build different source than the one
# under review).
#
# The image carries the whole bun workspace and ships one entrypoint per
# component. NOTHING here starts the
# in-repo orchestrator: `bun run dev` / `launchMidnight()` / `launchCelestia()`
# kill live listeners on 9944/8088/6300 (`stopProcessAtPort`). Every entrypoint
# is a single `exec`d process so
# the container's PID 1 is the real workload and Compose signals reach it.
# The one exception is entrypoint-pglite.sh: it supervises the PGlite server and
# its forwarder and passes the stop signals on to both (see that script).
#
#   entrypoint-pglite.sh    the Postgres-wire server the kernel talks to, on
#                           loopback, plus pglite-forwarder.ts on DB_PORT
#   entrypoint-kernel.sh    exec bun run packages/node/main.<dev|public>.ts (:9999)
#   entrypoint-batcher.sh   exec bun run packages/batcher/batcher.<dev|public>.ts (:3334)
#                           (from MIDNIGHT_NETWORK_ID: undeployed → .dev.ts; preview,
#                           preprod, mainnet → .public.ts; anything else exits 78)
#   entrypoint-price-feed.sh  daily CoinGecko refresh of asset_prices
#   entrypoint-maker-offer.sh       one-shot: post one real offer into the book
#   entrypoint-offer-poster.sh      loop: post prefunded coins, reuse on release
#   entrypoint-token-registry.sh    one-shot: import the network's canonical token
#                                   registry (TOKEN_REGISTRY_NETWORK); loud failure
#
# `maker-offer` is a devnet SEEDING step, and it is a service rather than a
# README step so that a stack whose book must not start empty can be brought up
# with one command. Inventory is supplied before startup through an external
# issuer.
#
# entrypoint-offer-poster.sh is neither a one-shot nor part of the default
# stack: it is the 00007 offer poster, opt-in behind the `poster` profile, and
# the only entrypoint here that keeps a durable journal of its own.
#
# bun pin rationale: 1.3.11 is the bun the R1–R3 remediation phases were built
# and tested on in this clone, and it is the version the sibling
# `midnight-2-offers` stack pins for the same reason we care about — 1.3.14
# differs from the CI test runner. Keep runtime testing on this pinned image.
FROM oven/bun:1.3.11 AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace manifests first so a source-only edit does not re-run `bun install`.
# Every workspace member listed in the root package.json must be present or
# `--frozen-lockfile` refuses the install.
COPY package.json bun.lock ./
COPY docs/package.json                                              docs/
COPY packages/api-contracts/package.json                            packages/api-contracts/
COPY packages/batcher/package.json                                  packages/batcher/
COPY packages/contracts-celestia/package.json                       packages/contracts-celestia/
COPY packages/midnight-infra/package.json                           packages/midnight-infra/
COPY packages/database/package.json                                 packages/database/
COPY packages/kernel-client/package.json                            packages/kernel-client/
COPY packages/node/package.json                                     packages/node/
COPY packages/offer-guard/package.json                              packages/offer-guard/
# Added upstream by the token price service (PRs #54-#56) but never listed here,
# which made `bun install --frozen-lockfile` refuse the committed lockfile and
# the kernel image unbuildable from `main` (found at 00007-P-C).
COPY packages/price-feed/package.json                               packages/price-feed/
COPY packages/tests/package.json                                    packages/tests/
COPY packages/validator/package.json                                packages/validator/

RUN bun install --frozen-lockfile

# The rest of the source. `.dockerignore` (see Dockerfile.dockerignore next to
# this file) keeps node_modules — 839 MB in a working checkout — out of the
# context entirely.
COPY . .

# Entrypoints last: editing one must not invalidate the install or the compile.
COPY deploy/images/kernel/entrypoint-common.sh   /usr/local/bin/entrypoint-common.sh
COPY deploy/images/kernel/entrypoint-pglite.sh   /usr/local/bin/entrypoint-pglite.sh
COPY deploy/images/kernel/pglite-forwarder.ts    /usr/local/bin/pglite-forwarder.ts
COPY deploy/images/kernel/pglite-healthcheck.ts  /usr/local/bin/pglite-healthcheck.ts
COPY deploy/images/kernel/entrypoint-kernel.sh   /usr/local/bin/entrypoint-kernel.sh
COPY deploy/images/kernel/entrypoint-batcher.sh  /usr/local/bin/entrypoint-batcher.sh
COPY deploy/images/kernel/entrypoint-price-feed.sh /usr/local/bin/entrypoint-price-feed.sh
# Devnet seeding one-shot: posts one real offer so the book does not start
# empty — see the script's header.
COPY deploy/images/kernel/entrypoint-maker-offer.sh      /usr/local/bin/entrypoint-maker-offer.sh
# The 00007 offer poster: a LOOP, opt-in behind the `poster` compose profile.
COPY deploy/images/kernel/entrypoint-offer-poster.sh     /usr/local/bin/entrypoint-offer-poster.sh
# 00050: the canonical token-registry import for a public network's database —
# a one-shot whose failure is an exit code, not a logged skip.
COPY deploy/images/kernel/entrypoint-token-registry.sh   /usr/local/bin/entrypoint-token-registry.sh
COPY deploy/images/kernel/wait-for.sh            /usr/local/bin/wait-for.sh
RUN chmod +x /usr/local/bin/entrypoint-*.sh /usr/local/bin/wait-for.sh

# No default CMD: every service names its entrypoint explicitly, so a service
# that forgot to is a startup error rather than a surprise kernel.
CMD ["/bin/sh", "-c", "echo 'this image has no default command — set one of /usr/local/bin/entrypoint-*.sh' >&2; exit 64"]
