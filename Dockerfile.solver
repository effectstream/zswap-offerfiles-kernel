# syntax=docker/dockerfile:1.7

ARG BUN_BUILD_IMAGE="oven/bun@sha256:3da1c52799fc527af4c5969876734cbaddbf3e49479c601cfebdb0d7cbcc61b4"
ARG BUN_RUNTIME_IMAGE="oven/bun@sha256:367842b35abbdf23f39e23c71f3a08eee940ff2679a14e08a5afcf4a1436cd89"

FROM ${BUN_BUILD_IMAGE} AS dependencies
WORKDIR /work

COPY package.json bun.lock ./
COPY packages/batcher/package.json packages/batcher/package.json
COPY packages/contracts-celestia/package.json packages/contracts-celestia/package.json
COPY packages/contracts-midnight/package.json packages/contracts-midnight/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/node/package.json packages/node/package.json
COPY packages/offer-guard/package.json packages/offer-guard/package.json
COPY packages/solver/package.json packages/solver/package.json
COPY packages/solver-core/package.json packages/solver-core/package.json
COPY packages/tests/package.json packages/tests/package.json
COPY packages/validator/package.json packages/validator/package.json
COPY packages/contracts-midnight/contract-offer-files/package.json packages/contracts-midnight/contract-offer-files/package.json
COPY docs/package.json docs/package.json

RUN bun install \
    --frozen-lockfile \
    --production \
    --ignore-scripts \
    --filter @zswap-da/solver

FROM dependencies AS build

COPY packages/solver/solver.container.ts packages/solver/solver.container.ts
COPY packages/solver/solver.preview.ts packages/solver/solver.preview.ts
COPY packages/solver/solver.mainnet.ts packages/solver/solver.mainnet.ts
COPY packages/solver/env.ts packages/solver/env.ts
COPY packages/solver/src packages/solver/src

COPY packages/solver-core/api-client.ts packages/solver-core/api-client.ts
COPY packages/solver-core/batcher.ts packages/solver-core/batcher.ts
COPY packages/solver-core/exact-files-contract.ts packages/solver-core/exact-files-contract.ts
COPY packages/solver-core/ladder-derivation.ts packages/solver-core/ladder-derivation.ts
COPY packages/solver-core/ladder-schema.ts packages/solver-core/ladder-schema.ts
COPY packages/solver-core/offer-updates-contract.ts packages/solver-core/offer-updates-contract.ts
COPY packages/solver-core/receipt-client.ts packages/solver-core/receipt-client.ts
COPY packages/solver-core/relay-ws-contract.ts packages/solver-core/relay-ws-contract.ts
COPY packages/solver-core/validation-contract.ts packages/solver-core/validation-contract.ts
COPY packages/solver-core/wallet.ts packages/solver-core/wallet.ts

COPY packages/validator/derive.ts packages/validator/derive.ts
COPY packages/validator/types.ts packages/validator/types.ts

RUN mkdir -p /runtime/packages/solver \
    /runtime/node_modules/.bun/classic-level@3.0.0/node_modules/classic-level \
  && bun build packages/solver/solver.container.ts \
    --target=bun \
    --outfile=/runtime/packages/solver/solver.container.ts \
  && cp node_modules/.bun/@midnight-ntwrk+ledger-v8@8.1.0/node_modules/@midnight-ntwrk/ledger-v8/midnight_ledger_wasm_bg.wasm \
    /runtime/packages/solver/ \
  && cp node_modules/.bun/@midnight-ntwrk+onchain-runtime-v3@3.0.0/node_modules/@midnight-ntwrk/onchain-runtime-v3/midnight_onchain_runtime_wasm_bg.wasm \
    /runtime/packages/solver/ \
  && cp -a node_modules/.bun/classic-level@3.0.0/node_modules/classic-level/prebuilds \
    /runtime/node_modules/.bun/classic-level@3.0.0/node_modules/classic-level/

FROM ${BUN_RUNTIME_IMAGE} AS runtime

ARG SOURCE_REVISION
ARG SOLVER_VERSION

RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && test -n "${SOURCE_REVISION}" \
  && test -n "${SOLVER_VERSION}" \
  && test -r /etc/ssl/certs/ca-certificates.crt \
  && groupadd --gid 10001 cow-solver \
  && useradd --uid 10001 --gid 10001 --no-create-home \
    --home-dir /nonexistent --shell /usr/sbin/nologin cow-solver \
  && install -d -m 0700 -o 10001 -g 10001 /var/lib/cow-solver \
  && install -d -m 0755 -o 10001 -g 10001 /work

COPY --from=build --chown=10001:10001 /runtime/ /work/

LABEL org.opencontainers.image.title="ZSwap COW Solver" \
      org.opencontainers.image.description="Solver-only runtime for the Midnight Node 1.x / ledger-v8 line" \
      org.opencontainers.image.source="https://github.com/effectstream/zswap-offerfiles-kernel" \
      org.opencontainers.image.version="${SOLVER_VERSION}" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"

ENV NODE_ENV=production \
    HOME=/nonexistent

WORKDIR /work
USER 10001:10001
ENTRYPOINT []
CMD ["bun", "--no-install", "--no-env-file", "packages/solver/solver.container.ts"]
