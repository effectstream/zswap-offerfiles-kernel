# deploy/images/midnight-node/Dockerfile — Midnight substrate node 2.1.0-806ff70-ledger9final (dev preset).
#
# Version provenance: this is NOT a version we chose. `@effectstream/npm-midnight-node@0.300.2`
# — a pinned dependency of this repo, and what `bun run dev` actually launches —
# hard-codes `CURRENT_BINARY_VERSION = "2.1.0-806ff70-ledger9final"` and the release URL
# `https://github.com/effectstream/binaries/releases/download/0.3.120/…`. Running
# anything else here would mean the Compose stack and the dev stack are different
# chains. Same for the proof server (9.0.1) and the indexer (v4.4.0-rc.6-ledger9final).
# The `-ledger9final` builds carry the stable ledger-9 crates: a node built with
# the release-candidate ledger crates rejects the stable client's state-writing
# calls (Custom error 104).
#
# The binary is fetched at BUILD time and verified against the sha256 the GitHub
# release reports, so a rolling re-tag of `0.3.120` (it is a mirror release, not
# an immutable one) fails the build instead of silently swapping the chain.
FROM debian:trixie-slim

ARG TARGETARCH
ARG BINARIES_RELEASE=0.3.120
ARG MIDNIGHT_NODE_VERSION=2.1.0-806ff70-ledger9final
# sha256 of the release assets (gh release view 0.3.120 --repo effectstream/binaries).
ARG SHA256_ARM64=b33d6f7ae5feb9a535540bcc5a24d05503e38095f9e004b988201a86ebe49353
ARG SHA256_AMD64=355c5095ab291cde048b41100ee76e5834a1440f2e8b5522b295c46e775670a1

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
    # The zip is NOT just a binary: it also carries a `res/` resource tree, and
    # the binary needs it. `res/src/lib.rs` resolves its configuration as
    # `current_dir()/res/cfg/` (CFG_ROOT is only ever set programmatically), so
    # the node panics at startup with
    #   failed reading default.toml at path /res/cfg/default.toml
    # unless it is launched from a directory that contains `res/`. That is
    # exactly why `@effectstream/npm-midnight-node`'s run_midnight_node.js
    # spawns the binary with `cwd` set to its own extracted directory — the
    # requirement is invisible in the flag set and only shows up at runtime.
    # We reproduce the wrapper's layout: res/ next to the binary, and the
    # entrypoint cd's there before exec.
    mkdir -p /opt/midnight-node; \
    cp -a /tmp/node/res /opt/midnight-node/res; \
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

# The resource tree the node resolves from its cwd. Asserted at BUILD time
# because its absence is a startup panic, not a build error: D1's image kept
# only the binary and every `--version` gate still passed.
# Under `--dev` / `CFG_PRESET=dev` the node derives the undeployed genesis
# itself, so only the cfg tree and the genesis directory are asserted.
WORKDIR /opt/midnight-node
RUN set -eux; \
    test -f res/cfg/default.toml; \
    test -f res/cfg/dev.toml; \
    test -d res/genesis; \
    echo "res/ tree present relative to WORKDIR $(pwd)"

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
