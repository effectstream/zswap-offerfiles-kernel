import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

import {
  RELAY_WS_CONTRACT_REVISION,
  interpolateQuote,
  isHexBytes,
  isPriceLevelsPair,
  parseJobError,
  parsePriceLevels,
  parseSolverCapabilities,
  parseSubmitFailed,
  parseSwap,
  parseSwapTx,
  parseTxSubmitted,
} from "./relay-ws-contract.ts";

const FIXTURE_ROOT = new URL("./fixtures/relay-ws/v1/", import.meta.url);
const raw = (name: string): string => readFileSync(new URL(name, FIXTURE_ROOT), "utf8");
const fixture = (name: string): unknown => JSON.parse(raw(name));
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Every WS message the COW must speak, per plan phase N0. */
const MESSAGE_FIXTURES = [
  "job-error.json",
  "price-levels.json",
  "solver-capabilities.json",
  "submit-failed.json",
  "swap-tx.json",
  "swap.json",
  "tx-submitted.json",
] as const;

/**
 * Byte pins. Changing any of these means the wire contract moved, which is only
 * legitimate when the pinned midnight-intents-swaps revision moves too — and
 * that revision is `RELAY_WS_CONTRACT_REVISION`.
 */
const FIXTURE_SHA256: Record<(typeof MESSAGE_FIXTURES)[number], string> = {
  "job-error.json": "bd8ccf3580fe694c3dbd7f380136bc6fec25f54138e8ea8fc54e83377b0614d7",
  "price-levels.json": "f4cbc3226c579f60a20575ba722019418901bc31dccff6c78e28e2ae85c66708",
  "solver-capabilities.json": "b079efdede69effd6ad517c4ef04138980495ba0fd310211c0122572ed7bedc7",
  "submit-failed.json": "5337b72d8d2cc09c97179c5f8f669df12afec845bd934af59e12f302082f9f91",
  "swap-tx.json": "32392e55dd8f9f82c95ff132de5ac09f0866b0654b9b891a86d1e0f0a218d54e",
  "swap.json": "99385a1516843eff64d01d719854afa470a3856e0f7c559a9fd612d547141e5c",
  "tx-submitted.json": "bcac56a3c57a915cd00f842f58f341ef7f23b5f0e5be49672d50620cd634898f",
};

/** SHA-256 of `MANIFEST.sha256` itself — the path-independent aggregate, in the
 *  same shape as the frozen L0 data-lineage fixture set. */
const AGGREGATE_SHA256 = "0a832e1150a5465901e4084a791726ce6e4224ed4312e58e1085e84c568234fc";

const TOKEN_A = `01${"00".repeat(31)}`;
const TOKEN_B = `02${"00".repeat(31)}`;
const JOB_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("relay RFQ WS wire fixtures v1", () => {
  test("pins the fixture directory contents byte-for-byte", () => {
    const present = readdirSync(FIXTURE_ROOT).sort();
    expect(present).toEqual([...MESSAGE_FIXTURES, "MANIFEST.sha256"].sort());
    for (const [name, expected] of Object.entries(FIXTURE_SHA256)) {
      expect(sha256(raw(name))).toBe(expected);
    }
  });

  test("the checksum manifest reproduces from the fixtures and hashes to the frozen aggregate", () => {
    const manifest = raw("MANIFEST.sha256");
    const rebuilt = [...MESSAGE_FIXTURES]
      .map((name) => `${sha256(raw(name))}  ${name}`)
      .sort()
      .map((line) => `${line}\n`)
      .join("");
    expect(manifest).toBe(rebuilt);
    expect(sha256(manifest)).toBe(AGGREGATE_SHA256);
  });

  test("every fixture parses under the pinned relay's own admission rules", () => {
    expect(parseSolverCapabilities(fixture("solver-capabilities.json"))).toEqual({
      type: "solver-capabilities",
      tokenIds: [TOKEN_A, TOKEN_B],
      maxParallelSwaps: 8,
    });
    expect(parsePriceLevels(fixture("price-levels.json"))).not.toBeNull();
    expect(parseSwapTx(fixture("swap-tx.json"))).not.toBeNull();
    expect(parseJobError(fixture("job-error.json"))).toEqual({
      type: "job-error",
      jobId: JOB_ID,
      reason: "solver_at_capacity",
    });
    expect(parseSwap(fixture("swap.json"))).toEqual({
      type: "swap",
      jobId: JOB_ID,
      tokenIn: TOKEN_B,
      tokenOut: TOKEN_A,
      amountIn: "12",
      amountOut: "22",
    });
    expect(parseTxSubmitted(fixture("tx-submitted.json"))).not.toBeNull();
    expect(parseSubmitFailed(fixture("submit-failed.json"))).toEqual({
      type: "submit-failed",
      jobId: JOB_ID,
      reason: "late swap-tx: job already terminal",
    });
  });

  test("each parser rejects every other message type", () => {
    const parsers = {
      "solver-capabilities.json": parseSolverCapabilities,
      "price-levels.json": parsePriceLevels,
      "swap-tx.json": parseSwapTx,
      "job-error.json": parseJobError,
      "swap.json": parseSwap,
      "tx-submitted.json": parseTxSubmitted,
      "submit-failed.json": parseSubmitFailed,
    } as const;
    for (const [own, parse] of Object.entries(parsers)) {
      for (const name of MESSAGE_FIXTURES) {
        if (name === own) continue;
        expect(parse(fixture(name))).toBeNull();
      }
    }
  });

  test("the frozen ladder is the plan's canonical whole-offer frontier", () => {
    const message = parsePriceLevels(fixture("price-levels.json"));
    expect(message).not.toBeNull();
    expect(message!.levels).toHaveLength(1);
    const pair = message!.levels[0]!;
    // The book `-10A +10B`, `-5A +5B`, `-20A +10B` backs the B -> A direction
    // only; A -> B is omitted entirely rather than published unhonourably.
    expect(pair.tokenIn).toBe(TOKEN_B);
    expect(pair.tokenOut).toBe(TOKEN_A);
    expect(pair.levels).toEqual([
      { input: "10", output: "20" },
      { input: "15", output: "25" },
      { input: "20", output: "30" },
      { input: "25", output: "35" },
    ]);
  });

  test("relay interpolation over the frozen ladder matches the recorded worked example", () => {
    const pair = parsePriceLevels(fixture("price-levels.json"))!.levels[0]!;
    const at = (amount: bigint) => interpolateQuote(pair.levels, amount);
    // Below the first rung and above the last rung are refusals, which is why a
    // small-trade rung has to come from solver inventory rather than the book.
    expect(at(9n)).toBeNull();
    expect(at(26n)).toBeNull();
    // Rungs are exact whole-offer sums.
    expect(at(10n)).toBe(20n);
    expect(at(15n)).toBe(25n);
    expect(at(20n)).toBe(30n);
    expect(at(25n)).toBe(35n);
    // Between rungs the relay promises a floored chord. 12 B -> 22 A is the
    // recorded residual case: whole offers give 20 A for 10 B and the remaining
    // 2 B -> 2 A has to come from solver inventory.
    expect(at(12n)).toBe(22n);
  });
});

