// Generation-bound validate-for-use admission.
//
// The SSE/list mirror is deliberately untrusted input. Only this owner may
// copy an offer into `book`, and matching receives that validated projection.
// Validation is point-in-time rather than a reservation, so Executor asks this
// same owner to revalidate each member again at dequeue.

import {
  getZswapByHash,
  validateOfferForUse,
  type ApiZswapDetail,
  type OfferValidationVerdict,
} from "@zswap-da/solver-core/api-client";
import type { ValidatedOfferSemantics } from "@zswap-da/solver-core/validation-contract";

import { Book, bookOfferFromApi, type BookOffer } from "./book.ts";

export interface ValidationGeneration {
  streamGeneration: number;
  backendBlockL2: string;
}

export interface ValidationEvidence extends ValidationGeneration {
  offerHash: string;
  /** The content hash that was checked locally against the exact detail blob. */
  blobHash: string;
  projection: string;
  computed: Readonly<ValidatedOfferSemantics>;
  stateVersion: string;
  validatedAt: string;
  expiresAt: number;
}

export interface ValidatedBookOffer extends BookOffer {
  blob: string;
  validation: Readonly<ValidationEvidence>;
}

export type ValidationAvailabilityState =
  | ({ kind: "ready" } & ValidationGeneration)
  | ({ kind: "blocked"; reason: string } & Partial<ValidationGeneration>);

export type ValidationGateTrace =
  | { kind: "drain-start"; generation: ValidationGeneration; offers: number }
  | { kind: "verdict"; offerHash: string; valid: boolean; code: string }
  | { kind: "admitted"; offerHash: string; generation: ValidationGeneration }
  | { kind: "unavailable"; reason: string }
  | { kind: "execution-start"; offerHash: string; generation: ValidationGeneration }
  | { kind: "execution-valid"; offerHash: string; generation: ValidationGeneration };

export interface ValidationGateDependencies {
  getZswapByHash: typeof getZswapByHash;
  validateOfferForUse: typeof validateOfferForUse;
}

export interface ValidationGateOptions {
  rawBook: Book;
  authToken: string;
  api?: string;
  requestTimeoutMs?: number;
  expiryMarginSeconds: number;
  maxConcurrency?: number;
  maxPendingOffers?: number;
  retryIntervalMs?: number;
  nowMs?: () => number;
  dependencies?: Partial<ValidationGateDependencies>;
  onAvailabilityChange?: (state: ValidationAvailabilityState) => void;
  onValidatedBookChange?: () => void;
  onTrace?: (event: ValidationGateTrace) => void;
  onError?: (error: unknown) => void;
}

export interface ValidationGateHandle {
  readonly book: Book<ValidatedBookOffer>;
  beginGeneration: (generation: ValidationGeneration) => void;
  invalidate: (reason: string) => void;
  rawBookChanged: (offerHash?: string) => void;
  currentGeneration: () => ValidationGeneration | null;
  availability: () => ValidationAvailabilityState;
  /** Admission authority survives monotonic height advances in one continuously
   * connected SSE epoch. Projection/lifecycle changes still revoke it. */
  isEvidenceCurrent: (evidence: ValidationEvidence | undefined) => boolean;
  /** Stronger mutation boundary: the fresh dequeue verdict must cover the
   * latest health floor observed in the still-connected stream epoch. */
  isExecutionEvidenceCurrent: (evidence: ValidationEvidence | undefined) => boolean;
  revalidateForExecution: (
    offer: ValidatedBookOffer,
    signal?: AbortSignal,
  ) => Promise<ValidatedBookOffer>;
  /** Bounded-owner diagnostics used by churn tests and operational telemetry. */
  metadataCounts: () => {
    rawRevisions: number;
    pendingOffers: number;
    queuedTickets: number;
    cachedProbes: number;
  };
  idle: () => Promise<void>;
  stop: () => Promise<void>;
}

export class OfferValidationRejectedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OfferValidationRejectedError";
  }
}

