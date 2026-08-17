import { expect, test } from "bun:test";

import {
  OFFER_VALIDATION_PROFILE,
  OFFER_VALIDATION_SCHEMA_VERSION,
  type OfferValidationVerdict,
} from "@zswap-da/solver-core/validation-contract";

import { Book, type BookOffer } from "./src/book.ts";
import {
  OfferValidationRejectedError,
  startValidationGate,
  type ValidationAvailabilityState,
  type ValidationGateTrace,
} from "./src/validation-gate.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const N1 = "1".repeat(64);
const N2 = "2".repeat(64);
const NOW = Date.parse("2026-08-14T12:00:00.000Z");
const EXPIRES = new Date(NOW + 10 * 60_000).toISOString();

const offer = (hash: string, nullifier = N1): BookOffer => ({
  offerHash: hash,
  gives: [{ token: B, amount: 10n, kind: "SHIELDED" }],
  wants: [{ token: C, amount: 9n, kind: "SHIELDED" }],
  expiresAt: Date.parse(EXPIRES),
  firstSeenAt: NOW - 1_000,
  inputNullifiers: [nullifier],
});

const detail = (value: BookOffer) => ({
  version: 1 as const,
  offerId: value.offerHash,
  offerBech32: `blob-${value.offerHash}`,
  computed: {
    gives: value.gives.map((leg) => ({
      token: leg.token,
      amount: leg.amount.toString(),
      type: leg.kind,
    })),
    wants: value.wants.map((leg) => ({
      token: leg.token,
      amount: leg.amount.toString(),
      type: leg.kind,
    })),
    expiresAt: new Date(value.expiresAt!).toISOString(),
    firstSeenAt: new Date(value.firstSeenAt!).toISOString(),
    inputNullifiers: [...value.inputNullifiers],
    status: "live",
  },
});

const validVerdict = (value: BookOffer, stateVersion = "7"): OfferValidationVerdict => ({
  schemaVersion: OFFER_VALIDATION_SCHEMA_VERSION,
  profile: OFFER_VALIDATION_PROFILE,
  valid: true,
  live: true,
  claimedOfferId: value.offerHash,
  computedOfferId: value.offerHash,
  stateVersion,
  validatedAt: new Date(NOW - 60_000).toISOString(),
  status: "live",
  code: "VALID",
  computed: {
    gives: value.gives.map((leg) => ({
      token: leg.token,
      amount: leg.amount.toString(),
      kind: leg.kind,
    })),
    wants: value.wants.map((leg) => ({
      token: leg.token,
      amount: leg.amount.toString(),
      kind: leg.kind,
    })),
    inputNullifiers: [...value.inputNullifiers],
    expiresAt: new Date(value.expiresAt!).toISOString(),
  },
});

const waitUntil = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

test("a generation drain serializes validate-for-use and admits only verdict-derived offers", async () => {
  const rawBook = new Book();
  const first = offer(A, N1);
  const second = offer("d".repeat(64), N2);
  rawBook.upsert(first);
  rawBook.upsert(second);
  let inFlight = 0;
  let maximumInFlight = 0;
  const calls: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const states: ValidationAvailabilityState[] = [];
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
    retryIntervalMs: 5,
    dependencies: {
      getZswapByHash: async (hash) => detail(rawBook.get(hash)!),
      validateOfferForUse: async (hash) => {
        calls.push(hash);
        inFlight++;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        if (calls.length === 1) await held;
        inFlight--;
        return validVerdict(rawBook.get(hash)!, "7");
      },
    },
    onAvailabilityChange: (state) => states.push(state),
  });

  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  await waitUntil(() => calls.length === 1, "first validation request");
  expect(calls).toEqual([A]);
  expect(gate.book.size).toBe(0);
  expect(gate.availability().kind).toBe("blocked");
  release();
  await gate.idle();

  expect(maximumInFlight).toBe(1);
  expect(calls).toEqual([A, second.offerHash]);
  expect(gate.book.hashes()).toEqual([A, second.offerHash]);
  expect(gate.book.get(A)!.validation).toMatchObject({
    streamGeneration: 1,
    backendBlockL2: "7",
    stateVersion: "7",
    blobHash: A,
  });
  expect(gate.book.get(A)!.validation.computed.gives[0].amount).toBe("10");
  expect(states.at(-1)).toMatchObject({ kind: "ready", streamGeneration: 1 });
  await gate.stop();
});

