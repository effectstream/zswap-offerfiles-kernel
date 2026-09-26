#!/usr/bin/env bash
# Run the pinned compactc against this repo.
#
#   infra/compact.sh <compactc-args...>
#
# Two routes, in order of preference:
#   1. $COMPACTC points at a host compactc binary of the pinned version -> use it.
#   2. otherwise build (once, idempotently) and run compact-toolchain:<pin>.
#
# infra/compact-version.txt is the sole version authority. COMPACT_VERSION is
# deliberately rejected so CI, host, and image builds cannot silently diverge.
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"

# Single source of truth for the compiler pin.
if [[ -n "${COMPACT_VERSION+x}" ]]; then
  echo "ERROR: COMPACT_VERSION is not supported; edit infra/compact-version.txt to change the compiler pin." >&2
  exit 1
fi
COMPACT_VERSION="$(tr -d ' \t\n' < "$INFRA_DIR/compact-version.txt")"
IMAGE="${COMPACT_IMAGE:-compact-toolchain:${COMPACT_VERSION}}"

if [[ -n "${COMPACTC:-}" ]]; then
  actual_version="$("$COMPACTC" --version)" || {
    echo "ERROR: COMPACTC=$COMPACTC does not run." >&2
    exit 1
  }
  if [[ "$actual_version" != "$COMPACT_VERSION" ]]; then
    echo "ERROR: COMPACTC=$COMPACTC reports '$actual_version'; expected exact version '$COMPACT_VERSION' from infra/compact-version.txt." >&2
    exit 1
  fi
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

actual_version="$(docker run --rm "$IMAGE" --version)" || {
  echo "ERROR: COMPACT_IMAGE=$IMAGE could not be probed." >&2
  exit 1
}
if [[ "$actual_version" != "$COMPACT_VERSION" ]]; then
  echo "ERROR: COMPACT_IMAGE=$IMAGE reports '$actual_version'; expected exact version '$COMPACT_VERSION' from infra/compact-version.txt." >&2
  exit 1
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
