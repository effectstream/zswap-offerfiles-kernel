import { getEnv } from "@effectstream/utils/runtime";

import { BATCHER_SUBMIT_URL } from "./env.ts";

const CELESTIA_TARGET = "celestia";
// AddressType.NONE — Celestia submissions have no user signer.
const ADDRESS_TYPE_NONE = -1;
const DEFAULT_TIMEOUT_MS = 310_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

export interface CelestiaSubmitResult {
  txhash: string;
  // wait-receipt confirms chain inclusion but does not carry the optional
  // Effectstream rollup height. Preserve this field for the existing API
  // response contract and leave it empty rather than fabricating a height.
  height: string;
}

export interface SubmitBlobOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function batcherSubmitTimeoutMs(): number {
  const raw = getEnv("BATCHER_SUBMIT_TIMEOUT_MS") ?? String(DEFAULT_TIMEOUT_MS);
  if (!/^[1-9][0-9]*$/.test(raw)) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= MIN_TIMEOUT_MS && parsed <= MAX_TIMEOUT_MS
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

/**
 * Validate the pinned @effectstream/batcher-sdk 0.103.1 `wait-receipt`
 * response. The SDK guarantees success/message/inputsProcessed and forwards
 * the Celestia adapter's generic `BlockchainHash` as transactionHash.
 *
 * Celestia's adapter does NOT guarantee a 32-byte hex tx hash: older/light RPC
 * shapes can produce the SDK's `celestia-h<height>` fallback. Therefore this
 * boundary enforces a bounded printable identifier, not an EVM-only hash.
 */
export function parseCelestiaWaitReceipt(value: unknown): CelestiaSubmitResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.success !== true || body.inputsProcessed !== 1 ||
      typeof body.message !== "string" || body.message.length === 0 ||
      typeof body.transactionHash !== "string") return null;
  const txhash = body.transactionHash;
  if (txhash.length === 0 || txhash.length > 256 || /[^\x21-\x7e]/.test(txhash)) return null;
  return { txhash, height: "" };
}

async function fetchAndReadWithDeadline(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ resp: Response; raw: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = (async () => {
    const resp = await fetchImpl(url, { ...init, signal: controller.signal });
    // The same absolute deadline covers body consumption. A server can return
    // headers promptly and then stall forever while streaming the receipt.
    const raw = await resp.text();
    return { resp, raw };
  })();
  // Promise.race retains a rejection handler on the losing promise, but keep an
  // explicit observer as well: a fetch implementation may reject only after
  // the deadline aborts and must never surface an unhandled rejection.
  void operation.catch(() => undefined);

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`batcher request timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Also abort after success/failure so a custom fetch cannot retain work
    // beyond this call's lifetime.
    if (!controller.signal.aborted) controller.abort();
  }
}

export async function submitBlobViaBatcher(
  blob: string,
  options: SubmitBlobOptions = {},
): Promise<CelestiaSubmitResult> {
  const timeoutMs = options.timeoutMs ?? batcherSubmitTimeoutMs();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`invalid batcher submit timeout: ${timeoutMs}`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = {
    data: {
      address: "celestia",
      addressType: ADDRESS_TYPE_NONE,
      input: blob,
      signature: "",
      timestamp: String(Date.now()),
      target: CELESTIA_TARGET,
    },
    confirmationLevel: "wait-receipt",
    // Bound receipt confirmation server-side too. The slightly larger fetch
    // deadline covers response serialization while still bounding the body.
    timeoutMs: Math.max(MIN_TIMEOUT_MS, timeoutMs - 1_000),
  };

  let resp: Response;
  let raw: string;
  try {
    ({ resp, raw } = await fetchAndReadWithDeadline(fetchImpl, `${BATCHER_SUBMIT_URL}/send-input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, timeoutMs));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to submit blob to Celestia via batcher: ${reason}`);
  }

  let json: unknown = null;
  try {
    if (raw !== "") json = JSON.parse(raw);
  } catch {
    // Malformed or non-JSON content is not a receipt acknowledgement.
  }
  const receipt = parseCelestiaWaitReceipt(json);
  if (!resp.ok || receipt === null) {
    const record = typeof json === "object" && json !== null
      ? json as Record<string, unknown>
      : null;
    const reason = typeof record?.error === "string"
      ? record.error
      : typeof record?.message === "string"
        ? record.message
        : !resp.ok
          ? `HTTP ${resp.status}`
          : "malformed wait-receipt acknowledgement";
    throw new Error(`Failed to submit blob to Celestia via batcher: ${reason}`);
  }

  return receipt;
}