test("a mutating trace observer receives only detached deep-frozen authority snapshots", async () => {
  const rawBook = new Book();
  const candidate = offer(A);
  rawBook.upsert(candidate);
  const events: ValidationGateTrace[] = [];
  let allEventsFrozen = true;
  let allGenerationsFrozen = true;
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
    dependencies: {
      getZswapByHash: async () => detail(candidate),
      validateOfferForUse: async () => validVerdict(candidate, "7"),
    },
    onTrace: (event) => {
      events.push(event);
      allEventsFrozen &&= Object.isFrozen(event);
      try { (event as any).kind = "unavailable"; } catch { /* expected */ }
      if ("generation" in event) {
        allGenerationsFrozen &&= Object.isFrozen(event.generation);
        try { (event.generation as any).streamGeneration = 999; } catch { /* expected */ }
        try { (event.generation as any).backendBlockL2 = "999"; } catch { /* expected */ }
      }
    },
  });

  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  await gate.idle();
  const admitted = gate.book.get(A)!;
  const executed = await gate.revalidateForExecution(admitted);

  expect(allEventsFrozen).toBe(true);
  expect(allGenerationsFrozen).toBe(true);
  expect(gate.currentGeneration()).toEqual({ streamGeneration: 1, backendBlockL2: "7" });
  expect(gate.availability()).toEqual({
    kind: "ready",
    streamGeneration: 1,
    backendBlockL2: "7",
  });
  expect(executed.validation).toMatchObject({
    streamGeneration: 1,
    backendBlockL2: "7",
    stateVersion: "7",
  });
  expect(events.map((event) => event.kind)).toEqual([
    "unavailable",
    "drain-start",
    "verdict",
    "admitted",
    "execution-start",
    "verdict",
    "execution-valid",
  ]);
  for (const event of events) {
    if ("generation" in event) {
      expect(event.generation).toEqual({ streamGeneration: 1, backendBlockL2: "7" });
    }
  }
  await gate.stop();
});

test("an HTTP-200 invalid verdict rejects only that offer and proves validation reachable", async () => {
  const rawBook = new Book();
  const candidate = offer(A);
  rawBook.upsert(candidate);
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
    dependencies: {
      getZswapByHash: async () => detail(candidate),
      validateOfferForUse: async () => ({
        ...validVerdict(candidate),
        valid: false,
        live: false,
        status: "consumed",
        code: "NOT_LIVE",
        computedOfferId: null,
        computed: undefined,
      }),
    },
  });
  gate.beginGeneration({ streamGeneration: 2, backendBlockL2: "7" });
  await gate.idle();
  expect(gate.availability()).toMatchObject({ kind: "ready", streamGeneration: 2 });
  expect(gate.book.size).toBe(0);
  await gate.stop();
});

test("transport failure globally withdraws previously validated capacity", async () => {
  const rawBook = new Book();
  const candidate = offer(A);
  rawBook.upsert(candidate);
  let fail = false;
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
    retryIntervalMs: 50,
    dependencies: {
      getZswapByHash: async () => detail(candidate),
      validateOfferForUse: async () => {
        if (fail) throw new Error("503 validator busy");
        return validVerdict(candidate);
      },
    },
  });
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  await gate.idle();
  expect(gate.book.size).toBe(1);

  fail = true;
  gate.rawBookChanged();
  await gate.idle();
  expect(gate.book.size).toBe(0);
  expect(gate.availability()).toMatchObject({ kind: "blocked" });
  await gate.stop();
});

