import { EventEmitter } from "node:events";

export type AppEvent =
  | { type: "offer_indexed"; offerId: number; offerHash: string; blockHeight: number | string; gives: unknown[]; wants: unknown[] }
  // `offerId` is the local SERIAL row id, which diverges across deployments;
  // `offerHash` is the content address the REST API exposes, and the only key a
  // consumer can correlate an event with. It is absent for rows inserted
  // out-of-band without a hash (see migration 005).
  | {
      type: "offer_consumed";
      offerId: number;
      offerHash?: string;
      nullifier?: string;
      unshieldedSpend?: { owner: string; intentHash: string; outputNo: number };
    }
  | { type: "offer_expired"; offerId: number; offerHash?: string }
  | { type: "token_minted"; name: string; color: string; kind?: string }
  | {
      type: "offer_rejected";
      code?: string;
      reason?: string;
      offerHash?: string;
      blockHeight: number | string;
    };

export const eventBus = new EventEmitter();
eventBus.setMaxListeners(50);

export function emitAppEvent(event: AppEvent): void {
  eventBus.emit("app_event", event);
}
