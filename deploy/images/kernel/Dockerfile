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
#
#   entrypoint-pglite.sh    the Postgres-wire server the kernel talks to
#   entrypoint-kernel.sh    exec bun run packages/node/main.dev.ts      (:9999)
#   entrypoint-batcher.sh   exec bun run packages/batcher/batcher.dev.ts (:3334)
#   entrypoint-solver.sh    exec bun run start.solver.ts
#   entrypoint-solver-frontend.sh  exec bun run start.solver-frontend.ts (:8080)
#   entrypoint-price-feed.sh  daily CoinGecko refresh of asset_prices
#   entrypoint-scripts.sh   the E1 provisioning / assertion driver
#   entrypoint-solver-provision.sh  one-shot: validate prefunding + write config
#   entrypoint-maker-offer.sh       one-shot: post one real offer into the book
#   entrypoint-offer-poster.sh      loop: post prefunded coins, reuse on release
#
# `solver-provision` and `maker-offer` are devnet SEEDING steps, and they are
# services rather than README steps for one reason: without them every container
# reports healthy, the solver connects to the relay, and it publishes an empty
# ladder forever with no error logged anywhere (R2 made publication bounded by
# the solver's own spendable inventory, and the ladder derives from the maker
# book). Inventory is supplied before startup through an external issuer.
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
COPY packages/batcher/package.json                                  packages/batcher/
COPY packages/contracts-celestia/package.json                       packages/contracts-celestia/
COPY packages/midnight-infra/package.json                           packages/midnight-infra/
COPY packages/database/package.json                                 packages/database/
COPY packages/node/package.json                                     packages/node/
COPY packages/offer-guard/package.json                              packages/offer-guard/
# Added upstream by the token price service (PRs #54-#56) but never listed here,
# which made `bun install --frozen-lockfile` refuse the committed lockfile and
# the kernel image unbuildable from `main` (found at 00007-P-C).
COPY packages/price-feed/package.json                               packages/price-feed/
COPY packages/solver/package.json                                   packages/solver/
COPY packages/solver-core/package.json                              packages/solver-core/
COPY packages/solver-frontend/package.json                          packages/solver-frontend/
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
COPY deploy/images/kernel/entrypoint-kernel.sh   /usr/local/bin/entrypoint-kernel.sh
COPY deploy/images/kernel/entrypoint-batcher.sh  /usr/local/bin/entrypoint-batcher.sh
COPY deploy/images/kernel/entrypoint-solver.sh   /usr/local/bin/entrypoint-solver.sh
COPY deploy/images/kernel/entrypoint-solver-frontend.sh /usr/local/bin/entrypoint-solver-frontend.sh
COPY deploy/images/kernel/entrypoint-price-feed.sh /usr/local/bin/entrypoint-price-feed.sh
COPY deploy/images/kernel/entrypoint-scripts.sh  /usr/local/bin/entrypoint-scripts.sh
# Devnet seeding one-shots. Without these the stack comes up entirely healthy
# and quotes nothing — see each script's header.
COPY deploy/images/kernel/entrypoint-solver-provision.sh /usr/local/bin/entrypoint-solver-provision.sh
COPY deploy/images/kernel/entrypoint-maker-offer.sh      /usr/local/bin/entrypoint-maker-offer.sh
# The 00007 offer poster: a LOOP, opt-in behind the `poster` compose profile.
COPY deploy/images/kernel/entrypoint-offer-poster.sh     /usr/local/bin/entrypoint-offer-poster.sh
COPY deploy/images/kernel/wait-for.sh            /usr/local/bin/wait-for.sh
RUN chmod +x /usr/local/bin/entrypoint-*.sh /usr/local/bin/wait-for.sh

# No default CMD: every service names its entrypoint explicitly, so a service
# that forgot to is a startup error rather than a surprise kernel.
CMD ["/bin/sh", "-c", "echo 'this image has no default command — set one of /usr/local/bin/entrypoint-*.sh' >&2; exit 64"]
