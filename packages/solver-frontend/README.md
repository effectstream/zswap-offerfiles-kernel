# `@zswap-da/solver-frontend` — the COW solver monitor

A **read-only** operations console for the COW solver. One Bun process, zero
runtime dependencies, no build step, no database. It answers one question at a
glance — *is the solver quoting, and if not, why* — and then lets you drill into
the ladder it published, the offers it refused and the jobs it settled.

```bash
bun run start:solver-frontend      # from the repository root
```

Nothing on the page or in this service writes anything anywhere. The solver's
status listener has no mutating route, and this service has no route that
proxies a caller-chosen path to it.

## What it shows

| Block | Answers | Read from |
|---|---|---|
| Status pill | QUOTING / WITHDRAWN / DISCONNECTED / STARTING / DRY-RUN / SOLVER UNREACHABLE | the solver snapshot |
| Health strip | six stages — kernel sync → book cache → inventory → journal & DUST → relay socket → published ladder — each with a one-line reason and a "since" | kernel `/v1/health/sync` + the solver snapshot |
| Alarms | only what is wrong: unreachable, relay down, cache blocked, DUST window blocked, quarantined jobs, failed reverts, push failures, an empty relay token list, a degraded status section, a contract mismatch | derived |
| Tiles | pairs, rungs (whole vs interior), tokens advertised, pushes, book size, jobs in flight, completed, quarantined, withdrawals observed, per-job DUST | solver + kernel + this service |
| Published ladders | per directed pair: cumulative input → output, implied rate to 6 dp, whether a rung closes a **whole** maker offer or is **interior** liquidity served from solver inventory, and the maker hash | the solver's last derived push |
| Not published | every book offer the derivation left out, with the solver's OWN `LadderExclusionReason` (`multi-leg`, `non-shielded-leg`, `unavailable`, `rung-cap`, `residual-budget`, `invalid-pair`, …) | the same push's exclusions |
| Book | the kernel's offers beside the solver's mirror: cached or not, on the wire at which rung or excluded for which reason | kernel `/v1/offers` + solver |
| Jobs | the newest journal rows: state, offers, payout, receipt. **No transaction bytes** — the contract has no field for them | the solver's journal tail |
| Inventory / DUST / Relay / Configuration / Events | balances, the rolling fee window, the relay's public token list, the launch settings as resolved (no secrets), and a merged log of solver diagnostics and this service's own observations | as labelled in each block's `?` |

Every section header, stage, tile and the pill carry a `?` whose tooltip says in
one sentence what the block means and names its data source.

**An empty ladder is never shown as "no liquidity".** When the solver's push
carries a `withheld` reason the page says which one: `cache-not-current` is the
fail-closed withdrawal (the solver refuses to quote from a cache it cannot
trust) and `withdrawn` is a deliberate one (a graceful stop or an explicit
withdrawal). They look different on purpose.

**Amounts are integer base units everywhere.** The solver, the relay wire and
the journal are base-unit only. Where the kernel's token registry gives a colour
`decimals > 0`, the coin-denominated value is shown *beside* the base units and
marked as derived — never instead of them. A colour with no registry row is
shown as short hex, never hidden.

## Configuration

Resolved and validated before the listener binds. A startup that is missing or
malformed values exits `1` with **one** message listing every problem — the same
contract `start:solver` follows.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `SOLVER_FRONTEND_SOLVER_STATUS_URL` | **yes** | — | The solver's status listener base, e.g. `http://solver:9100`. The solver serves it when `SOLVER_STATUS_PORT` is set. |
| `SOLVER_FRONTEND_SOLVER_STATUS_TOKEN` | **yes** | — | The solver's `SOLVER_STATUS_AUTH_TOKEN`, ≥ 32 characters. Sent as `Authorization: Bearer` to the solver **and nowhere else**. |
| `SOLVER_FRONTEND_ZSWAP_API` | **yes** | — | Kernel Offer Files REST base, e.g. `http://kernel:9999`. Not derived from the solver's configuration: the page must keep rendering the book while the solver is down. |
| `SOLVER_FRONTEND_RELAY_HTTP_URL` | no | *(unset)* | Relay public HTTP base. Only `GET /tokens` is read. Unset simply hides that panel (with a startup warning). |
| `SOLVER_FRONTEND_HOST` | no | `127.0.0.1` | Listen interface. A non-loopback value is a warning, not a refusal — Compose sets `0.0.0.0` inside the container network. |
| `SOLVER_FRONTEND_PORT` | no | `8080` | Listen port, 1–65535. |
| `SOLVER_FRONTEND_POLL_MS` | no | `4000` | Kernel and relay poll interval, 250–300 000 ms. The solver side prefers SSE and only polls as a fallback. |
| `SOLVER_FRONTEND_HISTORY_LIMIT` | no | `500` | Transitions kept in memory, 1–5000. |

