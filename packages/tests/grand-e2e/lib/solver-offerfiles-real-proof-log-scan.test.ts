import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertDirectProofLogSafe,
  assertMixedComposeProofLogSafe,
  assertNoProofMaterialLogSignatures,
} from "./solver-offerfiles-real-proof-log-scan.ts";

const scopes = [
  assertNoProofMaterialLogSignatures,
  assertDirectProofLogSafe,
  assertMixedComposeProofLogSafe,
] as const;
const runnerSource = readFileSync(join(import.meta.dir, "../solver-offerfiles-e2e.ts"), "utf8");

describe("proof-log provenance scanner", () => {
  test("allows backend DEBUG/TRACE and validation-trace in mixed diagnostics", () => {
    const text = [
      "zswap-e1r-case-offerfiles-backend-1 | DEBUG validation-trace accepted",
      "contract-deployer-1 | TRACE deployment boundary",
      "proof-server-1 | INFO verified correct",
    ].join("\n");
    expect(() => assertMixedComposeProofLogSafe("mixed", text)).not.toThrow();
    expect(() => assertNoProofMaterialLogSignatures("selected", text)).not.toThrow();
  });

  test("direct proof DEBUG and TRACE are rejected while INFO is allowed", () => {
    expect(() => assertDirectProofLogSafe("proof", "INFO verified correct")).not.toThrow();
    expect(() => assertDirectProofLogSafe("proof", "DEBUG endpoint started")).toThrow("proof DEBUG/TRACE");
    expect(() => assertDirectProofLogSafe("proof", "TRACE endpoint started")).toThrow("proof DEBUG/TRACE");
  });

  test("mixed diagnostics reject plain and project-prefixed proof DEBUG/TRACE", () => {
    expect(() => assertMixedComposeProofLogSafe("mixed", "proof-server-1 | DEBUG unsafe")).toThrow(
      "proof-prefixed DEBUG/TRACE",
    );
    expect(() =>
      assertMixedComposeProofLogSafe(
        "mixed",
        "zswap-e1r-123-proof-server-1   | 2026-08-15T00:00:00Z TRACE unsafe",
      )
    ).toThrow("proof-prefixed DEBUG/TRACE");
    expect(() =>
      assertMixedComposeProofLogSafe(
        "mixed",
        "zswap_e1r_123_proof-server_1 | 2026-08-15T00:00:00Z DEBUG unsafe",
      )
    ).toThrow("proof-prefixed DEBUG/TRACE");
  });

  test("material signatures are rejected in every scope", () => {
    for (const scan of scopes) {
      expect(() => scan("scope", "Received request: 00ff")).toThrow("raw proving request");
      expect(() => scan("scope", "INFO witness bytes withheld")).toThrow("witness material");
      expect(() => scan("scope", "a".repeat(4_096))).toThrow("long hexadecimal proving payload");
    }
  });

  test("the successful aggregate Compose-log capture uses the mixed provenance guard", () => {
    const captureStart = runnerSource.indexOf("async function captureRealE1Artifacts(");
    const captureEnd = runnerSource.indexOf("\nasync function runRealE1Topology()", captureStart);
    expect(captureStart).toBeGreaterThanOrEqual(0);
    expect(captureEnd).toBeGreaterThan(captureStart);
    const captureBody = runnerSource.slice(captureStart, captureEnd);
    const guard = 'assertMixedComposeProofLogSafe("real E1 aggregate Compose logs", composeLogText);';
    expect(captureBody.split(guard)).toHaveLength(2);
    const guardIndex = captureBody.indexOf(guard);
    expect(guardIndex).toBeGreaterThan(captureBody.indexOf("const composeLogText ="));
    expect(guardIndex).toBeLessThan(captureBody.indexOf("composeLogs: {", guardIndex));
  });
});
