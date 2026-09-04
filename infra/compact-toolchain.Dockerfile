# compact-toolchain — the pinned compactc compiler in a container, so no host
# machine needs a matching Compact install to build this contract.
#
# The LFDT-Minokawa release archive is selected for the build architecture and
# authenticated against compact-checksums.sha256 before extraction. Keeping the
# toolchain in a small image gives host and CI compilation one identical route.
#
# ENTRYPOINT is compactc itself (the version manager is not installed), so the
# invocation is `compactc <flags> <src> <outdir>` — see
# packages/contracts-midnight/contract-offer-files/package.json.
#
# NOTE ON ZKIR: we deliberately do NOT pass `--feature-zkir-v3`. compactc 0.34
# still defaults to ZKIR version 2, which emits `verifier-key[v6]` keys; the ledger
# maps those to ProofVersioned::V2, which the PLAIN `proof-server:9.0.0-rc.5`
# image proves. Passing `--feature-zkir-v3` would emit `verifier-key[v7]` keys
# and require the `9.0.0-rc.5_experimental` proof-server build instead. This
# contract has no cross-contract calls and no secp256k1/keccak primitives, so
# there is nothing to gain from the v3 lane and a harder deployment if we take it.

FROM debian:stable-slim

# e.g. 0.34.0 -> release tag compactc-v0.34.0
ARG COMPACT_VERSION
ARG TARGETARCH

COPY compact-checksums.sha256 /opt/compact-checksums.sha256

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip bash \
 && rm -rf /var/lib/apt/lists/*

RUN test -n "$COMPACT_VERSION" || { echo "COMPACT_VERSION build arg is required" >&2; exit 1; }

# The assets are musl-static, one per platform triple.
RUN set -eux; \
    test -n "${TARGETARCH:-}" || { echo "TARGETARCH is required" >&2; exit 1; }; \
    case "$TARGETARCH" in \
      arm64) triple="aarch64-unknown-linux-musl" ;; \
      amd64) triple="x86_64-unknown-linux-musl" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    asset="compactc_v${COMPACT_VERSION}_${triple}.zip"; \
    url="https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v${COMPACT_VERSION}/${asset}"; \
    curl --proto '=https' --tlsv1.2 -fLsS -o "/tmp/${asset}" "$url"; \
    expected="$(awk -v asset="$asset" '$2 == asset { print $1 }' /opt/compact-checksums.sha256)"; \
    test -n "$expected" || { echo "no SHA-256 recorded for $asset" >&2; exit 1; }; \
    printf '%s  %s\n' "$expected" "/tmp/${asset}" | sha256sum -c -; \
    mkdir -p /opt/compactc; \
    unzip -q "/tmp/${asset}" -d /opt/compactc; \
    rm "/tmp/${asset}"; \
    chmod +x /opt/compactc/*; \
    # NOT a symlink: the bundled `compactc` wrapper resolves its siblings from
    # `dirname $0`, which through a symlink in /usr/local/bin points at the wrong
    # directory and fails with "compactc.bin: No such file or directory".
    printf '#!/bin/sh\nexec /opt/compactc/compactc "$@"\n' > /usr/local/bin/compactc; \
    chmod +x /usr/local/bin/compactc

# Fail the BUILD, not some later contract compile, if the default (v2) zkir
# backend is missing: without it compactc silently emits no verifier keys after
# printing a warning, and the failure would only surface at proving time.
RUN test -x /opt/compactc/zkir || { echo "image lacks the default zkir backend" >&2; exit 1; } \
 && test "$(compactc --version)" = "$COMPACT_VERSION" \
 && test "$(compactc --language-version)" = "0.26.0" \
 && test "$(compactc --runtime-version)" = "0.19.0"

WORKDIR /work
ENTRYPOINT ["compactc"]
