// Child process for offer-expiry-model.test.ts (00056 T3/T4): env.ts reads its
// environment once, at import, so the cases that need a different
// MIDNIGHT_NETWORK_ID or an explicit OFFER_TTL_SECONDS run here, in a fresh
// process, instead of mutating the shared test process.
//
//   mode "env"    — import env.ts and print what it resolved (an unknown
//                   network id makes the import throw: the startup failure).
//   mode "ingest" — also drive the production STM once for a signed
//                   unshielded offer whose intent TTL is block time + 2 h,
//                   answering its DB reads deterministically, and print the
//                   offer row it inserts.
//
// Prints one JSON line on stdout; env.ts's startup warnings go to stderr.

const mode = process.argv[2] ?? "env";

const env = await import("../env.ts");
const summary: Record<string, unknown> = {
  network: env.MIDNIGHT_NETWORK_ID,
  offerTtlSeconds: env.OFFER_TTL_SECONDS,
  rootWindowSeconds: env.ROOT_WINDOW_SECONDS,
  dustGracePeriodSeconds: env.DUST_GRACE_PERIOD_SECONDS,
};

if (mode === "ingest") {
  const database = await import("@zswap-da/database");
  const { bytesToLatin1 } = await import("@zswap-da/offer-guard");
  const { gameStateTransitions } = await import("../state-machine.ts");
  const { signedUnshieldedOffer } = await import("../../validator/signed-offer.testkit.ts");

  const BLOCK_TIME_MS = Date.parse("2026-08-14T12:00:00.000Z");
  const offer = await signedUnshieldedOffer(new Date(BLOCK_TIME_MS + 2 * 3_600_000));
  let inserted: Record<string, unknown> | null = null;
  let rejected: unknown = null;

  const { eventBus, markBlockCommitted, __resetEventGateForTests } = await import("../event-bus.ts");
  __resetEventGateForTests();
  eventBus.on("app_event", (event: any) => {
    if (event.type === "offer_rejected") rejected = event.code;
  });
  const generator = gameStateTransitions(1, {
    blockHeight: 5,
    blockTimestamp: BLOCK_TIME_MS,
    conciseInput: JSON.stringify(["celestia-zswap", { suppliedValue: bytesToLatin1(offer.bytes) }]),
    randomGenerator: {} as any,
    emit: () => {},
  } as any);
  let next = generator.next();
  while (!next.done) {
    const [queryIR, params] = next.value as [unknown, any];
    let result: unknown[] = [];
    if (queryIR === (database.isUnshieldedCreated as any).queryIR) result = [{ present: 1 }];
    else if (queryIR === (database.insertOfferFileWithHash as any).queryIR) {
      inserted = {
        metadata_created_at: params.metadata_created_at,
        metadata_expires_at: params.metadata_expires_at,
        ttl_seconds: params.ttl_seconds,
      };
      result = [{ id: 1 }];
    }
    next = generator.next(result);
  }
  markBlockCommitted(5);
  summary["ttl"] = offer.ttl.toISOString();
  summary["inserted"] = inserted;
  summary["rejected"] = rejected;
}

console.log(JSON.stringify(summary));
