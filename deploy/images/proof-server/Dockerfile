# deploy/images/proof-server/Dockerfile — Midnight proof server, ledger-8.1.0.
#
# Version provenance: `@effectstream/npm-midnight-proof-server@0.103.1`
# (a pinned dependency of this repo) hard-codes
# `CURRENT_BINARY_VERSION = "ledger-8.1.0"` against release 0.3.120. It matches
# the workspace's `@midnight-ntwrk/ledger-v8: 8.1.0` override, which the root
# package.json pins for every package — a proof server on a different ledger
# line would reject the proofs this stack builds.
#
# The official `midnightnetwork/proof-server:8.1.0` image exists (the reference
# repo's own compose uses it, and `@effectstream/npm-midnight-proof-server`
# falls back to it on unsupported platforms) and is the recorded fallback if the
# raw binary ever fights this base image. The binary route is preferred because
# it is byte-identical to what the dev stack runs and it is sha256-pinned here.
FROM debian:trixie-slim

ARG TARGETARCH
ARG BINARIES_RELEASE=0.3.120
ARG PROOF_SERVER_VERSION=ledger-8.1.0
ARG SHA256_ARM64=13aa2fb681012b21e59f0c9db0048ecff146d08b38c6699c62c99106179d8221
ARG SHA256_AMD64=21d9893c947948fd183711d15db3e0b16563ef44fb2849f417fe36724f9df279

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
      arm64) sha="${SHA256_ARM64}";; \
      amd64) sha="${SHA256_AMD64}";; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1;; \
    esac; \
    asset="midnight-proof-server-linux-${TARGETARCH}-${PROOF_SERVER_VERSION}.zip"; \
    curl -fsSL -o /tmp/ps.zip \
      "https://github.com/effectstream/binaries/releases/download/${BINARIES_RELEASE}/${asset}"; \
    echo "${sha}  /tmp/ps.zip" | sha256sum -c -; \
    unzip -q /tmp/ps.zip -d /tmp/ps; \
    install -m 0755 "/tmp/ps/midnight-proof-server-linux-${TARGETARCH}-${PROOF_SERVER_VERSION}" \
      /usr/local/bin/midnight-proof-server; \
    rm -rf /tmp/ps.zip /tmp/ps

# Link check + smoke. Two of the four chain binaries in release 0.3.120 need
# GLIBC 2.38 (bookworm has 2.36) and fail only at RUN time, so every chain image
# proves its binary actually links and starts at BUILD time. This one has no
# `--version`; `--help` exits 0 and is the equivalent.
RUN set -eux; \
    ldd /usr/local/bin/midnight-proof-server > /tmp/ldd.txt 2>&1 || true; \
    cat /tmp/ldd.txt; \
    if grep -q "not found" /tmp/ldd.txt; then \
      echo "ERROR: unresolved shared library or symbol version — base image too old" >&2; \
      exit 1; \
    fi; \
    rm -f /tmp/ldd.txt; \
    /usr/local/bin/midnight-proof-server --help

ENV RUST_BACKTRACE=full
# The proof server keeps no durable state; its working dir only holds transient
# proving scratch.
WORKDIR /var/lib/proof-server

EXPOSE 6300
ENTRYPOINT ["/usr/local/bin/midnight-proof-server"]