test("a superseded drain never dispatches queued old-generation validations", async () => {
  const rawBook = new Book();
  const first = offer(A, N1);
  const second = offer("d".repeat(64), N2);
  rawBook.upsert(first);
  rawBook.upsert(second);
  const calls: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
    dependencies: {
      getZswapByHash: async (hash) => detail(rawBook.get(hash)!),
      validateOfferForUse: async (hash) => {
        calls.push(hash);
        if (calls.length === 1) await held;
        return validVerdict(rawBook.get(hash)!, "9");
      },
    },
  });
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  await waitUntil(() => calls.length === 1, "held old-generation validation");
  gate.beginGeneration({ streamGeneration: 2, backendBlockL2: "9" });
  release();
  await gate.idle();

  // Old generation dispatched only A. The complete A,B pair after it belongs
  // to generation 2; B was never sent with superseded authority.
  expect(calls).toEqual([A, A, second.offerHash]);
  expect(gate.book.get(A)!.validation.streamGeneration).toBe(2);
  expect(gate.book.get(second.offerHash)!.validation.streamGeneration).toBe(2);
  await gate.stop();
});

test("a disconnected or new stream epoch clears old positives and refuses their evidence", async () => {
  const rawBook = new Book();
  const candidate = offer(A);
  rawBook.upsert(candidate);
  let endpointHeight = "7";
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
    dependencies: {
      getZswapByHash: async () => detail(candidate),
      validateOfferForUse: async () => validVerdict(candidate, endpointHeight),
    },
  });
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  await gate.idle();
  const oldEvidence = gate.book.get(A)!.validation;
  expect(gate.isEvidenceCurrent(oldEvidence)).toBe(true);

  gate.invalidate("stream disconnected");
  expect(gate.book.size).toBe(0);
  expect(gate.isEvidenceCurrent(oldEvidence)).toBe(false);

  endpointHeight = "9";
  gate.beginGeneration({ streamGeneration: 2, backendBlockL2: "9" });
  expect(gate.book.size).toBe(0);
  expect(gate.isEvidenceCurrent(oldEvidence)).toBe(false);
  await gate.idle();
  expect(gate.book.get(A)!.validation.streamGeneration).toBe(2);
  expect(gate.isEvidenceCurrent(oldEvidence)).toBe(false);
  await gate.stop();
});

test("same-stream height churn makes forward progress across a serialized multi-offer backlog", async () => {
  const rawBook = new Book();
  const first = offer(A, N1);
  const second = offer("d".repeat(64), N2);
  rawBook.upsert(first);
  rawBook.upsert(second);

  const calls: string[] = [];
  const releases: Array<() => void> = [];
  let responseHeight = "7";
  const states: ValidationAvailabilityState[] = [];
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
    dependencies: {
      getZswapByHash: async (hash) => detail(rawBook.get(hash)!),
      validateOfferForUse: async (hash) => {
        calls.push(hash);
        await new Promise<void>((resolve) => releases.push(resolve));
        return validVerdict(rawBook.get(hash)!, responseHeight);
      },
    },
    onAvailabilityChange: (state) => states.push(state),
  });

  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  await waitUntil(() => calls.length === 1, "L2-7 validation");
  responseHeight = "8";
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "8" });
  releases.shift()!();
  await waitUntil(() => calls.length === 2, "second validation after L2-8 advance");

  responseHeight = "9";
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "9" });
  releases.shift()!();
  await gate.idle();

  // The monotonic height floor advances without restarting A or discarding its
  // point-in-time positive. B completes against the newer floor, and dequeue
  // (not admission) will refresh A before any external mutation.
  expect(calls).toEqual([A, second.offerHash]);
  expect(gate.availability()).toMatchObject({ kind: "ready", backendBlockL2: "9" });
  expect(gate.book.size).toBe(2);
  expect(gate.book.get(A)!.validation.stateVersion).toBe("8");
  expect(gate.isEvidenceCurrent(gate.book.get(A)!.validation)).toBe(true);
  expect(gate.isExecutionEvidenceCurrent(gate.book.get(A)!.validation)).toBe(false);
  expect(states.filter((state) => state.kind === "ready")).toHaveLength(1);

  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "10" });
  expect(gate.book.size).toBe(2);
  expect(calls).toHaveLength(2);
  await gate.stop();
});

