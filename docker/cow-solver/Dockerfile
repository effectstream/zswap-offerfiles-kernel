# syntax=docker/dockerfile:1.7

ARG BUN_BUILD_IMAGE="oven/bun@sha256:3da1c52799fc527af4c5969876734cbaddbf3e49479c601cfebdb0d7cbcc61b4"
ARG BUN_RUNTIME_IMAGE="oven/bun@sha256:367842b35abbdf23f39e23c71f3a08eee940ff2679a14e08a5afcf4a1436cd89"

FROM ${BUN_BUILD_IMAGE} AS dependencies
WORKDIR /work

COPY package.json bun.lock ./
COPY packages/ packages/
COPY docs/package.json docs/package.json

RUN bun install \
    --frozen-lockfile \
    --production \
    --ignore-scripts \
    --filter @zswap-da/solver

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

COPY --from=dependencies --chown=10001:10001 /work/ /work/

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
CMD ["bun", "--no-install", "--no-env-file", "packages/solver/solver.preview.ts"]