describe("relay RFQ WS admission edges", () => {
  test("ladders must be strictly ascending in cumulative input", () => {
    const ascending = { tokenIn: TOKEN_B, tokenOut: TOKEN_A, levels: [
      { input: "10", output: "20" },
      { input: "11", output: "21" },
    ] };
    expect(isPriceLevelsPair(ascending)).toBe(true);
    expect(isPriceLevelsPair({ ...ascending, levels: [
      { input: "10", output: "20" },
      { input: "10", output: "21" },
    ] })).toBe(false);
    expect(isPriceLevelsPair({ ...ascending, levels: [
      { input: "11", output: "21" },
      { input: "10", output: "20" },
    ] })).toBe(false);
  });

  test("an empty ladder is wire-valid and is the fail-closed withdrawal", () => {
    expect(isPriceLevelsPair({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, levels: [] })).toBe(true);
    expect(parsePriceLevels({ type: "price-levels", levels: [] })).toEqual({
      type: "price-levels",
      levels: [],
    });
    // …but it quotes nothing, so the pair stops being routable.
    expect(interpolateQuote([], 10n)).toBeNull();
  });

  test("rung amounts are decimal integer strings only", () => {
    for (const bad of ["-1", "1.0", "0x10", "1e3", " 10", "", 10]) {
      expect(
        isPriceLevelsPair({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, levels: [{ input: bad, output: "20" }] }),
      ).toBe(false);
    }
  });

  test("capabilities need a full 64-hex token set, but tolerate a bad maxParallelSwaps", () => {
    expect(parseSolverCapabilities({ type: "solver-capabilities", tokenIds: [TOKEN_A, "beef"] })).toBeNull();
    expect(parseSolverCapabilities({ type: "solver-capabilities", tokenIds: "not-an-array" })).toBeNull();
    // Uppercase is accepted and lowercased, matching the relay.
    expect(
      parseSolverCapabilities({ type: "solver-capabilities", tokenIds: [TOKEN_A.toUpperCase()] }),
    ).toEqual({ type: "solver-capabilities", tokenIds: [TOKEN_A] });
    // A bad capacity leaves the relay's default of 8 in place rather than
    // rejecting the whole frame — the tokens still register.
    expect(
      parseSolverCapabilities({ type: "solver-capabilities", tokenIds: [TOKEN_A], maxParallelSwaps: 0 }),
    ).toEqual({ type: "solver-capabilities", tokenIds: [TOKEN_A] });
    expect(
      parseSolverCapabilities({ type: "solver-capabilities", tokenIds: [TOKEN_A], maxParallelSwaps: 1.5 }),
    ).toEqual({ type: "solver-capabilities", tokenIds: [TOKEN_A] });
  });

  test("swap-tx bytes must be even-length hex", () => {
    expect(isHexBytes("")).toBe(true);
    expect(isHexBytes("00ff")).toBe(true);
    expect(isHexBytes("00F")).toBe(false);
    expect(isHexBytes("zz")).toBe(false);
    expect(parseSwapTx({ type: "swap-tx", jobId: JOB_ID, txBytes: "abc" })).toBeNull();
  });

  test("swap jobs need positive decimal amounts", () => {
    const base = { type: "swap", jobId: JOB_ID, tokenIn: TOKEN_B, tokenOut: TOKEN_A };
    expect(parseSwap({ ...base, amountIn: "0", amountOut: "22" })).toBeNull();
    expect(parseSwap({ ...base, amountIn: "12", amountOut: "0" })).toBeNull();
    expect(parseSwap({ ...base, amountIn: "-12", amountOut: "22" })).toBeNull();
    expect(parseSwap({ ...base, amountIn: 12, amountOut: 22 })).toBeNull();
    expect(parseSwap({ ...base, jobId: "", amountIn: "12", amountOut: "22" })).toBeNull();
  });

  test("names the pinned relay revision the contract was ported from", () => {
    expect(RELAY_WS_CONTRACT_REVISION).toBe("d444c8379415093460d83a6ba27536af396f759d");
  });
});