test("a verdict below a newer same-stream health floor is refused", async () => {
  const rawBook = new Book();
  const candidate = offer(A);
  rawBook.upsert(candidate);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
    retryIntervalMs: 50,
    dependencies: {
      getZswapByHash: async () => detail(candidate),
      validateOfferForUse: async () => {
        await held;
        return validVerdict(candidate, "8");
      },
    },
  });
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  await Promise.resolve();
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "9" });
  release();
  await gate.idle();
  expect(gate.book.size).toBe(0);
  expect(gate.availability()).toMatchObject({ kind: "blocked", backendBlockL2: "9" });
  await gate.stop();
});

test("a cached real offer can probe and recover validation while the raw book is empty", async () => {
  const rawBook = new Book();
  const candidate = offer(A);
  rawBook.upsert(candidate);
  let calls = 0;
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
    retryIntervalMs: 5,
    dependencies: {
      getZswapByHash: async () => detail(candidate),
      validateOfferForUse: async () => {
        calls++;
        if (calls === 2) throw new Error("network unavailable");
        return calls === 1
          ? validVerdict(candidate)
          : {
              ...validVerdict(candidate),
              valid: false,
              live: false,
              status: "consumed",
              code: "NOT_LIVE",
              computedOfferId: null,
              computed: undefined,
            };
      },
    },
  });
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  await gate.idle();
  rawBook.remove(A);
  gate.rawBookChanged(A);
  // A known lifecycle removal is local and keeps the route ready. An unknown
  // raw-generation invalidation forces a global capability recheck, which can
  // truthfully use the previously observed exact blob while the book is empty.
  gate.rawBookChanged();
  await gate.idle();
  expect(gate.availability().kind).toBe("blocked");
  await waitUntil(() => gate.availability().kind === "ready", "empty-book capability recovery");
  expect(calls).toBe(3);
  expect(gate.book.size).toBe(0);
  await gate.stop();
});

test("execution revalidation rejects a domain negative without making the route unavailable", async () => {
  const rawBook = new Book();
  const candidate = offer(A);
  rawBook.upsert(candidate);
  let negative = false;
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
    dependencies: {
      getZswapByHash: async () => detail(candidate),
      validateOfferForUse: async () => negative
        ? {
            ...validVerdict(candidate),
            valid: false,
            live: false,
            status: "consumed",
            code: "NOT_LIVE",
            computedOfferId: null,
            computed: undefined,
          }
        : validVerdict(candidate),
    },
  });
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  await gate.idle();
  const admitted = gate.book.get(A)!;
  negative = true;
  await expect(gate.revalidateForExecution(admitted)).rejects.toBeInstanceOf(
    OfferValidationRejectedError,
  );
  expect(gate.availability().kind).toBe("ready");
  expect(gate.book.size).toBe(0);
  await gate.stop();
});

test("initially empty raw books remain honestly blocked without a capability route", async () => {
  const gate = startValidationGate({
    rawBook: new Book(),
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
  });
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  await gate.idle();
  expect(gate.availability()).toMatchObject({
    kind: "blocked",
    reason: "validation capability is unproven for an initially empty raw book",
  });
  await gate.stop();
});