The startup banner prints the bearer's **length**, never its value.

## Routes

| Route | |
|---|---|
| `GET /` | the page |
| `GET /{index.html,styles.css,app.js,derive.js,help.js}` | the five static files, by name |
| `GET /api/snapshot` | the aggregated `MonitorSnapshot` as JSON |
| `GET /api/stream` | the same, as SSE: one frame on connect, then on change |
| `GET /health` | `{status, uptimeMs, solver:{state,lastSeenAt}}` for a container healthcheck |

Everything else is `404`; a write method on a known route is `405`. Static files
are served from a **compiled five-entry manifest**, so a traversal attempt (raw
or percent-encoded) never reaches a filesystem call.

## How it reads the solver

It prefers `GET /status/stream` (SSE) and falls back to `GET /status/snapshot`
when the stream is unavailable — which happens legitimately, for instance when
the solver's stream client cap is full.

The solver **closes each stream after five minutes** so that cap can self-heal
on a runtime that never reports client disconnects. A stream that delivered
frames and then ended is therefore normal: this service reconnects immediately,
records no outage and raises no alarm. Only a stream that fails, or one that
delivers nothing, backs off (500 ms doubling to 10 s) and falls back to polling.

Reachability is tracked as three states, and the difference matters:

* **`never-reached`** — the listener has not answered *once*. Usually
  `SOLVER_STATUS_PORT` is unset on the solver, or the bearers do not match; the
  page says so and names the last error.
* **`reachable`** — answering; `lastSeenAt` advances with every frame.
* **`unreachable`** — it *was* answering and stopped. The last good snapshot is
  kept and greyed, with "last seen HH:MM:SS", and the kernel and relay panels
  beside it stay live.

## Security posture

* **Read-only.** No route here or on the solver's status listener changes
  anything. The page sends nothing anywhere.
* **The status bearer never leaves this process.** It is attached to solver
  requests only; it is absent from `/api/*`, from the page, from every log line,
  and from the startup banner (which prints its length). A test greps every
  response body and header for it.
* **The page has no authentication of its own** and is not intended to. Bind it
  to loopback, or to a container network published on `127.0.0.1`, and put the
  host's reverse proxy in front of it if it must be reachable more widely — the
  same way the relay's own deployment is fronted. A generic snippet:

  ```nginx
  location /cow-solver/ {
      auth_basic            "cow solver";
      auth_basic_user_file  /etc/nginx/.htpasswd;
      proxy_pass            http://127.0.0.1:18080/;
      proxy_http_version    1.1;
      proxy_buffering       off;    # /api/stream is Server-Sent Events
      proxy_read_timeout    10m;    # longer than the 5-minute stream lifetime
  }
  ```

  Whatever proxy you use, **disable response buffering** on `/api/stream` and
  allow a read timeout longer than five minutes, or the feed will appear frozen
  and fall back to polling.
* **The solver's status port must never be published to a public interface.**
  The snapshot carries the solver's whole internal state; only this service
  should be able to reach it, over a private network.
* **The page loads nothing from another origin** — no CDN, no web font, no
  analytics — so it works on an air-gapped host. A test asserts it.

## Development

```bash
bun test packages/solver-frontend         # env + server + derivation suites
bun run typecheck:solver                  # this package is in the strict gate
```

To look at the page without a solver, kernel or relay:

```bash
bun run packages/solver-frontend/test-helpers/serve-fixture.ts   # prints the env to use
# in another shell, paste the printed environment and:
bun run start:solver-frontend
```

`SOLVER_FRONTEND_FIXTURE_STATE` selects the state to look at: `quoting`
(default), `withdrawn`, `blocked`, `relay-down`, `dry-run`, `unreachable`.

The browser-side code is deliberately split: `public/derive.js` holds every
*judgement* as pure functions of a `MonitorSnapshot` and is unit-tested without
a DOM; `public/app.js` only writes what those functions return into the page.
Help texts live in `public/help.js`, keyed by block id, and a test asserts that
the ids in `public/index.html` and the keys of that map are exactly equal.
