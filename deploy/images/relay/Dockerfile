# deploy/images/relay/Dockerfile — the UNMODIFIED reference relay.
#
# Source: shieldedtech/midnight-intents-swaps @ 061f4d3, subtree
# `phase1-native-swaps` — the READ-ONLY conformance reference. Not one byte of
# it is edited; this file only builds it.
#
# ── How the reference gets in ────────────────────────────────────────────────
# It is a NAMED BUILD CONTEXT called `reference`, wired in compose.yml via
# `additional_contexts` from `${RELAY_REFERENCE_DIR}`. Every line that reads
# reference source is therefore visibly marked `--from=reference`, and the
# reference directory is an input to the build rather than the place the build
# recipe lives. The alternative — pointing `context:` at the reference and
# `dockerfile:` back out at this file — also works, but it hides which files
# come from where and makes the paths depend on the experiments directory name.
#
# ── Why a transcription instead of the reference's own Dockerfile ────────────
# The reference ships `infra/Dockerfile.relay`, and this is a faithful
# transcription of it: same base image, same stage split, same
# `npm ci` → build common → build relay → `npm prune --omit=dev` sequence, and
# the same `infra/supervisord.relay.conf` running
# `node packages/relay/dist/relay-main.js` as PID 1's child.
# Transcribed rather than used in place so that anything host-specific — a base
# image pin, an npm bootstrap, a build fix — lands in OUR repository. Using the
# reference's Dockerfile directly works today, but the first time this stack
# needed a build-side change there would be nowhere to put it except inside the
# reference, which is precisely what must not happen.
#
# Deliberate divergences from the reference recipe, all build-side:
#   1. `COPY --from=reference` instead of plain `COPY` (see above).
#   2. `npm i -g npm@>=11.16` in the builder (see the comment at that line).
#   3. `EXPOSE` lists only the two ports this deployment uses; the reference
#      also exposes 80/443 for its standalone ACME mode, which is off here.
#   4. The wallet-cache directory is pre-created and chowned, because Compose
#      mounts a volume onto it and the runtime user is non-root.

# ── 1. Builder ───────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# The reference's root package.json declares `engines: { npm: ">=11.16" }` and
# its `.npmrc` sets `engine-strict=true`, which turns an older bundled npm into
# a hard `npm ci` failure rather than a warning. That same `.npmrc` also sets
# `min-release-age=7` (supply-chain cooldown), `strict-allow-scripts=true` and
# `strict-npmrc=true`, none of which an older npm would honour — and the last of
# those makes an npm that does not recognise them fail rather than skip them.
# Upgrading the build tool is the only way to satisfy that from a base image we
# do not control, and it changes nothing about the relay.
RUN npm i -g "npm@>=11.16" && npm --version

# Workspace metadata — same set the reference's builder copies.
COPY --from=reference package.json package-lock.json .npmrc ./
COPY --from=reference scripts/ ./scripts/
COPY --from=reference packages/common/package.json ./packages/common/
COPY --from=reference packages/relay/package.json ./packages/relay/

RUN npm ci

# Common source + tsconfig (project reference required by relay's tsconfig).
COPY --from=reference packages/common/tsconfig.json ./packages/common/
COPY --from=reference packages/common/src ./packages/common/src

# Relay source + tsconfig.
COPY --from=reference packages/relay/tsconfig.json ./packages/relay/
COPY --from=reference packages/relay/src ./packages/relay/src

RUN npm run build --workspace=@phase1-native-swaps/common
RUN npm run build --workspace=@phase1-native-swaps/relay
RUN test -f packages/relay/dist/relay-main.js

RUN npm prune --omit=dev --workspaces --include-workspace-root

# ── 2. Runtime ───────────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache supervisor \
 && addgroup -S relay && adduser -S relay -G relay

COPY --from=builder --chown=relay:relay /app ./
COPY --from=reference infra/supervisord.relay.conf /etc/supervisord.conf

# `WALLET_CACHE_DIR` is the relay's only stateful path.
RUN mkdir -p /app/data/wallet-sync-cache && chown -R relay:relay /app/data

USER relay

# 3000 HTTP (POST /quote, GET /jobs/:jobId, GET /tokens, loopback-only
# GET /state) and 9001 the solver-facing WebSocket. Note there is NO /health
# route — compose.yml probes GET /tokens instead.
EXPOSE 3000 9001

# supervisord is PID 1; `[program:relay]` in supervisord.relay.conf runs
# `node packages/relay/dist/relay-main.js` and restarts it on crash.
CMD ["supervisord", "-c", "/etc/supervisord.conf"]