for (const stateVersion of ["6"]) {
  test(`state version ${stateVersion} cannot authorize an active L2-7 snapshot`, async () => {
    const rawBook = new Book();
    const candidate = offer(A);
    rawBook.upsert(candidate);
    const gate = startValidationGate({
      rawBook,
      authToken: "v".repeat(16),
      expiryMarginSeconds: 120,
      nowMs: () => NOW,
      retryIntervalMs: 50,
      dependencies: {
        getZswapByHash: async () => detail(candidate),
        validateOfferForUse: async () => validVerdict(candidate, stateVersion),
      },
    });
    gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
    await gate.idle();
    expect(gate.availability()).toMatchObject({ kind: "blocked" });
    expect(gate.book.size).toBe(0);
    await gate.stop();
  });
}

test("a verdict ahead of the current health floor is admissible in the same stream epoch", async () => {
  const rawBook = new Book();
  const candidate = offer(A);
  rawBook.upsert(candidate);
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
    dependencies: {
      getZswapByHash: async () => detail(candidate),
      validateOfferForUse: async () => validVerdict(candidate, "8"),
    },
  });
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  await gate.idle();
  expect(gate.availability()).toMatchObject({ kind: "ready", backendBlockL2: "7" });
  expect(gate.book.get(A)!.validation.stateVersion).toBe("8");
  await gate.stop();
});

test("background and concurrent dequeue checks share one physical validation queue", async () => {
  const rawBook = new Book();
  const candidate = offer(A);
  rawBook.upsert(candidate);
  let inFlight = 0;
  let maximumInFlight = 0;
  let calls = 0;
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const sawHeld = new Promise<void>((resolve) => { started = resolve; });
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
    dependencies: {
      getZswapByHash: async () => detail(candidate),
      validateOfferForUse: async () => {
        calls++;
        inFlight++;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        if (calls === 2) {
          started();
          await held;
        }
        inFlight--;
        return validVerdict(candidate);
      },
    },
  });
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  await gate.idle();
  const admitted = gate.book.get(A)!;
  const first = gate.revalidateForExecution(admitted);
  await sawHeld;
  const second = gate.revalidateForExecution(admitted);
  await Promise.resolve();
  expect(calls).toBe(2);
  expect(maximumInFlight).toBe(1);
  release();
  await Promise.all([first, second]);
  expect(calls).toBe(3);
  expect(maximumInFlight).toBe(1);
  await gate.stop();
});

test("an already-aborted queued caller never dispatches validation", async () => {
  const rawBook = new Book();
  const candidate = offer(A);
  rawBook.upsert(candidate);
  let calls = 0;
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const sawHeld = new Promise<void>((resolve) => { started = resolve; });
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
    dependencies: {
      getZswapByHash: async (hash) => detail(rawBook.get(hash)!),
      validateOfferForUse: async (hash) => {
        calls++;
        if (calls === 2) {
          started();
          await held;
        }
        return validVerdict(rawBook.get(hash) ?? candidate);
      },
    },
  });
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  await gate.idle();
  const admitted = gate.book.get(A)!;
  const first = gate.revalidateForExecution(admitted);
  await sawHeld;
  const aborted = new AbortController();
  aborted.abort(new Error("caller stopped"));
  const second = gate.revalidateForExecution(admitted, aborted.signal).catch((error) => error);
  release();
  await first;
  expect(await second).toBeInstanceOf(Error);
  expect(calls).toBe(2);
  await gate.stop();
});

