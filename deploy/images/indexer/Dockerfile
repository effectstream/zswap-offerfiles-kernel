# deploy/images/indexer/Dockerfile — midnight indexer-standalone v4.4.0-rc.6-ledger9final.
#
# THE INDEXER PIN IS NOT A GUESS. This repo's own pinned dependency,
# `@effectstream/npm-midnight-indexer@0.300.3/binary.js`, has
# `CURRENT_BINARY_VERSION = "v4.4.0-rc.6-ledger9final"` — the build `bun run dev`
# runs against midnight-node 2.1.0-806ff70-ledger9final. Release 0.3.120
# publishes it for both linux/amd64 and linux/arm64. The `-ledger9final` build
# carries the stable ledger-9 crates: an indexer built with the
# release-candidate crates misreads the DUST state the stable node writes
# (Custom error 170 on the next DUST spend).
FROM debian:trixie-slim

ARG TARGETARCH
ARG BINARIES_RELEASE=0.3.120
ARG INDEXER_VERSION=v4.4.0-rc.6-ledger9final
ARG SHA256_ARM64=0667eee4bc85dadc58e03f5a0de5487296a349b5b89ed69512b4d6c300d4a9ba
ARG SHA256_AMD64=fa83a5397d42d2c9bd43de1e8fdc8011af3920abff3429bba109490d11a1b01b

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
      arm64) sha="${SHA256_ARM64}";; \
      amd64) sha="${SHA256_AMD64}";; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1;; \
    esac; \
    asset="indexer-standalone-linux-${TARGETARCH}-${INDEXER_VERSION}.zip"; \
    curl -fsSL -o /tmp/ix.zip \
      "https://github.com/effectstream/binaries/releases/download/${BINARIES_RELEASE}/${asset}"; \
    echo "${sha}  /tmp/ix.zip" | sha256sum -c -; \
    unzip -q /tmp/ix.zip -d /tmp/ix; \
    install -m 0755 "/tmp/ix/indexer-standalone-linux-${TARGETARCH}-${INDEXER_VERSION}" \
      /usr/local/bin/indexer-standalone; \
    rm -rf /tmp/ix.zip /tmp/ix

# Link check — the reason this image is on trixie and not bookworm.
# `indexer-standalone` 4.4.x is built against GLIBC 2.38; bookworm ships 2.36,
# and the only symptom is the binary refusing to start LONG after the image
# "built fine". Failing the build on an unresolved library or symbol version
# puts the error next to the base image that caused it.
RUN set -eux; \
    ldd /usr/local/bin/indexer-standalone > /tmp/ldd.txt 2>&1 || true; \
    cat /tmp/ldd.txt; \
    if grep -q "not found" /tmp/ldd.txt; then \
      echo "ERROR: unresolved shared library or symbol version — base image too old" >&2; \
      exit 1; \
    fi; \
    rm -f /tmp/ldd.txt

# config.yaml is copied VERBATIM from
# `@effectstream/npm-midnight-indexer@0.300.3/indexer-standalone/config.yaml`
# (the file that package ships and runs the binary against, MIT/Apache-2.0).
# It is on the schema this binary requires: `infra.ledger_db` takes
# `cache_max_nodes` (a config with only the older `cache_size` key is refused
# with "missing field cache_max_nodes") and `infra.api.contract_state_cache`
# sizes the contract state cache. Every value that has to differ in a
# container is overridden through the binary's own `APP__*` environment
# hierarchy (see entrypoint.sh and compose.yml) rather than by editing this file.
WORKDIR /var/lib/indexer
COPY deploy/images/indexer/config.yaml /var/lib/indexer/config.yaml
COPY deploy/images/indexer/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8088
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