export class OfferValidationUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "OfferValidationUnavailableError";
  }
}

class OfferValidationSupersededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferValidationSupersededError";
  }
}

const DEFAULT_DEPENDENCIES: ValidationGateDependencies = {
  getZswapByHash,
  validateOfferForUse,
};

const canonicalGeneration = (value: ValidationGeneration): ValidationGeneration => {
  if (!Number.isSafeInteger(value.streamGeneration) || value.streamGeneration <= 0) {
    throw new Error("validation stream generation must be a positive safe integer");
  }
  if (!/^[1-9][0-9]{0,19}$/.test(value.backendBlockL2) ||
    BigInt(value.backendBlockL2) > ((1n << 64n) - 1n)) {
    throw new Error("validation backend L2 must be a canonical positive u64");
  }
  return { ...value };
};

const projectionOf = (offer: BookOffer): string => JSON.stringify({
  offerHash: offer.offerHash.toLowerCase(),
  gives: offer.gives.map((leg) => [leg.kind, leg.token.toLowerCase(), leg.amount.toString()]).sort(),
  wants: offer.wants.map((leg) => [leg.kind, leg.token.toLowerCase(), leg.amount.toString()]).sort(),
  expiresAt: offer.expiresAt,
  inputNullifiers: [...offer.inputNullifiers].map((value) => value.toLowerCase()).sort(),
});

const sameProjection = (left: BookOffer, right: BookOffer): boolean =>
  projectionOf(left) === projectionOf(right);

const computedProjection = (verdict: OfferValidationVerdict): string | null => {
  if (verdict.computed === undefined) return null;
  return JSON.stringify({
    offerHash: verdict.claimedOfferId,
    gives: verdict.computed.gives
      .map((leg) => [leg.kind, leg.token, leg.amount])
      .sort(),
    wants: verdict.computed.wants
      .map((leg) => [leg.kind, leg.token, leg.amount])
      .sort(),
    expiresAt: Date.parse(verdict.computed.expiresAt),
    inputNullifiers: [...verdict.computed.inputNullifiers].sort(),
  });
};

const freezeEvidence = (value: ValidationEvidence): Readonly<ValidationEvidence> =>
  Object.freeze({ ...value });

