import path from "node:path";

const EXPECTED_METADATA = {
  "compiler-version": "0.34.0",
  "language-version": "0.26.0",
  "runtime-version": "0.19.0",
} as const;

const EXPECTED_BZKIR = [
  "incrementNoun.bzkir",
  "mint_shielded.bzkir",
  "mint_unshielded.bzkir",
];

const EXPECTED_KEYS = [
  "incrementNoun.prover",
  "incrementNoun.verifier",
  "mint_shielded.prover",
  "mint_shielded.verifier",
  "mint_unshielded.prover",
  "mint_unshielded.verifier",
];

function assertExactInventory(
  label: string,
  actual: string[],
  expected: string[],
): void {
  const actualSorted = actual.toSorted();
  const expectedSorted = expected.toSorted();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(
      `${label} inventory mismatch: expected [${expectedSorted.join(", ")}], found [${actualSorted.join(", ")}]`,
    );
  }
}

async function main(): Promise<void> {
  const repositoryRoot = path.resolve(import.meta.dir, "..");
  const managed = path.join(
    repositoryRoot,
    "packages/contracts-midnight/contract-offer-files/src/managed",
  );
  const manifest = (await Bun.file(
    path.join(managed, "compiler/contract-manifest.json"),
  ).json()) as Record<string, unknown>;

  for (const [field, expected] of Object.entries(EXPECTED_METADATA)) {
    if (manifest[field] !== expected) {
      throw new Error(
        `compiler manifest ${field} must be ${expected}, found ${String(manifest[field])}`,
      );
    }
  }

  const generatedEntry = path.join(managed, "contract/index.js");
  const contract = await Bun.file(generatedEntry).text();
  if (!contract.includes("checkRuntimeVersion('0.19.0')")) {
    throw new Error(
      "generated contract/index.js lacks checkRuntimeVersion('0.19.0')",
    );
  }

  const bzkir = (await Array.fromAsync(
    new Bun.Glob("*.bzkir").scan({ cwd: path.join(managed, "zkir") }),
  )) as string[];
  const keys = (await Array.fromAsync(
    new Bun.Glob("*").scan({ cwd: path.join(managed, "keys") }),
  )) as string[];
  assertExactInventory("bzkir", bzkir, EXPECTED_BZKIR);
  assertExactInventory("key", keys, EXPECTED_KEYS);

  console.log(
    "Compact artifacts OK: compiler 0.34.0, language 0.26.0, runtime 0.19.0, contract/index.js, 3 bzkir, 6 keys",
  );
}

await main();
