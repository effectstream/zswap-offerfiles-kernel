import { describe, expect, test } from "bun:test";
import { processSQLQueryIR } from "@pgtyped/runtime";

import {
  archiveOfferByIdTtlWithHash,
  compileIR,
  createAppInputSavepoint,
  getEarliestRootFirstSeen,
  insertCommitment,
  releaseAppInputSavepoint,
  rollbackAppInputSavepoint,
  upsertKnownRootWithFirstSeen,
} from "./queries.app.ts";

// The STM path never calls .run(): World.resolve yields [query.queryIR, input]
// and the framework executes the IR itself. So every query the STM touches
// must carry a REAL pgtyped IR. compileIR reproduces the generator's output —
// these tests pin it against the generator's own IR (copied verbatim from
// queries.queries.ts) and against the framework's execution path.

describe("compileIR — oracle vs pgtyped's generated IR", () => {
  test("byte-identical to the generator on a real query (InsertKnownToken)", () => {
    // Copied VERBATIM from sql/queries.queries.ts (insertKnownTokenIR).
    const generated = {
      usedParamSet: { token_color: true, name: true, kind: true },
      params: [
        { name: "token_color", required: true, transform: { type: "scalar" }, locs: [{ a: 59, b: 71 }] },
        { name: "name", required: true, transform: { type: "scalar" }, locs: [{ a: 74, b: 79 }] },
        { name: "kind", required: true, transform: { type: "scalar" }, locs: [{ a: 82, b: 87 }] },
      ],
      statement: "INSERT INTO known_tokens (token_color, name, kind)\nVALUES (:token_color!, :name!, :kind!)\nON CONFLICT (token_color) DO NOTHING",
    };
    expect(compileIR(generated.statement)).toEqual(generated as any);
  });

  test("repeated params share one entry with multiple locs (generator behavior)", () => {
    // Copied VERBATIM from queries.queries.ts (getOfferFilesIR) — :token and
    // :direction each appear twice, once optional and once required.
    const statement =
      "SELECT DISTINCT of.*\nFROM offer_file of\nLEFT JOIN offer_file_tokens oft ON oft.offer_file_id = of.id\nWHERE\n  (:token = '' OR oft.token_color = :token!)\n  AND (:direction = 'ANY' OR oft.direction = :direction!)\nORDER BY of.created_at DESC\nLIMIT :limit!\nOFFSET :offset!";
    const ir = compileIR(statement);
    const token = ir.params.find((p) => p.name === "token")!;
    expect(token.locs).toEqual([{ a: 110, b: 115 }, { a: 143, b: 149 }]);
    expect(token.required).toBe(true); // any required occurrence wins
    const direction = ir.params.find((p) => p.name === "direction")!;
    expect(direction.locs).toEqual([{ a: 159, b: 168 }, { a: 197, b: 207 }]);
    expect(ir.params.map((p) => p.name)).toEqual(["token", "direction", "limit", "offset"]);
  });

  test("::type casts are NOT params (the trap that motivates this test)", () => {
    const ir = compileIR("SELECT COUNT(*)::int AS n, x::text, amount::numeric FROM t WHERE a = :a!");
    expect(ir.params.map((p) => p.name)).toEqual(["a"]);
  });
});

describe("the framework execution path (processSQLQueryIR on our IRs)", () => {
  test("STM-critical queries expose a queryIR the executor can process", () => {
    // This is precisely what was broken live: these objects had no queryIR,
    // so every zswap-event / zswap-root transition died with
    // "undefined is not an object (evaluating 'queryIR.params')" — silently,
    // because the runtime routes STF errors to log.remote only.
    for (const q of [
      insertCommitment,
      upsertKnownRootWithFirstSeen,
      getEarliestRootFirstSeen,
      archiveOfferByIdTtlWithHash,
      createAppInputSavepoint,
      rollbackAppInputSavepoint,
      releaseAppInputSavepoint,
    ]) {
      expect((q as any).queryIR?.params).toBeDefined();
      expect((q as any).queryIR?.statement).toBeTypeOf("string");
    }
  });

  test("processSQLQueryIR substitutes $N exactly like the framework will", () => {
    const { query, bindings } = processSQLQueryIR(
      (insertCommitment as any).queryIR,
      { commitment: "aa", tx_hash: "bb", mt_index: "28", height: 7 } as any,
    );
    expect(query).toContain("VALUES ($1, $2, $3, $4)");
    expect(query).not.toContain(":commitment");
    expect(bindings).toEqual(["aa", "bb", "28", 7]);
  });

  test("array param via ANY() rides one scalar binding", () => {
    const { query, bindings } = processSQLQueryIR(
      (getEarliestRootFirstSeen as any).queryIR,
      { roots: ["r1", "r2"] } as any,
    );
    expect(query).toContain("ANY($1)");
    expect(bindings).toEqual([["r1", "r2"]]);
  });

  test("TTL archive query binds the persisted-expiry cutoff used by the transition", () => {
    const cutoff = new Date("2026-08-13T12:00:00.000Z");
    const { query, bindings } = processSQLQueryIR(
      (archiveOfferByIdTtlWithHash as any).queryIR,
      { offer_file_id: 7, expires_at_cutoff: cutoff, archived_at: cutoff } as any,
    );
    expect(query).toContain("metadata_expires_at <= $2");
    expect(bindings).toEqual([7, cutoff, cutoff]);
  });

  test("application-input transaction-control IR reaches PostgreSQL verbatim", () => {
    for (const [preparedQuery, statement] of [
      [createAppInputSavepoint, "SAVEPOINT zswap_da_app_input_v1"],
      [rollbackAppInputSavepoint, "ROLLBACK TO SAVEPOINT zswap_da_app_input_v1"],
      [releaseAppInputSavepoint, "RELEASE SAVEPOINT zswap_da_app_input_v1"],
    ] as const) {
      const { query, bindings } = processSQLQueryIR(
        (preparedQuery as any).queryIR,
        undefined,
      );
      expect(query).toBe(statement);
      expect(bindings).toEqual([]);
    }
  });
});
