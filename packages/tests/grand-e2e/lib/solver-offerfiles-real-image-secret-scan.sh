#!/usr/bin/env bash
set -euo pipefail

umask 077

readonly scan_pattern_file=/run/e1-secret-patterns
readonly scan_role="${1:-}"
if (( $# > 0 )); then
  shift
fi

scan_fail() {
  printf 'image-secret-scan: fail (%s)\n' "$1" >&2
  exit 70
}

test -f "$scan_pattern_file" || scan_fail pattern-file-type
test ! -L "$scan_pattern_file" || scan_fail pattern-file-link
test -s "$scan_pattern_file" || scan_fail pattern-file-empty
test -r "$scan_pattern_file" || scan_fail pattern-file-unreadable

scan_optional_bun=not-applicable
scan_roots=()
case "$scan_role" in
  app)
    test "$#" -eq 0 || scan_fail app-arguments
    scan_roots=(/work /opt /root/.local /root/.compact)
    if test -e /root/.bun || test -L /root/.bun; then
      scan_roots+=(/root/.bun)
      scan_optional_bun=present
    else
      scan_optional_bun=absent
    fi
    ;;
  celestia)
    test "$#" -eq 0 || scan_fail celestia-arguments
    scan_roots=(/opt)
    ;;
  test)
    test "$#" -gt 0 || scan_fail test-roots
    scan_roots=("$@")
    ;;
  *)
    scan_fail role
    ;;
esac

scan_tmp=$(mktemp -d /tmp/zswap-e1-image-secret-scan.XXXXXX)
test -n "$scan_tmp" || scan_fail temp-create
case "$scan_tmp" in
  /tmp/zswap-e1-image-secret-scan.*) ;;
  *) scan_fail temp-path ;;
esac
chmod 0700 "$scan_tmp"

scan_cleanup() {
  rm -rf -- "$scan_tmp"
}
trap scan_cleanup EXIT INT TERM HUP

readonly scan_inventory="$scan_tmp/inventory.nul"
readonly scan_resolution="$scan_tmp/resolution.nul"
: >"$scan_inventory"
: >"$scan_resolution"
chmod 0600 "$scan_inventory" "$scan_resolution"

scan_resolved_path=
scan_resolve_exact() {
  local scan_resolution_label="$1"
  local scan_resolution_input="$2"
  local scan_resolution_value=
  local scan_resolution_extra=
  : >"$scan_resolution"
  readlink -z -e -- "$scan_resolution_input" >"$scan_resolution" 2>/dev/null || scan_fail "$scan_resolution_label"
  exec 6<"$scan_resolution"
  if ! IFS= read -r -d '' scan_resolution_value <&6; then
    exec 6<&-
    scan_fail "${scan_resolution_label}-truncated"
  fi
  test -n "$scan_resolution_value" || {
    exec 6<&-
    scan_fail "${scan_resolution_label}-empty"
  }
  if IFS= read -r -d '' scan_resolution_extra <&6; then
    exec 6<&-
    scan_fail "${scan_resolution_label}-extra"
  fi
  exec 6<&-
  test -z "$scan_resolution_extra" || scan_fail "${scan_resolution_label}-trailing"
  : >"$scan_resolution"
  scan_resolved_path="$scan_resolution_value"
}

scan_canonical_roots=()
for scan_root in "${scan_roots[@]}"; do
  test ! -L "$scan_root" || scan_fail root-link
  test -d "$scan_root" || scan_fail root-missing-or-type
  scan_resolve_exact root-resolution "$scan_root"
  scan_canonical="$scan_resolved_path"
  test -d "$scan_canonical" || scan_fail root-resolution-type
  scan_canonical_roots+=("${scan_canonical%/}")
done

scan_inside_roots() {
  local scan_candidate="$1"
  local scan_allowed_root
  for scan_allowed_root in "${scan_canonical_roots[@]}"; do
    case "$scan_candidate" in
      "$scan_allowed_root"|"$scan_allowed_root"/*) return 0 ;;
    esac
  done
  return 1
}

find -P "${scan_roots[@]}" -printf '%y\0%m\0%p\0%l\0' >"$scan_inventory" 2>/dev/null || scan_fail find
test -s "$scan_inventory" || scan_fail inventory-empty

scan_path_count=0
scan_link_count=0
while true; do
  scan_type=
  if ! IFS= read -r -d '' scan_type <&3; then
    test -z "$scan_type" || scan_fail inventory-truncated-type
    break
  fi
  IFS= read -r -d '' scan_mode <&3 || scan_fail inventory-truncated-mode
  IFS= read -r -d '' scan_path <&3 || scan_fail inventory-truncated-path
  IFS= read -r -d '' scan_link_payload <&3 || scan_fail inventory-truncated-link
  test -n "$scan_path" || scan_fail inventory-empty-path
  scan_inside_roots "$scan_path" || scan_fail inventory-path-escape
  scan_path_count=$((scan_path_count + 1))
  [[ "$scan_mode" =~ ^[0-7]{3,4}$ ]] || scan_fail inventory-mode
  scan_permissions=$((8#$scan_mode & 0777))
  case "$scan_type" in
    f)
      test -f "$scan_path" && test ! -L "$scan_path" || scan_fail inventory-file-type
      test -z "$scan_link_payload" || scan_fail inventory-file-link-payload
      (( (scan_permissions & 0444) != 0 )) || scan_fail unreadable-file
      ;;
    d)
      test -d "$scan_path" && test ! -L "$scan_path" || scan_fail inventory-directory-type
      test -z "$scan_link_payload" || scan_fail inventory-directory-link-payload
      if ! (( (scan_permissions & 0500) == 0500 || (scan_permissions & 0050) == 0050 || (scan_permissions & 0005) == 0005 )); then
        scan_fail unreadable-directory
      fi
      ;;
    l)
      test -L "$scan_path" || scan_fail inventory-link-type
      test -n "$scan_link_payload" || scan_fail inventory-empty-link-payload
      scan_link_count=$((scan_link_count + 1))
      scan_resolve_exact link-broken-or-loop "$scan_path"
      scan_target="$scan_resolved_path"
      if ! test -f "$scan_target" && ! test -d "$scan_target"; then
        scan_fail link-target-type
      fi
      scan_inside_roots "$scan_target" || scan_fail link-target-escape
      ;;
    *)
      scan_fail special-object
      ;;
  esac
done 3<"$scan_inventory"
test "$scan_path_count" -ge "${#scan_roots[@]}" || scan_fail inventory-record-count

scan_require_clean_grep() {
  local scan_label="$1"
  shift
  local scan_code
  set +e
  "$@" >/dev/null 2>&1
  scan_code=$?
  set -e
  test "$scan_code" -eq 1 || scan_fail "$scan_label"
}

scan_require_clean_grep inventory-bytes env LC_ALL=C grep -z -a -F -f "$scan_pattern_file" -- "$scan_inventory"
scan_require_clean_grep file-bytes env LC_ALL=C grep -r -a -F -f "$scan_pattern_file" -- "${scan_roots[@]}"

printf 'image-secret-scan role=%s roots=%s paths=%s links=%s optional-bun=%s status=clean\n' \
  "$scan_role" "${#scan_roots[@]}" "$scan_path_count" "$scan_link_count" "$scan_optional_bun"
