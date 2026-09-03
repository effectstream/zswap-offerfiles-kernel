#!/usr/bin/env bash
# entrypoint-register-minted-tokens.sh — give the faucet-minted colours a NAME.
#
# A one-shot, run after the kernel is healthy. It reads `minted-tokens.json`
# from the shared `offerfiles-deploy` volume (published atomically by
# entrypoint-deploy.sh) and registers the three colours with the kernel's
# `POST /v1/known-tokens`, so every UI — the 00007 monitor site, the book
# views, the name-keyed price map — shows TESTTOKENA/B/U instead of raw hex.
#
# WHY THIS EXISTS AS A SEPARATE STEP (issues/00008-mint-test-tokens-registers-stale-path.md):
# `mint-test-tokens.ts` already tries to register the names itself, and cannot
# succeed on this stack for two independent reasons — it posts to `/api/known-tokens`,
# a path the node has never served (the route is `POST /v1/known-tokens`), and it
# posts to `127.0.0.1:9999`, which inside the deploy one-shot is that container's
# own loopback while the kernel does not even exist yet (`kernel` waits on
# `offerfiles-deploy: service_completed_successfully`). Both failures are
# swallowed by a try/catch that only logs, so nothing ever said the names were
# missing. Fixing the script is a `packages/` change and belongs to that issue;
# this is the deployment-side half, and it is where the ordering problem can
# actually be solved — only Compose knows when the kernel is healthy.
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
  log "no ${MINTED_FILE} — nothing was minted on this stack, or the deploy one-shot could not extract the colours"
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
