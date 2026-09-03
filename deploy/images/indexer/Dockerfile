# deploy/images/indexer/Dockerfile — midnight indexer-standalone v4.3.3.
#
# THE INDEXER PIN IS NOT A GUESS. The deployment brief left it "resolve
# empirically"; it is settled by this repo's own pinned dependency:
# `@effectstream/npm-midnight-indexer@0.103.1/binary.js` has
# `CURRENT_BINARY_VERSION = "v4.3.3"` and downloads
# `indexer-standalone-linux-<arch>-v4.3.3.zip` from release 0.3.120. That is the
# indexer `bun run dev` runs against midnight-node 1.0.0, so it is the pairing
# this stack must reproduce — not the newest 4.x the release happens to carry
# (4.4.0-rc.1 belongs to the v9 line).
FROM debian:trixie-slim

ARG TARGETARCH
ARG BINARIES_RELEASE=0.3.120
ARG INDEXER_VERSION=v4.3.3
ARG SHA256_ARM64=244fc6b1dde1dc4400ac2ea27f1ef4ce3794776cb7d153b85b93cb1ff8764212
ARG SHA256_AMD64=467a496dde5794180eb3b25ce7544428cf214b05fc51f95d34cc703826f0c1e4

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
# `indexer-standalone v4.3.3` is built against GLIBC 2.38; bookworm ships 2.36,
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
# `@effectstream/npm-midnight-indexer@0.103.1/indexer-standalone/config.yaml`
# (the file that package ships and runs the binary against, MIT/Apache-2.0).
# It is not the generic template the wrapper writes when none exists: the
# shipped one carries the v4.3.3-shaped `application:`/`spo:`/`ledger_db:`
# sections and the `blockfrost_id` placeholder, and reproducing that by hand
# would be a divergence waiting to happen. Every value that has to differ in a
# container is overridden through the binary's own `APP__*` environment
# hierarchy (see entrypoint.sh) rather than by editing this file.
WORKDIR /var/lib/indexer
COPY deploy/images/indexer/config.yaml /var/lib/indexer/config.yaml
COPY deploy/images/indexer/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8088
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
