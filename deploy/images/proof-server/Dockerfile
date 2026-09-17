# deploy/images/proof-server/Dockerfile — Midnight proof server 9.0.0-rc.5.
#
# Version provenance: `@effectstream/npm-midnight-proof-server@0.200.2`
# (a pinned dependency of this repo) hard-codes
# `CURRENT_BINARY_VERSION = "9.0.0-rc.5"`. It matches the workspace's
# `@midnightntwrk/ledger-v9: 1.0.0-rc.3` override, which the root package.json
# pins for every package — a proof server on a different ledger line would
# reject the proofs this stack builds. This is the PLAIN 9.0.0-rc.5 build
# (zkir-v2 / `verifier-key[v6]`), the lane `infra/compact.sh` compiles for;
# the `_experimental` build is the zkir-v3 lane and is not what this contract
# needs (see infra/compact-toolchain.Dockerfile).
#
# WHY AN IMAGE AND NOT A RELEASE BINARY. Release 0.3.120 publishes the rc.5
# proof-server binary for linux-amd64 and macos-arm64 only — there is no
# linux-arm64 asset, so a binary route would put this one service under
# emulation on Apple Silicon. `@effectstream/npm-midnight-proof-server` itself
# falls back to the official `midnightntwrk/proof-server` image on platforms
# without a binary, so the official multi-arch image (linux/amd64 +
# linux/arm64) is the same choice the dev stack makes. Pinned by the index
# DIGEST: a tag can be repointed at different bytes, a digest cannot.
#
# The image's ENTRYPOINT is `bash -c` at a per-digest /nix/store path and its
# CMD a single string, `midnight-proof-server --port $PORT`, so it is
# configured through environment only — see compose.yml. It carries no curl
# and no shell at a stable path, which is why compose.yml disables its
# healthcheck and the kernel entrypoints wait on the HTTP port instead.
FROM docker.io/midnightntwrk/proof-server:9.0.0-rc.5@sha256:d96a4d0f3f0f10f82698288443f2873a32fed180eb8f93c0bae83572c0a187a9

ENV RUST_BACKTRACE=full
ENV PORT=6300
EXPOSE 6300
