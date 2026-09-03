# deploy/images/kernel/Dockerfile — ONE image, NINE single-process entrypoints.
#
# Build context: the repository ROOT of this working clone (never a git clone of
# it: the branch this deployment belongs to is deliberately unpushed, so a
# context that fetched from a remote would build different source than the one
# under review).
#
# The image carries the whole bun workspace plus the Compact-compiled contract
# artifacts, and ships one entrypoint per component. NOTHING here starts the
# in-repo orchestrator: `bun run dev` / `launchMidnight()` / `launchCelestia()`
# kill live listeners on 9944/8088/6300 (`stopProcessAtPort`) and a re-deploy
# would mint a fresh contract identity, which is exactly what a long-lived
# Compose stack must never do. Every entrypoint is a single `exec`d process so
# the container's PID 1 is the real workload and Compose signals reach it.
#
#   entrypoint-pglite.sh    the Postgres-wire server the kernel talks to
#   entrypoint-deploy.sh    one-shot: deploy the Compact contract, then mint
#   entrypoint-kernel.sh    exec bun run packages/node/main.dev.ts      (:9999)
#   entrypoint-batcher.sh   exec bun run packages/batcher/batcher.dev.ts (:3334)
#   entrypoint-solver.sh    exec bun run start.solver.ts
#   entrypoint-solver-frontend.sh  exec bun run start.solver-frontend.ts (:8080)
#   entrypoint-price-feed.sh  daily CoinGecko refresh of asset_prices
#   entrypoint-scripts.sh   the E1 provisioning / assertion driver
#   entrypoint-solver-provision.sh  one-shot: fund + mint the solver BOTH tokens
#   entrypoint-maker-offer.sh       one-shot: post one real offer into the book
#
# `solver-provision` and `maker-offer` are devnet SEEDING steps, and they are
# services rather than README steps for one reason: without them every container
# reports healthy, the solver connects to the relay, and it publishes an empty
# ladder forever with no error logged anywhere (R2 made publication bounded by
# the solver's own spendable inventory, and the ladder derives from the maker
# book). `register-minted-tokens` is the cosmetic third: it is the only place
# the mint script's broken name registration (issues/00008-…) can be repaired
# without touching `packages/`, because only Compose knows when the kernel is
# healthy — and it is what makes the book and the monitor site read TESTTOKENA/B/U
# instead of raw colour hex.
#
# bun pin rationale: 1.3.11 is the bun the R1–R3 remediation phases were built
# and tested on in this clone, and it is the version the sibling
# `midnight-2-offers` stack pins for the same reason we care about — 1.3.14
# breaks `midnight-contract:deploy` through graphql-tag's UMD/ESM interop, and
# that deploy is one of this image's entrypoints. CI's `bun-version: 1.3.3` is
# the unit-test runner only and is deliberately NOT this pin.
FROM oven/bun:1.3.11 AS build

# `compact` is a system toolchain, not an npm dependency. The version is pinned
# to 0.30.0 by this repo in two independent places — `start.dev.ts`
# (`COMPACT_VERSION = "0.30.0"`, enforced by its `compact-check` process) and
# `packages/contracts-midnight/contract-offer-files/package.json`
# (`compact compile +0.30.0 …`). Do not bump one without the others.
ARG COMPACT_VERSION=0.30.0
# The toolchain MANAGER is pinned too. README/`start.dev.ts` both quote the
# `releases/latest/...` installer URL, but `latest` is mutable, so this build
# uses the equivalent versioned asset — same script, reproducible.
ARG COMPACT_INSTALLER_RELEASE=compact-v0.5.2
ENV COMPACT_DIRECTORY=/opt/compact/toolchains
ENV PATH="/opt/compact/bin:${PATH}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*

# `COMPACT_UNMANAGED_INSTALL` is the cargo-dist installer's install-prefix hook:
# it drops the binary straight into the given directory and skips the
# self-updater and the PATH-rewriting shell profile, neither of which a
# container wants. `compact list` is echoed into the build log so the record
# shows which toolchains the pinned manager actually offered.
RUN set -eux; \
    curl --proto '=https' --tlsv1.2 -LsSf \
      "https://github.com/midnightntwrk/compact/releases/download/${COMPACT_INSTALLER_RELEASE}/compact-installer.sh" \
      -o /tmp/compact-installer.sh; \
    COMPACT_UNMANAGED_INSTALL=/opt/compact/bin sh /tmp/compact-installer.sh; \
    rm -f /tmp/compact-installer.sh; \
    compact --version; \
    compact update "${COMPACT_VERSION}"; \
    compact list

WORKDIR /app

# Workspace manifests first so a source-only edit does not re-run `bun install`.
# Every workspace member listed in the root package.json must be present or
# `--frozen-lockfile` refuses the install.
COPY package.json bun.lock ./
COPY docs/package.json                                              docs/
COPY packages/batcher/package.json                                  packages/batcher/
COPY packages/contracts-celestia/package.json                       packages/contracts-celestia/
COPY packages/contracts-midnight/package.json                       packages/contracts-midnight/
COPY packages/contracts-midnight/contract-offer-files/package.json  packages/contracts-midnight/contract-offer-files/
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

# Compile the Compact contract. `src/managed/` is gitignored, so it exists only
# because of this step; the deploy one-shot, the kernel's `readMidnightContract`
# and the mint script all read `contract-offer-files/src/managed/{compiler,
# contract,keys,zkir}` at runtime.
#
# Its inputs are copied on their own, ahead of the rest of the source, because
# this step generates proving keys and takes ~20 minutes. Under a single
# `COPY . .` every edit anywhere in the repository — an entrypoint, the E2E
# driver, a README — invalidated it. The later `COPY . .` re-lands these same
# files, and `src/managed/` survives it because the generated tree is gitignored
# and therefore not in the build context at all.
COPY packages/contracts-midnight ./packages/contracts-midnight
RUN bun run build:midnight \
 && test -d packages/contracts-midnight/contract-offer-files/src/managed

# The rest of the source. `.dockerignore` (see Dockerfile.dockerignore next to
# this file) keeps node_modules — 839 MB in a working checkout — out of the
# context entirely.
COPY . .

# Entrypoints last: editing one must not invalidate the install or the compile.
COPY deploy/images/kernel/entrypoint-common.sh   /usr/local/bin/entrypoint-common.sh
COPY deploy/images/kernel/entrypoint-pglite.sh   /usr/local/bin/entrypoint-pglite.sh
COPY deploy/images/kernel/entrypoint-deploy.sh   /usr/local/bin/entrypoint-deploy.sh
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
COPY deploy/images/kernel/wait-for.sh            /usr/local/bin/wait-for.sh
RUN chmod +x /usr/local/bin/entrypoint-*.sh /usr/local/bin/wait-for.sh

# No default CMD: every service names its entrypoint explicitly, so a service
# that forgot to is a startup error rather than a surprise kernel.
CMD ["/bin/sh", "-c", "echo 'this image has no default command — set one of /usr/local/bin/entrypoint-*.sh' >&2; exit 64"]