test("removed in-flight work is superseded and high churn retains only current metadata", async () => {
  const rawBook = new Book();
  const candidate = offer(A);
  rawBook.upsert(candidate);
  let calls = 0;
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const sawHeld = new Promise<void>((resolve) => { started = resolve; });
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
    dependencies: {
      getZswapByHash: async () => detail(candidate),
      validateOfferForUse: async () => {
        calls++;
        if (calls === 2) {
          started();
          await held;
        }
        return validVerdict(candidate);
      },
    },
  });
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  await gate.idle();

  gate.rawBookChanged(A);
  await sawHeld;
  rawBook.remove(A);
  gate.rawBookChanged(A);
  expect(gate.metadataCounts().rawRevisions).toBe(0);
  release();
  await gate.idle();
  expect(gate.book.size).toBe(0);
  expect(calls).toBe(2);

  for (let index = 0; index < 1_000; index++) {
    rawBook.upsert(candidate);
    gate.rawBookChanged(A);
    rawBook.remove(A);
    gate.rawBookChanged(A);
  }
  rawBook.upsert(candidate);
  gate.rawBookChanged(A);
  await gate.idle();
  expect(gate.book.size).toBe(1);
  expect(calls).toBe(3);
  expect(gate.metadataCounts()).toEqual({
    rawRevisions: 1,
    pendingOffers: 0,
    queuedTickets: 0,
    cachedProbes: 1,
  });

  rawBook.remove(A);
  gate.rawBookChanged(A);
  for (let index = 0; index < 500; index++) {
    const unique = offer((10_000 + index).toString(16).padStart(64, "0"));
    rawBook.upsert(unique);
    gate.rawBookChanged(unique.offerHash);
    await gate.idle();
    rawBook.remove(unique.offerHash);
    gate.rawBookChanged(unique.offerHash);
  }
  await gate.idle();
  expect(calls).toBe(503);
  expect(gate.metadataCounts()).toEqual({
    rawRevisions: 0,
    pendingOffers: 0,
    queuedTickets: 0,
    cachedProbes: 1,
  });
  await gate.stop();
});

test("a large synthetic initial drain validates each sorted offer once with bounded tickets", async () => {
  const rawBook = new Book();
  const offers = Array.from({ length: 1_000 }, (_, index) =>
    offer(index.toString(16).padStart(64, "0"))
  );
  for (const candidate of [...offers].reverse()) rawBook.upsert(candidate);
  const calls: string[] = [];
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    maxPendingOffers: 1_000,
    nowMs: () => NOW,
    dependencies: {
      getZswapByHash: async (hash) => detail(rawBook.get(hash)!),
      validateOfferForUse: async (hash) => {
        calls.push(hash);
        return validVerdict(rawBook.get(hash)!);
      },
    },
  });
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  expect(gate.metadataCounts().queuedTickets).toBeLessThanOrEqual(1_000);
  expect(gate.metadataCounts().queuedTickets).toBeGreaterThan(0);
  await gate.idle();
  expect(calls).toEqual(offers.map((candidate) => candidate.offerHash).sort());
  expect(gate.book.size).toBe(1_000);
  expect(gate.metadataCounts()).toEqual({
    rawRevisions: 1_000,
    pendingOffers: 0,
    queuedTickets: 0,
    cachedProbes: 1,
  });
  await gate.stop();
});

test("stop aborts and joins an active dequeue validation through the composed signal", async () => {
  const rawBook = new Book();
  const candidate = offer(A);
  rawBook.upsert(candidate);
  let stopMode = false;
  let started!: () => void;
  const sawStarted = new Promise<void>((resolve) => { started = resolve; });
  const gate = startValidationGate({
    rawBook,
    authToken: "v".repeat(16),
    expiryMarginSeconds: 120,
    nowMs: () => NOW,
    dependencies: {
      getZswapByHash: async () => detail(candidate),
      validateOfferForUse: async (_hash, _blob, options) => {
        if (!stopMode) return validVerdict(candidate);
        started();
        return await new Promise<OfferValidationVerdict>((_resolve, reject) => {
          const fail = () => reject(options.signal?.reason ?? new Error("aborted"));
          if (options.signal?.aborted) fail();
          else options.signal?.addEventListener("abort", fail, { once: true });
        });
      },
    },
  });
  gate.beginGeneration({ streamGeneration: 1, backendBlockL2: "7" });
  await gate.idle();
  stopMode = true;
  const revalidation = gate.revalidateForExecution(gate.book.get(A)!).catch((error) => error);
  await sawStarted;
  await gate.stop();
  expect(await revalidation).toBeInstanceOf(Error);
  expect(gate.availability()).toMatchObject({ kind: "blocked" });
});
