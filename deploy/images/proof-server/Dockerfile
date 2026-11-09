# deploy/images/proof-server/Dockerfile — Midnight proof server 9.0.1.
#
# Version provenance: `@effectstream/npm-midnight-proof-server@0.300.2`
# (a pinned dependency of this repo) hard-codes
# `CURRENT_BINARY_VERSION = "9.0.1"`, the stable ledger-9 proof server that
# matches the workspace's `@midnightntwrk/ledger-v9: 1.0.0` override. A proof
# server on a different ledger line rejects the proofs this stack builds.
#
# The binary comes from the effectstream/binaries 0.3.120 release (published
# for linux amd64 and arm64), fetched at BUILD time and verified against the
# sha256 the release reports, like the node and indexer images: a rolling
# re-tag of the mirror release fails the build instead of swapping the prover.
#
# On first start the proof server downloads its ZK parameters from
# srs.midnight.network and binds its port only once they are in place, so any
# HTTP answer on the port means it is ready; the kernel entrypoints wait on it
# (`wait_http` on MIDNIGHT_PROOF_SERVER_URL) instead of a Compose healthcheck.
FROM debian:trixie-slim

ARG TARGETARCH
ARG BINARIES_RELEASE=0.3.120
ARG PROOF_SERVER_VERSION=9.0.1
# sha256 of the release assets (gh release view 0.3.120 --repo effectstream/binaries).
ARG SHA256_ARM64=66e52887dea95912b434a123d9520abcbc164e4201f10aaeb8a51a05773628ec
ARG SHA256_AMD64=1f8e75ff08c5535da7242768c7aafc3f2e64f57add50ce54c8e1701db46cdbc2

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

# Link check + smoke, as for the node and indexer: an unresolved library or
# symbol version fails the build next to the base image that caused it. The
# binary has no --version flag (its version is the pinned asset above, and it
# answers GET /version once running); --help proves it starts.
RUN set -eux; \
    ldd /usr/local/bin/midnight-proof-server > /tmp/ldd.txt 2>&1 || true; \
    cat /tmp/ldd.txt; \
    if grep -q "not found" /tmp/ldd.txt; then \
      echo "ERROR: unresolved shared library or symbol version — base image too old" >&2; \
      exit 1; \
    fi; \
    rm -f /tmp/ldd.txt; \
    /usr/local/bin/midnight-proof-server --help > /dev/null

ENV RUST_BACKTRACE=full
ENV PORT=6300
EXPOSE 6300
# PID 1 is the proof server itself, so Compose signals reach it.
ENTRYPOINT ["/bin/sh", "-c", "exec /usr/local/bin/midnight-proof-server --port \"${PORT}\""]
