# deploy/images/celestia/Dockerfile — one-container Celestia devnet:
# celestia-appd v6.4.10 (consensus) + celestia-node v0.28.4 (bridge).
#
# ── Why ONE container ────────────────────────────────────────────────────────
# `@effectstream/celestia@0.103.1` initialises AND starts the bridge with
# `--core.ip 127.0.0.1`. The bridge therefore has to share a network namespace
# with the consensus node, which makes "two Compose services" impossible without
# editing behaviour we want to reproduce exactly. Hence a supervisor entrypoint.
#
# ── Why linux/amd64 ──────────────────────────────────────────────────────────
# Release 0.3.120 ships NO `celestia-*-linux-arm64` asset. Confirmed twice: the
# asset listing has only `linux-amd64` + `macos-{amd64,arm64}`, and
# `@effectstream/celestia`'s BinWrapper registers linux for `'x64'` only. So on
# this arm64 host the service runs `platform: linux/amd64` under emulation. The
# alternative — building celestia-app and celestia-node from upstream Go source
# for arm64, which the sibling midnight-2-offers stack does — was rejected: it
# is a large toolchain build for a devnet dependency AND it would run different
# binaries than the ones this repo's own dependency pins. If D2 shows emulation
# unusable, that Go build is the recorded fallback.
#
# ── Why a shell entrypoint rather than the npm wrapper ───────────────────────
# The wrapper is a Node module that downloads the binaries at first run. Baking
# the sha256-pinned binaries in at build time is the point of this image, and
# reusing the wrapper would have meant an amd64 bun + npm install purely to call
# out to the same two binaries. entrypoint.sh replicates its bootstrap step for
# step; every step cites the wrapper line it comes from.
FROM debian:trixie-slim

ARG BINARIES_RELEASE=0.3.120
ARG CELESTIA_APP_VERSION=v6.4.10
ARG CELESTIA_NODE_VERSION=v0.28.4
ARG SHA256_APPD=fa1826187a91514c6d506e22f1fcce25afbd551b98458caf899801b662a0c8da
ARG SHA256_NODE=bb8b9fd2ac859945fdf2f8c84ba038f75e01be54e56d1a946cbbd4b540f120d9

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tar jq procps \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    curl -fsSL -o /tmp/appd.tar.gz \
      "https://github.com/effectstream/binaries/releases/download/${BINARIES_RELEASE}/celestia-appd-linux-amd64-${CELESTIA_APP_VERSION}.tar.gz"; \
    echo "${SHA256_APPD}  /tmp/appd.tar.gz" | sha256sum -c -; \
    mkdir -p /tmp/appd && tar -xzf /tmp/appd.tar.gz -C /tmp/appd; \
    find /tmp/appd -type f -name 'celestia-appd' -exec install -m 0755 {} /usr/local/bin/celestia-appd \; ; \
    test -x /usr/local/bin/celestia-appd; \
    rm -rf /tmp/appd /tmp/appd.tar.gz; \
    curl -fsSL -o /tmp/node.tar.gz \
      "https://github.com/effectstream/binaries/releases/download/${BINARIES_RELEASE}/celestia-node-linux-amd64-${CELESTIA_NODE_VERSION}.tar.gz"; \
    echo "${SHA256_NODE}  /tmp/node.tar.gz" | sha256sum -c -; \
    mkdir -p /tmp/cnode && tar -xzf /tmp/node.tar.gz -C /tmp/cnode; \
    find /tmp/cnode -type f -name 'celestia' -exec install -m 0755 {} /usr/local/bin/celestia \; ; \
    test -x /usr/local/bin/celestia; \
    rm -rf /tmp/cnode /tmp/node.tar.gz

# Link check — the reason this image is on trixie and not bookworm.
# `celestia-appd v6.4.10` is built against GLIBC 2.38; bookworm ships 2.36, and
# the only symptom is the binary refusing to start LONG after the image "built
# fine". `celestia` (the node) is statically linked and passes either way, which
# is exactly how a half-broken image gets shipped — so both are checked.
RUN set -eux; \
    for bin in /usr/local/bin/celestia-appd /usr/local/bin/celestia; do \
      ldd "${bin}" > /tmp/ldd.txt 2>&1 || true; \
      echo "== ${bin}"; cat /tmp/ldd.txt; \
      if grep -q "not found" /tmp/ldd.txt; then \
        echo "ERROR: ${bin} has an unresolved shared library or symbol version" >&2; \
        exit 1; \
      fi; \
    done; \
    rm -f /tmp/ldd.txt; \
    celestia-appd version; \
    celestia version

# CELESTIA_HOME is the consensus node's home (validator keyring + genesis) and
# is the only path that must persist: the bridge home is wiped and re-inited on
# every start by design (the wrapper does the same), because the bridge is
# anchored to the genesis block hash of whatever chain it finds.
ENV CELESTIA_HOME=/data/celestia-app
ENV CELESTIA_FORCE_NO_BBR=1

COPY deploy/images/celestia/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 26657 consensus RPC, 26658 bridge (blob) RPC — the one the kernel/batcher use.
EXPOSE 26657 26658
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
