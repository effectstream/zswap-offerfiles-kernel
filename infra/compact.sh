#!/usr/bin/env bash
# Run the pinned compactc against this repo.
#
#   infra/compact.sh <compactc-args...>
#
# Two routes, in order of preference:
#   1. $COMPACTC points at a host compactc binary of the pinned version -> use it.
#   2. otherwise build (once, idempotently) and run compact-toolchain:$COMPACT_VERSION.
#
# The `compact` version manager is NOT a route: it does not publish the 0.33
# line (see infra/compact-toolchain.Dockerfile for the details).
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"

# Single source of truth for the compiler pin.
COMPACT_VERSION="${COMPACT_VERSION:-$(tr -d ' \t\n' < "$INFRA_DIR/compact-version.txt")}"
IMAGE="${COMPACT_IMAGE:-compact-toolchain:${COMPACT_VERSION}}"

if [[ -n "${COMPACTC:-}" ]]; then
  exec "$COMPACTC" "$@"
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "building ${IMAGE} from release asset compactc-v${COMPACT_VERSION} ..." >&2
  docker build \
    --build-arg "COMPACT_VERSION=${COMPACT_VERSION}" \
    -f "$INFRA_DIR/compact-toolchain.Dockerfile" \
    -t "$IMAGE" \
    "$INFRA_DIR" >&2
fi

# Mount the repo root (not the package dir) so relative include paths and
# COMPACT_PATH lookups resolve the same way they do on a host install. The
# caller's cwd inside the repo is preserved.
rel_cwd="${PWD#"$REPO_ROOT"}"
rel_cwd="${rel_cwd#/}"

# Key generation downloads the universal SRS ("params") from srs.midnight.network
# and caches it under $XDG_CACHE_HOME. Persist that outside the container so
# repeat compiles need no network. Cache dir is gitignored.
CACHE_DIR="${MIDNIGHT_ZK_PARAMS_DIR:-$REPO_ROOT/.compact-cache}"
mkdir -p "$CACHE_DIR"

# We run as the host user so the emitted src/managed/ tree is not root-owned.
# That makes the image's default HOME (/root) unwritable, and zkir then dies with
# "Permission denied (os error 13)" / "zkir returned a non-zero exit status 1"
# while writing its params cache — hence the explicit HOME and XDG_CACHE_HOME.
exec docker run --rm \
  -v "$REPO_ROOT:/repo" \
  -v "$CACHE_DIR:/cache" \
  -w "/repo${rel_cwd:+/$rel_cwd}" \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -e XDG_CACHE_HOME=/cache \
  "$IMAGE" "$@"
