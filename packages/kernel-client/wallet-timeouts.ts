// How long the kernel's wallet tools wait for a wallet sync and for one proof
// request, read from the environment.
//
//   MIDNIGHT_WALLET_SYNC_TIMEOUT_MS    180000  default of every wallet-sync wait
//                                              (waitForSync, the offer poster's
//                                              first sync); a per-call
//                                              `timeoutMs` still wins. A first
//                                              sync of a public network replays
//                                              its whole history and can take
//                                              far longer than the default.
//   MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS  600000  deadline of one proof request the
//                                              kernel's own code sends. The
//                                              wallet SDK's HTTP prover has no
//                                              timeout of its own, so a proof
//                                              server that accepts a connection
//                                              and never answers (for example
//                                              after an out-of-memory kill of a
//                                              worker) would hold the caller for
//                                              ever.
//
// Pure and dependency-free: the entries validate these values before they load
// the wallet SDK, and refuse a malformed one with exit 78 naming it.

export const WALLET_SYNC_TIMEOUT_ENV = "MIDNIGHT_WALLET_SYNC_TIMEOUT_MS";
export const DEFAULT_WALLET_SYNC_TIMEOUT_MS = 180_000;
export const PROOF_REQUEST_TIMEOUT_ENV = "MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS";
export const DEFAULT_PROOF_REQUEST_TIMEOUT_MS = 600_000;

// Below one second is a unit mistake (seconds for milliseconds); above one day
// nobody is waiting any more, and timers cap at 2^31 - 1 ms anyway.
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 86_400_000;

type Env = Readonly<Record<string, string | undefined>>;

/** Refusal for one variable, or undefined when it is unset, blank or valid. */
function timeoutProblem(env: Env, name: string, defaultMs: number): string | undefined {
  const raw = env[name];
  const trimmed = raw === undefined || raw === null ? "" : String(raw).trim();
  if (trimmed === "") return undefined;
  const value = /^[0-9]+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (Number.isSafeInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS) return undefined;
  return `${name} must be an integer number of milliseconds from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} ` +
    `(default ${defaultMs}), got "${trimmed}"`;
}

/** Every refusal for the two variables, each starting with the variable name. */
export function walletTimeoutProblems(env: Env): string[] {
  return [
    timeoutProblem(env, WALLET_SYNC_TIMEOUT_ENV, DEFAULT_WALLET_SYNC_TIMEOUT_MS),
    timeoutProblem(env, PROOF_REQUEST_TIMEOUT_ENV, DEFAULT_PROOF_REQUEST_TIMEOUT_MS),
  ].filter((p): p is string => p !== undefined);
}

export class WalletTimeoutConfigError extends Error {
  constructor(readonly variable: string, message: string) {
    super(message);
    this.name = "WalletTimeoutConfigError";
  }
}

function resolve(env: Env, name: string, defaultMs: number): number {
  const problem = timeoutProblem(env, name, defaultMs);
  if (problem !== undefined) throw new WalletTimeoutConfigError(name, problem);
  const trimmed = String(env[name] ?? "").trim();
  return trimmed === "" ? defaultMs : Number(trimmed);
}

/** The default wallet-sync wait: MIDNIGHT_WALLET_SYNC_TIMEOUT_MS, else 180 s.
 * Throws {@link WalletTimeoutConfigError} on a malformed value. */
export function walletSyncTimeoutMs(env: Env = process.env): number {
  return resolve(env, WALLET_SYNC_TIMEOUT_ENV, DEFAULT_WALLET_SYNC_TIMEOUT_MS);
}

/** The proof-request deadline: MIDNIGHT_PROOF_REQUEST_TIMEOUT_MS, else 10 min.
 * Throws {@link WalletTimeoutConfigError} on a malformed value. */
export function proofRequestTimeoutMs(env: Env = process.env): number {
  return resolve(env, PROOF_REQUEST_TIMEOUT_ENV, DEFAULT_PROOF_REQUEST_TIMEOUT_MS);
}

/** `protocol//host[:port]` of a URL: enough to name the proof server, nothing
 * that could carry a credential (userinfo, path, query). */
export function proofServerOrigin(url: string | URL): string {
  try {
    const parsed = new URL(String(url));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "<unparseable proof server URL>";
  }
}

export class ProofDeadlineError extends Error {
  readonly proofServer: string;
  readonly timeoutMs: number;
  constructor(proofServer: string, timeoutMs: number) {
    super(
      `proof request to ${proofServer} did not finish within ${timeoutMs} ms ` +
        `(${PROOF_REQUEST_TIMEOUT_ENV}); is the proof server up and not out of memory?`,
    );
    this.name = "ProofDeadlineError";
    this.proofServer = proofServer;
    this.timeoutMs = timeoutMs;
  }
}

export interface ProofDeadlineOptions {
  /** The proof server the request goes to; only its origin is reported. */
  proofServerUrl: string | URL;
  /** Defaults to {@link proofRequestTimeoutMs} of the environment. */
  timeoutMs?: number;
}

/**
 * Settle with `operation`, or reject with {@link ProofDeadlineError} once the
 * deadline passes. The wallet SDK offers no way to cancel a proof request, so
 * the request itself keeps running; only the caller is released.
 */
export function withProofDeadline<T>(operation: () => Promise<T>, opts: ProofDeadlineOptions): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? proofRequestTimeoutMs();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error(`invalid proof deadline: ${timeoutMs}`));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<T>;
  try {
    running = operation();
  } catch (error) {
    return Promise.reject(error);
  }
  // A late failure after the deadline won must not surface as unhandled.
  void running.catch(() => undefined);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ProofDeadlineError(proofServerOrigin(opts.proofServerUrl), timeoutMs)),
      timeoutMs,
    );
  });
  return Promise.race([running, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * The same service with a deadline on every `prove` call. For the wallet
 * facade's `provingService` factory: on a timeout the facade's own failure
 * path runs, so the coins the transaction booked are released.
 */
export function withProvingDeadline<S extends { readonly prove: (...args: any[]) => Promise<unknown> }>(
  service: S,
  opts: ProofDeadlineOptions,
): S {
  return {
    ...service,
    prove: (...args: Parameters<S["prove"]>) => withProofDeadline(() => service.prove(...args), opts),
  } as S;
}
