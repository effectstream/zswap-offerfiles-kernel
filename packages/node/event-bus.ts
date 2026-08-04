import { EventEmitter } from "node:events";

export type AppEvent =
  | { type: "offer_indexed"; offerId: number; offerHash: string; blockHeight: number | string; gives: unknown[]; wants: unknown[] }
  | {
      type: "offer_consumed";
      offerId: number;
      nullifier?: string;
      unshieldedSpend?: { owner: string; intentHash: string; outputNo: number };
    }
  | { type: "offer_expired"; offerId: number }
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
