# compact-toolchain — the ledger-v9 compactc compiler pin in a container. The
# kernel ships no Compact contract of its own; this authenticated compiler
# route is kept for downstream work against the same ledger.
#
# The LFDT-Minokawa release archive is selected for the build architecture and
# authenticated against compact-checksums.sha256 before extraction.
#
# ENTRYPOINT is compactc itself (the version manager is not installed), so the
# invocation is `compactc <flags> <src> <outdir>`.
#
# ZKIR: compactc 0.36 bundles only the ZKIR v3 backend (`zkir-v3`), which emits
# `verifier-key[v7]` keys; the stable ledger-9 proof server (9.0.1) proves them.
# There is no ZKIR v2 backend or selection flag in this release.

FROM debian:stable-slim

# e.g. 0.36.0 -> release tag compactc-v0.36.0
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

# Fail the build if the ZKIR v3 backend is missing or the release is not the
# pinned one. `--version` prints "<version> (<commit> <date>)"; the first word
# is the version.
RUN test -x /opt/compactc/zkir-v3 || { echo "image lacks the zkir-v3 backend" >&2; exit 1; } \
 && test "$(compactc --version | awk '{print $1}')" = "$COMPACT_VERSION" \
 && test "$(compactc --language-version)" = "0.28.0" \
 && test "$(compactc --runtime-version)" = "0.21.0"

WORKDIR /work
ENTRYPOINT ["compactc"]
