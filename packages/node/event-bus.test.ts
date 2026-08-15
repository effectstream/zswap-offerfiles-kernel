import { expect, test } from "bun:test";

import {
  deliverCommittedAppEvent,
  eventBus,
  parseStateMachineAppEvent,
  queueAppEvent,
  startPostCommitEventBridge,
} from "./event-bus.ts";

test("state-machine lifecycle events are queued through data.emit, not delivered locally", () => {
  const queued: Array<{ topic: unknown; payload: unknown }> = [];
  const delivered: unknown[] = [];
  const listener = (event: unknown) => delivered.push(event);
  eventBus.on("app_event", listener);
  try {
    queueAppEvent(
      { emit: (topic, payload) => queued.push({ topic, payload }) },
      { type: "offer_expired", offerId: 7, offerHash: "a".repeat(64) },
    );
    expect(queued.length).toBe(1);
    expect(queued[0].payload).toEqual({
      eventJson: JSON.stringify({
        type: "offer_expired",
        offerId: 7,
        offerHash: "a".repeat(64),
      }),
    });
    // The runtime owns post-COMMIT publication and has not delivered the event.
    expect(delivered).toEqual([]);
  } finally {
    eventBus.off("app_event", listener);
  }
});

test("post-commit bridge parser rejects malformed or unknown lifecycle envelopes", () => {
  expect(parseStateMachineAppEvent({ type: "offer_expired", offerId: 7 })).toEqual({
    type: "offer_expired",
    offerId: 7,
  });
  expect(parseStateMachineAppEvent({ type: "offer_indexed", offerId: "7" })).toBeNull();
  expect(parseStateMachineAppEvent({
    type: "offer_indexed",
    offerId: 7,
    offerHash: "not-a-hash",
    gives: [],
    wants: [],
  })).toBeNull();
  expect(parseStateMachineAppEvent({ type: "made_up" })).toBeNull();
});

test("consumption events require exactly one spend discriminator", () => {
  const base = { type: "offer_consumed", offerId: 7 };
  const unshieldedSpend = { owner: "owner", intentHash: "intent", outputNo: 0 };

  expect(parseStateMachineAppEvent(base)).toBeNull();
  expect(parseStateMachineAppEvent({ ...base, nullifier: "nullifier" })).toEqual({
    ...base,
    nullifier: "nullifier",
  });
  expect(parseStateMachineAppEvent({ ...base, unshieldedSpend })).toEqual({
    ...base,
    unshieldedSpend,
  });
  expect(parseStateMachineAppEvent({
    ...base,
    nullifier: "nullifier",
    unshieldedSpend,
  })).toBeNull();
});

test("committed bridge adds runtime blockHeight where the public event contract requires it", () => {
  const delivered: unknown[] = [];
  const listener = (event: unknown) => delivered.push(event);
  eventBus.on("app_event", listener);
  try {
    deliverCommittedAppEvent(
      {
        type: "offer_indexed",
        offerId: 8,
        offerHash: "b".repeat(64),
        gives: [],
        wants: [],
      },
      123,
    );
    expect(delivered).toEqual([{
      type: "offer_indexed",
      offerId: 8,
      offerHash: "b".repeat(64),
      gives: [],
      wants: [],
      blockHeight: 123,
    }]);
  } finally {
    eventBus.off("app_event", listener);
  }
});

test("post-commit bridge close unsubscribes once and tolerates broker-disabled noop", async () => {
  const subscription = Symbol("live");
  let unsubscribes = 0;
  const liveManager = {
    symbolToSubscription: {
      [subscription]: { broker: "engine", topic: "topic" },
    },
    subscribe: async () => subscription,
    unsubscribe: async (value: symbol) => {
      unsubscribes += 1;
      delete (liveManager.symbolToSubscription as Record<symbol, unknown>)[value];
    },
  };
  const stop = await startPostCommitEventBridge(liveManager as any);
  await stop();
  await stop();
  expect(unsubscribes).toBe(1);

  const noopManager = {
    symbolToSubscription: {} as Record<symbol, unknown>,
    subscribe: async () => Symbol("noop"),
    unsubscribe: async () => { throw new Error("must not be called"); },
  };
  const stopNoop = await startPostCommitEventBridge(noopManager as any);
  await expect(stopNoop()).resolves.toBeUndefined();
});