const freezeOffer = (
  offer: BookOffer,
  blob: string,
  evidence: Readonly<ValidationEvidence>,
): ValidatedBookOffer => Object.freeze({
  ...offer,
  gives: Object.freeze(offer.gives.map((leg) => Object.freeze({ ...leg }))),
  wants: Object.freeze(offer.wants.map((leg) => Object.freeze({ ...leg }))),
  inputNullifiers: Object.freeze([...offer.inputNullifiers]),
  blob,
  validation: evidence,
}) as unknown as ValidatedBookOffer;

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function startValidationGate(opts: ValidationGateOptions): ValidationGateHandle {
  const requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
  const maxConcurrency = opts.maxConcurrency ?? 1;
  const maxPendingOffers = opts.maxPendingOffers ?? 10_000;
  const retryIntervalMs = opts.retryIntervalMs ?? 5_000;
  if (![requestTimeoutMs, maxConcurrency, maxPendingOffers, retryIntervalMs].every(
    (value) => Number.isSafeInteger(value) && value > 0,
  )) throw new Error("validation limits must be positive safe integers");
  // V2 deliberately admits one physical validation operation per solver
  // credential and may retain that slot beyond a caller's logical timeout.
  // A second in-flight request would self-induce HTTP 503 and a global outage.
  if (maxConcurrency !== 1) {
    throw new Error("validate-for-use concurrency must be exactly one per solver credential");
  }
  if (!Number.isFinite(opts.expiryMarginSeconds) || opts.expiryMarginSeconds < 0) {
    throw new Error("validation expiry margin must be a non-negative finite number");
  }

  const dependencies = { ...DEFAULT_DEPENDENCIES, ...opts.dependencies };
  const book = new Book<ValidatedBookOffer>();
  const owner = new AbortController();
  let cachedProbe: (BookOffer & { blob: string }) | null = null;
  const rawRevisions = new Map<string, number>();
  const pending = new Map<string, number>();
  let workQueue: Array<{ offerHash: string; revision: number }> = [];
  let workCursor = 0;
  let generation: ValidationGeneration | null = null;
  let highestFloor: bigint | null = null;
  let heightRegressionBlocked = false;
  let epoch = 0;
  let revisionClock = 0;
  let initializing = true;
  let routeProven = false;
  let drainRequested = false;
  let runner: Promise<void> | null = null;
  let validationTail: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  let state: ValidationAvailabilityState = { kind: "blocked", reason: "initializing" };

  const snapshotTrace = (event: ValidationGateTrace): ValidationGateTrace => {
    const detached = "generation" in event
      ? { ...event, generation: Object.freeze({ ...event.generation }) }
      : { ...event };
    return Object.freeze(detached) as ValidationGateTrace;
  };
  const trace = (event: ValidationGateTrace): void => {
    // Observability is deliberately non-authoritative. Never expose the live
    // generation/context object: a hostile or buggy diagnostic observer must
    // be unable to rewrite the gate's stream epoch or backend-height floor.
    try { opts.onTrace?.(snapshotTrace(event)); } catch { /* diagnostic only */ }
  };
  const report = (error: unknown): void => {
    try { opts.onError?.(error); } catch { /* diagnostic only */ }
  };
  const sameStream = (left: ValidationGeneration | null, right: ValidationGeneration): boolean =>
    left !== null && left.streamGeneration === right.streamGeneration;
  const publish = (next: ValidationAvailabilityState): void => {
    const changed = JSON.stringify(state) !== JSON.stringify(next);
    state = next;
    if (changed) {
      try { opts.onAvailabilityChange?.(next); } catch (error) { report(error); }
    }
  };
  const notifyBookChange = (): void => {
    try { opts.onValidatedBookChange?.(); } catch (error) { report(error); }
  };
  const removeValidated = (offerHash: string): void => {
    if (book.remove(offerHash)) notifyBookChange();
  };
  const clearValidated = (): void => {
    if (book.size === 0) return;
    for (const hash of book.hashes()) book.remove(hash);
    notifyBookChange();
  };
  const block = (why: string, context = generation): void => {
    clearValidated();
    publish({
      kind: "blocked",
      reason: why,
      ...(context ? context : {}),
    });
    trace({ kind: "unavailable", reason: why });
  };
  const bumpRevision = (offerHash: string): number => {
    const revision = ++revisionClock;
    rawRevisions.set(offerHash.toLowerCase(), revision);
    return revision;
  };
  const compactWorkQueue = (): void => {
    workQueue = [...pending.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([offerHash, revision]) => ({ offerHash, revision }));
    workCursor = 0;
  };
  const enqueueWork = (offerHash: string, revision: number): void => {
    workQueue.push({ offerHash, revision });
    // Coalesce stale lifecycle tickets. This keeps retained work O(current
    // book + a small constant) even if one hash is removed/re-added forever.
    if (workQueue.length - workCursor > pending.size * 2 + 64) compactWorkQueue();
  };
  const resetPendingFromRaw = (): boolean => {
    pending.clear();
    rawRevisions.clear();
    workQueue = [];
    workCursor = 0;
    const snapshot = opts.rawBook.all().sort((a, b) => a.offerHash.localeCompare(b.offerHash));
    if (snapshot.length > maxPendingOffers) return false;
    for (const offer of snapshot) {
      const revision = bumpRevision(offer.offerHash);
      pending.set(offer.offerHash, revision);
      workQueue.push({ offerHash: offer.offerHash, revision });
    }
    return true;
  };
  const scheduleRetry = (): void => {
    if (
      stopped || retryTimer || generation === null || heightRegressionBlocked ||
      (opts.rawBook.size === 0 && cachedProbe === null)
    ) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      requestDrain();
    }, retryIntervalMs);
    retryTimer.unref?.();
  };
  const failUnavailable = (error: unknown): void => {
    if (stopped) return;
    epoch++;
    initializing = true;
    routeProven = false;
    const bounded = resetPendingFromRaw();
    const why = bounded
      ? `validate-for-use unavailable: ${reason(error)}`
      : `raw validation backlog ${opts.rawBook.size} exceeds limit ${maxPendingOffers}`;
    block(why);
    report(error);
    scheduleRetry();
  };

  const assertWorkCurrent = (
    source: BookOffer,
    context: ValidationGeneration,
    expectedEpoch: number,
    expectedRevision?: number,
  ): void => {
    if (
      stopped || expectedEpoch !== epoch || generation === null ||
      generation.streamGeneration !== context.streamGeneration || heightRegressionBlocked
    ) {
      throw new OfferValidationSupersededError("validation stream epoch was superseded");
    }
    if (expectedRevision === undefined) return;
    const hash = source.offerHash.toLowerCase();
    const raw = opts.rawBook.get(hash);
    if (
      raw === undefined || rawRevisions.get(hash) !== expectedRevision ||
      !sameProjection(source, raw)
    ) {
      throw new OfferValidationSupersededError(
        `offer ${source.offerHash} changed while validation was queued`,
      );
    }
  };

  const performValidation = async (
    source: BookOffer,
    context: ValidationGeneration,
    expectedEpoch: number,
    expectedRevision: number | undefined,
    signal?: AbortSignal,
  ): Promise<ValidatedBookOffer | null> => {
    assertWorkCurrent(source, context, expectedEpoch, expectedRevision);
    const detail: ApiZswapDetail | (BookOffer & { blob: string }) = source.blob === undefined
      ? await dependencies.getZswapByHash(source.offerHash, {
          ...(opts.api ? { api: opts.api } : {}),
          timeoutMs: requestTimeoutMs,
          signal: signal ?? owner.signal,
        })
      : { ...source, blob: source.blob };
    const parsed = "offerBech32" in detail ? bookOfferFromApi(detail) : detail;
    if (parsed === null || parsed.blob === undefined || !sameProjection(source, parsed)) {
      throw new OfferValidationUnavailableError(
        `offer ${source.offerHash} detail does not match the active raw projection`,
      );
    }
    cachedProbe = { ...parsed, blob: parsed.blob };
    assertWorkCurrent(source, context, expectedEpoch, expectedRevision);
    if (signal?.aborted) {
      throw new OfferValidationUnavailableError("validation caller was aborted before dispatch");
    }
    const verdict = await dependencies.validateOfferForUse(source.offerHash, parsed.blob, {
      ...(opts.api ? { api: opts.api } : {}),
      timeoutMs: requestTimeoutMs,
      signal: signal ?? owner.signal,
      authToken: opts.authToken,
    });
    trace({ kind: "verdict", offerHash: source.offerHash, valid: verdict.valid, code: verdict.code });
    assertWorkCurrent(source, context, expectedEpoch, expectedRevision);
    const activeGeneration = generation!;
    if (BigInt(verdict.stateVersion) < BigInt(activeGeneration.backendBlockL2)) {
      throw new OfferValidationUnavailableError(
        `validation state ${verdict.stateVersion} is below active backend L2 floor ` +
          activeGeneration.backendBlockL2,
      );
    }
    const now = opts.nowMs?.() ?? Date.now();
    const validatedAt = Date.parse(verdict.validatedAt);
    // validatedAt is the committed block timestamp, not response age. It can
    // legitimately be minutes old; the monotonic stateVersion floor is the
    // freshness authority. Only impossible future state and expiry proximity
    // are wall-clock gates.
    if (!Number.isFinite(validatedAt) || validatedAt > now) {
      throw new OfferValidationUnavailableError("validation committed timestamp is in the future");
    }
    if (!verdict.valid) return null;
    if (!verdict.live || verdict.status !== "live" || verdict.code !== "VALID") {
      throw new OfferValidationUnavailableError("positive verdict has inconsistent liveness fields");
    }
    if (computedProjection(verdict) !== projectionOf(parsed) || verdict.computed === undefined) {
      throw new OfferValidationUnavailableError(
        `offer ${source.offerHash} verdict semantics do not match its detail projection`,
      );
    }
    const verdictOffer: BookOffer = {
      offerHash: verdict.claimedOfferId,
      gives: verdict.computed.gives.map((leg) => ({
        token: leg.token,
        amount: BigInt(leg.amount),
        kind: leg.kind,
      })),
      wants: verdict.computed.wants.map((leg) => ({
        token: leg.token,
        amount: BigInt(leg.amount),
        kind: leg.kind,
      })),
      expiresAt: Date.parse(verdict.computed.expiresAt),
      firstSeenAt: parsed.firstSeenAt,
      inputNullifiers: [...verdict.computed.inputNullifiers],
      blob: parsed.blob,
    };
    if (!Number.isSafeInteger(verdictOffer.expiresAt) ||
      now >= verdictOffer.expiresAt - opts.expiryMarginSeconds * 1_000) {
      return null;
    }
    const frozenComputed = Object.freeze({
      gives: Object.freeze(verdict.computed.gives.map((leg) => Object.freeze({ ...leg }))),
      wants: Object.freeze(verdict.computed.wants.map((leg) => Object.freeze({ ...leg }))),
      inputNullifiers: Object.freeze([...verdict.computed.inputNullifiers]),
      expiresAt: verdict.computed.expiresAt,
    }) as unknown as Readonly<ValidatedOfferSemantics>;
    const evidence = freezeEvidence({
      streamGeneration: activeGeneration.streamGeneration,
      backendBlockL2: activeGeneration.backendBlockL2,
      offerHash: verdictOffer.offerHash,
      blobHash: verdictOffer.offerHash,
      projection: projectionOf(verdictOffer),
      computed: frozenComputed,
      stateVersion: verdict.stateVersion,
      validatedAt: verdict.validatedAt,
      expiresAt: verdictOffer.expiresAt,
    });
    return freezeOffer(verdictOffer, parsed.blob, evidence);
  };

  /** V2 retains one physical validation slot per credential, possibly beyond
   * a caller's logical timeout. Background admission and Executor dequeue
   * checks therefore share this single queue. Stream/revision authority is
   * checked at the head so stale queued work dispatches no detail or POST. */
  const fetchAndValidate = (
    source: BookOffer,
    context: ValidationGeneration,
    expectedEpoch: number,
    expectedRevision: number | undefined,
    signal?: AbortSignal,
  ): Promise<ValidatedBookOffer | null> => {
    const scheduled = validationTail.catch(() => {}).then(async () => {
      if (stopped || owner.signal.aborted) {
        throw new OfferValidationUnavailableError("validation gate is stopped");
      }
      if (signal?.aborted) {
        throw new OfferValidationSupersededError("queued validation caller was aborted");
      }
      assertWorkCurrent(source, context, expectedEpoch, expectedRevision);

      const operation = new AbortController();
      const abortForOwner = (): void => operation.abort(owner.signal.reason);
      const abortForCaller = (): void => operation.abort(signal?.reason);
      if (owner.signal.aborted) abortForOwner();
      else owner.signal.addEventListener("abort", abortForOwner, { once: true });
      if (signal?.aborted) abortForCaller();
      else signal?.addEventListener("abort", abortForCaller, { once: true });
      try {
        return await performValidation(
          source,
          context,
          expectedEpoch,
          expectedRevision,
          operation.signal,
        );
      } finally {
        owner.signal.removeEventListener("abort", abortForOwner);
        signal?.removeEventListener("abort", abortForCaller);
      }
    });
    validationTail = scheduled.then(() => {}, () => {});
    return scheduled;
  };

  const installResult = (
    offerHash: string,
    expectedRevision: number,
    validated: ValidatedBookOffer | null,
  ): void => {
    if (rawRevisions.get(offerHash) !== expectedRevision) return;
    pending.delete(offerHash);
    routeProven = true;
    if (validated === null) {
      removeValidated(offerHash);
      return;
    }
    const existing = book.get(offerHash);
    const changed = !existing ||
      existing.validation.stateVersion !== validated.validation.stateVersion ||
      existing.validation.validatedAt !== validated.validation.validatedAt ||
      existing.validation.projection !== validated.validation.projection;
    book.upsert(validated);
    trace({
      kind: "admitted",
      offerHash,
      generation: {
        streamGeneration: validated.validation.streamGeneration,
        backendBlockL2: validated.validation.backendBlockL2,
      },
    });
    if (changed) notifyBookChange();
  };

  const runDrainPass = async (): Promise<void> => {
    if (generation === null || heightRegressionBlocked) return;
    trace({ kind: "drain-start", generation, offers: pending.size });
    if (opts.rawBook.size > maxPendingOffers) {
      block(`raw validation backlog ${opts.rawBook.size} exceeds limit ${maxPendingOffers}`);
      return;
    }

    while (!stopped && generation !== null && !heightRegressionBlocked) {
      let ticket: { offerHash: string; revision: number } | undefined;
      while (workCursor < workQueue.length) {
        const candidate = workQueue[workCursor++];
        if (pending.get(candidate.offerHash) === candidate.revision) {
          ticket = candidate;
          break;
        }
      }
      if (ticket === undefined) {
        if (pending.size > 0) {
          compactWorkQueue();
          continue;
        }
        workQueue = [];
        workCursor = 0;
        break;
      }
      const { offerHash, revision: expectedRevision } = ticket;
      const source = opts.rawBook.get(offerHash);
      if (source === undefined || rawRevisions.get(offerHash) !== expectedRevision) {
        if (pending.get(offerHash) === expectedRevision) pending.delete(offerHash);
        continue;
      }
      const context = generation;
      const expectedEpoch = epoch;
      try {
        const validated = await fetchAndValidate(
          source,
          context,
          expectedEpoch,
          expectedRevision,
        );
        installResult(offerHash, expectedRevision, validated);
      } catch (error) {
        if (stopped) return;
        if (error instanceof OfferValidationSupersededError) continue;
        failUnavailable(error);
        return;
      }
    }

    if (stopped || generation === null || heightRegressionBlocked || pending.size > 0) return;
    if (initializing && !routeProven) {
      // A real previously observed offer is a truthful route/auth capability
      // probe after the active book becomes empty. On first-ever empty startup
      // the POST-only contract has no such probe, so readiness stays blocked.
      const probe = cachedProbe;
      if (probe === null) {
        block("validation capability is unproven for an initially empty raw book");
        return;
      }
      const context = generation;
      const expectedEpoch = epoch;
      try {
        await fetchAndValidate(probe, context, expectedEpoch, undefined);
        routeProven = true;
      } catch (error) {
        if (stopped) return;
        if (error instanceof OfferValidationSupersededError) return;
        failUnavailable(error);
        return;
      }
    }
    if (
      !stopped && generation !== null && !heightRegressionBlocked &&
      pending.size === 0 && routeProven
    ) {
      initializing = false;
      publish({ kind: "ready", ...generation });
    }
  };

  function requestDrain(): void {
    if (stopped || generation === null || heightRegressionBlocked) return;
    drainRequested = true;
    if (runner) return;
    const active = (async () => {
      while (!stopped && drainRequested) {
        drainRequested = false;
        await runDrainPass();
      }
    })().finally(() => {
      if (runner === active) runner = null;
      if (!stopped && drainRequested) requestDrain();
    });
    runner = active;
    void active.catch(report);
  }

  const admissionEvidenceCurrent = (evidence: ValidationEvidence | undefined): boolean => {
    if (evidence === undefined || stopped || state.kind !== "ready" || generation === null) {
      return false;
    }
    const raw = opts.rawBook.get(evidence.offerHash);
    const now = opts.nowMs?.() ?? Date.now();
    return evidence.streamGeneration === generation.streamGeneration &&
      raw !== undefined && projectionOf(raw) === evidence.projection &&
      now < evidence.expiresAt - opts.expiryMarginSeconds * 1_000;
  };

  return {
    book,
    beginGeneration: (next): void => {
      if (stopped) return;
      const canonical = canonicalGeneration(next);
      const nextFloor = BigInt(canonical.backendBlockL2);
      if (!sameStream(generation, canonical)) {
        generation = canonical;
        highestFloor = nextFloor;
        heightRegressionBlocked = false;
        epoch++;
        initializing = true;
        routeProven = false;
        const bounded = resetPendingFromRaw();
        block(
          bounded
            ? "validation stream generation is draining"
            : `raw validation backlog ${opts.rawBook.size} exceeds limit ${maxPendingOffers}`,
          canonical,
        );
        requestDrain();
        return;
      }

      if (highestFloor !== null && nextFloor < highestFloor) {
        generation = canonical;
        heightRegressionBlocked = true;
        epoch++;
        initializing = true;
        routeProven = false;
        pending.clear();
        rawRevisions.clear();
        workQueue = [];
        workCursor = 0;
        block(
          `backend L2 floor regressed from ${highestFloor} to ${canonical.backendBlockL2}`,
          canonical,
        );
        return;
      }

      const recoveringFromRegression = heightRegressionBlocked;
      generation = canonical;
      highestFloor = nextFloor;
      heightRegressionBlocked = false;
      if (recoveringFromRegression) {
        epoch++;
        initializing = true;
        routeProven = false;
        const bounded = resetPendingFromRaw();
        block(
          bounded
            ? "validation stream generation is draining"
            : `raw validation backlog ${opts.rawBook.size} exceeds limit ${maxPendingOffers}`,
          canonical,
        );
        requestDrain();
        return;
      }

      // A height advance in one uninterrupted SSE epoch is a monotonic floor,
      // not a new raw-book generation. Existing point-in-time positives remain
      // admitted; every actual mutation is delivered through the same stream,
      // and Executor obtains a new verdict covering this floor before mutation.
      if (state.kind === "ready") publish({ kind: "ready", ...canonical });
      else publish({ ...state, ...canonical });
      if (pending.size > 0 || initializing) requestDrain();
    },
    invalidate: (why): void => {
      if (stopped) return;
      generation = null;
      highestFloor = null;
      heightRegressionBlocked = false;
      epoch++;
      pending.clear();
      rawRevisions.clear();
      cachedProbe = null;
      workQueue = [];
      workCursor = 0;
      initializing = true;
      routeProven = false;
      drainRequested = false;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      block(why, null);
    },
    rawBookChanged: (offerHash): void => {
      if (stopped) return;
      if (offerHash === undefined) {
        epoch++;
        initializing = true;
        routeProven = false;
        const bounded = resetPendingFromRaw();
        block(
          bounded
            ? "raw book generation changed; validation is draining"
            : `raw validation backlog ${opts.rawBook.size} exceeds limit ${maxPendingOffers}`,
        );
        requestDrain();
        return;
      }

      const hash = offerHash.toLowerCase();
      removeValidated(hash);
      pending.delete(hash);
      if (opts.rawBook.size > maxPendingOffers) {
        epoch++;
        initializing = true;
        routeProven = false;
        pending.clear();
        rawRevisions.clear();
        workQueue = [];
        workCursor = 0;
        block(`raw validation backlog ${opts.rawBook.size} exceeds limit ${maxPendingOffers}`);
        return;
      }
      if (
        state.kind === "blocked" &&
        state.reason.startsWith("raw validation backlog ")
      ) {
        epoch++;
        initializing = true;
        routeProven = false;
        resetPendingFromRaw();
        block("raw backlog returned within bounds; validation is draining");
        requestDrain();
        return;
      }
      const raw = opts.rawBook.get(hash);
      if (raw === undefined) {
        // Deletion itself supersedes an in-flight ticket: absence from this map
        // makes its head/response authority check fail without retaining the
        // historical hash forever.
        rawRevisions.delete(hash);
      } else {
        const revision = bumpRevision(hash);
        pending.set(hash, revision);
        enqueueWork(hash, revision);
      }

      // Once the route and initial generation are proven, a touched offer is
      // quarantined independently. Other immutable positives in this stream
      // remain usable while this one passes the serial endpoint queue.
      if (state.kind === "blocked") initializing = true;
      requestDrain();
    },
    currentGeneration: () => generation ? { ...generation } : null,
    availability: () => ({ ...state }),
    isEvidenceCurrent: admissionEvidenceCurrent,
    isExecutionEvidenceCurrent: (evidence): boolean =>
      admissionEvidenceCurrent(evidence) && generation !== null &&
      BigInt(evidence!.stateVersion) >= BigInt(generation.backendBlockL2),
    revalidateForExecution: async (offer, signal): Promise<ValidatedBookOffer> => {
      const context = generation;
      if (
        context === null || state.kind !== "ready" ||
        context.streamGeneration !== offer.validation.streamGeneration
      ) {
        throw new OfferValidationRejectedError("SUPERSEDED", "validation evidence is superseded");
      }
      const raw = opts.rawBook.get(offer.offerHash);
      if (raw === undefined || projectionOf(raw) !== offer.validation.projection) {
        throw new OfferValidationRejectedError("SUPERSEDED", "raw offer changed or disappeared");
      }
      const expectedRevision = rawRevisions.get(offer.offerHash);
      if (expectedRevision === undefined) {
        throw new OfferValidationRejectedError("SUPERSEDED", "raw offer has no stream revision");
      }
      const expectedEpoch = epoch;
      trace({ kind: "execution-start", offerHash: offer.offerHash, generation: context });
      try {
        const checked = await fetchAndValidate(
          raw,
          context,
          expectedEpoch,
          expectedRevision,
          signal,
        );
        routeProven = true;
        if (checked === null) {
          removeValidated(offer.offerHash);
          throw new OfferValidationRejectedError("NEGATIVE", "backend rejected offer at dequeue");
        }
        trace({
          kind: "execution-valid",
          offerHash: offer.offerHash,
          generation: {
            streamGeneration: checked.validation.streamGeneration,
            backendBlockL2: checked.validation.backendBlockL2,
          },
        });
        return checked;
      } catch (error) {
        if (error instanceof OfferValidationRejectedError) throw error;
        if (error instanceof OfferValidationSupersededError) {
          throw new OfferValidationRejectedError("SUPERSEDED", error.message);
        }
        failUnavailable(error);
        throw error;
      }
    },
    metadataCounts: () => ({
      rawRevisions: rawRevisions.size,
      pendingOffers: pending.size,
      queuedTickets: Math.max(0, workQueue.length - workCursor),
      cachedProbes: cachedProbe === null ? 0 : 1,
    }),
    idle: async (): Promise<void> => {
      for (;;) {
        const activeRunner = runner;
        const activeValidation = validationTail;
        if (!activeRunner) {
          await activeValidation.catch(() => {});
          if (!runner && activeValidation === validationTail) return;
          continue;
        }
        await Promise.all([activeRunner.catch(() => {}), activeValidation.catch(() => {})]);
      }
    },
    stop: (): Promise<void> => {
      if (stopPromise) return stopPromise;
      stopped = true;
      epoch++;
      pending.clear();
      rawRevisions.clear();
      workQueue = [];
      workCursor = 0;
      drainRequested = false;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      owner.abort(new Error("validation gate stopped"));
      block("validation gate stopped", null);
      stopPromise = Promise.all([
        runner?.catch(() => {}) ?? Promise.resolve(),
        validationTail.catch(() => {}),
      ]).then(() => {});
      return stopPromise;
    },
  };
}
