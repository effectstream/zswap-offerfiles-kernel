#!/usr/bin/env bash
# entrypoint-register-minted-tokens.sh — give the faucet-minted colours a NAME.
#
# A compatibility/backstop one-shot, run after the post-kernel mint one-shot.
# It reads `minted-tokens.json` from the shared `offerfiles-deploy` volume
# (published atomically by entrypoint-mint-test-tokens.sh) and repeats the three
# registrations against `POST /v1/known-tokens`. On a clean successful stack
# every response is 409: the mint script already performed the primary work.
#
# WHY THIS REMAINS AS A SEPARATE STEP FOR THIS RELEASE:
# older deployment paths used this script as the primary repair for a stale
# mint-script route. Keeping it after the fixed mint one-shot makes upgrades
# idempotent and makes the expected 409 behavior visible while operators move
# to the new contract -> kernel -> mint/register sequence.
#
# SPELLINGS. TESTTOKENA / TESTTOKENB / TESTTOKENU, matching what the frontend
# faucet registers on preprod (the mint script's mixed-case `TestTokenA` would
# be uppercased by the API anyway, but naming them the same way here keeps the
# name-keyed price map and preprod in agreement).
#
# NON-FATAL BY DESIGN, like the mint step it follows. Nothing in the stack needs
# these names to trade: they are display labels, the monitor falls back to short
# hex without them (spec FR-013b), and a stack whose mint failed or whose
# operator turned the registry off must not be blocked by a cosmetic step. Every
# outcome is logged with its HTTP status, which is the other half of the issue's
# complaint — the old code could not tell "registered" from "404" from "the node
# is not up".
set -euo pipefail

. /usr/local/bin/entrypoint-common.sh

require_env ZSWAP_API

if [ "${REGISTER_MINTED_TOKENS_ENABLED:-true}" != "true" ]; then
  log "REGISTER_MINTED_TOKENS_ENABLED=${REGISTER_MINTED_TOKENS_ENABLED:-} — not registering token names"
  exit 0
fi

MINTED_FILE="${MINTED_TOKENS_FILE:-${CONTRACT_SHARE_DIR}/minted-tokens.json}"

if [ ! -f "${MINTED_FILE}" ]; then
  log "no ${MINTED_FILE} — nothing was minted on this stack, or the mint one-shot could not publish the colours"
  log "skipping registration (non-fatal); token colours will render as short hex"
  exit 0
fi

# The kernel is a `service_healthy` dependency, so it is already answering; this
# wait only covers the gap between "healthcheck passed" and this container's
# first packet, and it fails loudly instead of posting into a void.
wait_http "${ZSWAP_API}/v1/health" "kernel API" "${KERNEL_WAIT_TIMEOUT_S:-300}"

log "registering minted token names with ${ZSWAP_API}/v1/known-tokens from ${MINTED_FILE}"

# One `bun -e` rather than three curl calls: the image has no curl, the file is
# JSON, and the exit status has to distinguish "registered" (201) and "already
# there" (409) from everything else. A 404 means ENABLE_TOKEN_REGISTRY is off,
# which is a deliberate operator choice and not an error here.
bun -e '
const [mintedPath, apiBase] = process.argv.slice(1);
const minted = await Bun.file(mintedPath).json();

/** The three faucet colours, under the spellings preprod already uses. */
const wanted = [
  { key: "shieldedA", name: "TESTTOKENA", kind: "shielded" },
  { key: "shieldedB", name: "TESTTOKENB", kind: "shielded" },
  { key: "unshielded", name: "TESTTOKENU", kind: "unshielded" },
];

let registered = 0;
let already = 0;
let skipped = 0;
let failed = 0;

for (const { key, name, kind } of wanted) {
  const raw = minted[key];
  if (typeof raw !== "string" || !/^[0-9a-f]{64}$/i.test(raw.replace(/^0x/, ""))) {
    console.error(`[register-minted-tokens] ${name}: ${mintedPath} has no 64-hex "${key}" colour — skipping`);
    skipped += 1;
    continue;
  }
  const color = raw.replace(/^0x/, "").toLowerCase();
  let response;
  try {
    response = await fetch(`${apiBase}/v1/known-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // decimals is STATED, not left to the column default (00024 FR-002):
      // the faucet mints whole coins scaled by 10^6, so the registry has to say
      // 6 or every price and sponsorship verdict for this colour is off by
      // 10^6. The literal mirrors DEFAULT_TOKEN_DECIMALS in
      // packages/solver-core/amount.ts — this runs as a bare `bun -e` snippet
      // inside the image, with no module to import it from.
      body: JSON.stringify({ color, name, kind, decimals: 6 }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error(`[register-minted-tokens] ${name} ${color.slice(0, 16)}…: request failed — ${error instanceof Error ? error.message : String(error)}`);
    failed += 1;
    continue;
  }
  const body = (await response.text()).slice(0, 200);
  if (response.ok) {
    console.error(`[register-minted-tokens] ${name} ${color.slice(0, 16)}…: registered (${response.status})`);
    registered += 1;
  } else if (response.status === 409) {
    // Idempotence: a re-run, or a colour/name this stack already knows.
    console.error(`[register-minted-tokens] ${name} ${color.slice(0, 16)}…: already registered (409) ${body}`);
    already += 1;
  } else if (response.status === 404) {
    console.error(`[register-minted-tokens] ${name}: registry disabled (404) — set ENABLE_TOKEN_REGISTRY=true on the kernel; names stay unregistered`);
    skipped += 1;
  } else {
    console.error(`[register-minted-tokens] ${name} ${color.slice(0, 16)}…: HTTP ${response.status} ${body}`);
    failed += 1;
  }
}

console.error(`[register-minted-tokens] done: ${registered} registered, ${already} already present, ${skipped} skipped, ${failed} failed`);
' "${MINTED_FILE}" "${ZSWAP_API}" || log "WARNING: registration step exited non-zero — continuing (names are cosmetic)"

exit 0
