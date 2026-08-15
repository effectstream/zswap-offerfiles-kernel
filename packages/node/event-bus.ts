import { EventEmitter } from "node:events";
import { EventManager } from "@effectstream/event-client";

import { ZswapAppEvents } from "./app-events.ts";

export type StateMachineAppEvent =
  | { type: "offer_indexed"; offerId: number; offerHash: string; gives: unknown[]; wants: unknown[] }
  | {
      type: "offer_consumed";
      offerId: number;
      offerHash?: string;
      nullifier?: string;
      unshieldedSpend?: { owner: string; intentHash: string; outputNo: number };
    }
  | { type: "offer_expired"; offerId: number; offerHash?: string }
  | {
      type: "offer_rejected";
      code?: string;
      reason?: string;
      offerHash?: string;
    };

export type AppEvent =
  | (Extract<StateMachineAppEvent, { type: "offer_indexed" }> & { blockHeight: number | string })
  | Extract<StateMachineAppEvent, { type: "offer_consumed" }>
  | Extract<StateMachineAppEvent, { type: "offer_expired" }>
  | { type: "token_minted"; name: string; color: string; kind?: string }
  | (Extract<StateMachineAppEvent, { type: "offer_rejected" }> & { blockHeight: number | string });

export const eventBus = new EventEmitter();
eventBus.setMaxListeners(50);

/** Local delivery only. State-machine code must use queueAppEvent so lifecycle
 * notifications are not observable before the enclosing block COMMIT. */
export function emitAppEvent(event: AppEvent): void {
  eventBus.emit("app_event", event);
}

/** Buffer an event in Effectstream's per-input event buffer. The runtime
 * publishes it only after block COMMIT and drops it when the input fails. SQL
 * rollback for JavaScript failures is owned by withAppInputSavepoint. */
export function queueAppEvent(
  data: { emit: (topic: any, payload: any) => void },
  event: StateMachineAppEvent,
): void {
  data.emit(ZswapAppEvents.Lifecycle, { eventJson: JSON.stringify(event) });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isOfferId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === "string";
const isOfferHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const optionalOfferHash = (value: unknown): boolean =>
  value === undefined || isOfferHash(value);

/** Reject malformed/injected broker payloads before they reach the SSE bus. */
export function parseStateMachineAppEvent(value: unknown): StateMachineAppEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "offer_indexed":
      return isOfferId(value.offerId) &&
          isOfferHash(value.offerHash) &&
          Array.isArray(value.gives) && Array.isArray(value.wants)
        ? {
            type: "offer_indexed",
            offerId: value.offerId,
            offerHash: value.offerHash,
            gives: value.gives,
            wants: value.wants,
          }
        : null;
    case "offer_consumed": {
      if (!isOfferId(value.offerId) || !optionalOfferHash(value.offerHash) ||
          !optionalString(value.nullifier)) return null;
      const spend = value.unshieldedSpend;
      if (spend !== undefined &&
          (!isRecord(spend) || typeof spend.owner !== "string" ||
            typeof spend.intentHash !== "string" || !isOfferId(spend.outputNo))) return null;
      const hasNullifier = typeof value.nullifier === "string";
      const hasUnshieldedSpend = isRecord(spend);
      // Consumption has exactly one stable spend discriminator. Accepting
      // neither makes the event impossible to reconcile; accepting both makes
      // its identity ambiguous across the shielded and unshielded paths.
      if (hasNullifier === hasUnshieldedSpend) return null;
      return {
        type: "offer_consumed",
        offerId: value.offerId,
        ...(isOfferHash(value.offerHash) ? { offerHash: value.offerHash } : {}),
        ...(typeof value.nullifier === "string" ? { nullifier: value.nullifier } : {}),
        ...(isRecord(spend)
          ? {
              unshieldedSpend: {
                owner: spend.owner as string,
                intentHash: spend.intentHash as string,
                outputNo: spend.outputNo as number,
              },
            }
          : {}),
      };
    }
    case "offer_expired":
      return isOfferId(value.offerId) && optionalOfferHash(value.offerHash)
        ? {
            type: "offer_expired",
            offerId: value.offerId,
            ...(isOfferHash(value.offerHash) ? { offerHash: value.offerHash } : {}),
          }
        : null;
    case "offer_rejected":
      return optionalString(value.code) && optionalString(value.reason) &&
          optionalOfferHash(value.offerHash)
        ? {
            type: "offer_rejected",
            ...(typeof value.code === "string" ? { code: value.code } : {}),
            ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
            ...(isOfferHash(value.offerHash) ? { offerHash: value.offerHash } : {}),
          }
        : null;
    default:
      return null;
  }
}

/** Bridge a committed MQTT lifecycle payload into the process-local SSE bus.
 * Exported for a focused ordering test without opening a broker connection. */
export function deliverCommittedAppEvent(
  event: StateMachineAppEvent,
  blockHeight: number | string,
): void {
  if (event.type === "offer_indexed" || event.type === "offer_rejected") {
    emitAppEvent({ ...event, blockHeight });
    return;
  }
  emitAppEvent(event);
}

/** Subscribe this API process to the runtime's post-COMMIT event channel. */
export async function startPostCommitEventBridge(
  manager: Pick<EventManager, "subscribe" | "unsubscribe" | "symbolToSubscription"> =
    EventManager.Instance,
): Promise<() => Promise<void>> {
  const subscription = await manager.subscribe(
    {
      topic: ZswapAppEvents.Lifecycle,
      filter: { blockHeight: undefined },
    },
    (payload: any) => {
      const { eventJson, blockHeight } = payload as {
        eventJson: unknown;
        blockHeight: number | string;
      };
      const validBlockHeight =
        (typeof blockHeight === "number" && Number.isSafeInteger(blockHeight) && blockHeight >= 0) ||
        (typeof blockHeight === "string" && /^(?:0|[1-9][0-9]*)$/.test(blockHeight));
      if (typeof eventJson !== "string" || !validBlockHeight) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(eventJson);
      } catch {
        return;
      }
      const event = parseStateMachineAppEvent(decoded);
      if (event) deliverCommittedAppEvent(event, blockHeight);
    },
  );
  let stopped = false;
  return async () => {
    if (stopped) return;
    // event-client returns an unregistered `Symbol("noop")` when its broker is
    // disabled. Its unsubscribe currently destructures a missing map entry,
    // so recognize that documented no-client path here.
    if (!manager.symbolToSubscription[subscription]) {
      stopped = true;
      return;
    }
    await manager.unsubscribe(subscription);
    stopped = true;
  };
}
