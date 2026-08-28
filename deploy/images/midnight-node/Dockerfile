# deploy/images/midnight-node/Dockerfile — Midnight substrate node 1.0.0 (dev preset).
#
# Version provenance: this is NOT a version we chose. `@effectstream/npm-midnight-node@0.103.1`
# — a pinned dependency of this repo, and what `bun run dev` actually launches —
# hard-codes `CURRENT_BINARY_VERSION = "1.0.0"` and the release URL
# `https://github.com/effectstream/binaries/releases/download/0.3.120/…`. Running
# anything else here would mean the Compose stack and the dev stack are different
# chains. Same for the proof server (ledger-8.1.0) and the indexer (v4.3.3).
#
# The binary is fetched at BUILD time and verified against the sha256 the GitHub
# release reports, so a rolling re-tag of `0.3.120` (it is a mirror release, not
# an immutable one) fails the build instead of silently swapping the chain.
FROM debian:trixie-slim

ARG TARGETARCH
ARG BINARIES_RELEASE=0.3.120
ARG MIDNIGHT_NODE_VERSION=1.0.0
# sha256 of the release assets (gh release view 0.3.120 --repo effectstream/binaries).
ARG SHA256_ARM64=37ed130900b24df881e527cdb7ea21c124251d4b819d3b139a4a4252ec3dc603
ARG SHA256_AMD64=3826cefd5e50d3755f8d32ceb0fcf8a7c7165d35fe964bdb26b3b16657c339e4

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip jq \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
      arm64) sha="${SHA256_ARM64}";; \
      amd64) sha="${SHA256_AMD64}";; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1;; \
    esac; \
    asset="midnight-node-linux-${TARGETARCH}-${MIDNIGHT_NODE_VERSION}.zip"; \
    curl -fsSL -o /tmp/node.zip \
      "https://github.com/effectstream/binaries/releases/download/${BINARIES_RELEASE}/${asset}"; \
    echo "${sha}  /tmp/node.zip" | sha256sum -c -; \
    unzip -q /tmp/node.zip -d /tmp/node; \
    install -m 0755 "/tmp/node/midnight-node-linux-${TARGETARCH}-${MIDNIGHT_NODE_VERSION}" \
      /usr/local/bin/midnight-node; \
    rm -rf /tmp/node.zip /tmp/node

# Link check + smoke. Two of the four chain binaries in release 0.3.120 need
# GLIBC 2.38 (bookworm has 2.36) and fail only at RUN time — which is why every
# chain image is on trixie AND proves its binary links and starts at BUILD time.
RUN set -eux; \
    ldd /usr/local/bin/midnight-node > /tmp/ldd.txt 2>&1 || true; \
    cat /tmp/ldd.txt; \
    if grep -q "not found" /tmp/ldd.txt; then \
      echo "ERROR: unresolved shared library or symbol version — base image too old" >&2; \
      exit 1; \
    fi; \
    rm -f /tmp/ldd.txt; \
    /usr/local/bin/midnight-node --version

# `MC__SLOT_DURATION_MILLIS` and `MOCK_REGISTRATIONS_FILE` are applied by
# `@effectstream/npm-midnight-node`'s `run_midnight_node.js` before it spawns the
# binary, so a container that launches the binary directly must set them itself
# or it gets a different chain cadence and no validator registrations.
ENV MC__SLOT_DURATION_MILLIS=1000
ENV MOCK_REGISTRATIONS_FILE=/opt/midnight-node/local-mock.json
COPY deploy/images/midnight-node/local-mock.json /opt/midnight-node/local-mock.json

COPY deploy/images/midnight-node/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 9944 RPC (ws+http), 30333 p2p.
EXPOSE 9944 30333
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
