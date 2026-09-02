/**
 * Build the direct-Celestia invalid corpus from the sealed real actor offer.
 *
 * This is a test-only one-shot. It does not publish anything and it does not
 * mock validation: the proof-tampered fixture is locally decoded and sent
 * through the production validator's full crypto path before the bytes are
 * released to the publisher service.
 */

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { getBlankRefState, validateZswapOffer } from "@zswap-da/validator";

const SCHEMA = "zswap-offer-files-real-invalid-fixtures/v1";
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_OFFER_BYTES = 1024 * 1024;

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function absolutePath(name: string): string {
  const value = required(name);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function runId(): string {
  const value = required("E1_RUN_ID");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(value)) {
    throw new Error("E1_RUN_ID has invalid syntax");
  }
  return value;
}

async function privateRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${path} must be a non-symlink regular file`);
  }
  if ((metadata.mode & 0o777) !== 0o600) throw new Error(`${path} must have mode 0600`);
  if (metadata.size < 1 || metadata.size > maximumBytes) {
    throw new Error(`${path} size is outside [1, ${maximumBytes}]`);
  }
  return readFile(path);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function tamperProofBytes(raw: Uint8Array): Uint8Array {
  if (raw.byteLength < 64) throw new Error("real offer is too short for a proof-only tamper");
  const copy = Uint8Array.from(raw);
  const start = Math.floor(copy.length * 0.97);
  for (let index = start; index < Math.min(copy.length, start + 8); index += 1) {
    copy[index] = copy[index]! ^ 0xff;
  }
  return copy;
}

export function deterministicNonNulGarbage(bytes = 600): Uint8Array {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 64 * 1024) {
    throw new Error("garbage byte count must be in [1, 65536]");
  }
  const value = new Uint8Array(bytes);
  for (let index = 0; index < value.length; index += 1) {
    value[index] = 1 + ((index * 131 + 17) % 255);
  }
  return value;
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    const source = await handle.stat();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    // link(2) publishes without replacement: a pre-existing or concurrently
    // created authority file makes this operation fail closed with EEXIST.
    await link(temporary, path);
    const published = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const final = await published.stat();
      const finalBytes = await published.readFile();
      if (!final.isFile() || final.dev !== source.dev || final.ino !== source.ino ||
        (final.mode & 0o777) !== 0o600 || !finalBytes.equals(bytes)) {
        throw new Error(`${path} did not retain the sealed inode/mode/bytes`);
      }
    } finally {
      await published.close();
    }
    const directoryHandle = await open(dirname(path), constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    throw new Error(`could not publish sealed invalid-fixture artifact ${path}`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export async function buildRealInvalidFixtures(): Promise<Record<string, unknown>> {
  if (net.id !== "undeployed") {
    throw new Error(`real invalid fixtures require MIDNIGHT_NETWORK_ID=undeployed, got ${net.id}`);
  }
  const expectedRunId = runId();
  const manifestPath = absolutePath("E1_ACTOR_RESULT_PATH");
  const preSpentPath = absolutePath("E1_PRE_SPENT_PATH");
  const outputPath = absolutePath("E1_INVALID_FIXTURE_PATH");
  if (new Set([manifestPath, preSpentPath, outputPath]).size !== 3) {
    throw new Error("fixture output and sealed actor inputs must use distinct paths");
  }

  const manifestBytes = await privateRegularFile(manifestPath, MAX_MANIFEST_BYTES);
  const manifest = record(JSON.parse(manifestBytes.toString("utf8")), "actor manifest");
  if (manifest.runId !== expectedRunId || manifest.networkId !== "undeployed") {
    throw new Error("actor manifest identity does not match the invalid-fixture run");
  }
  const offer = record(manifest.offer, "actor manifest.offer");
  const offerBlob = offer.offerBlob;
  const offerHash = offer.offerHash;
  if (typeof offerBlob !== "string" || typeof offerHash !== "string" || !/^[0-9a-f]{64}$/.test(offerHash)) {
    throw new Error("actor manifest has no canonical offer blob/hash");
  }
  const raw = OfferFiles.decode(offerBlob);
  if (raw.byteLength < 1 || raw.byteLength > MAX_OFFER_BYTES || sha256(raw) !== offerHash) {
    throw new Error("actor offer raw bytes do not match its content address");
  }

  const preSpentBytes = await privateRegularFile(preSpentPath, MAX_MANIFEST_BYTES);
  const preSpent = record(JSON.parse(preSpentBytes.toString("utf8")), "pre-spent liveness artifact");
  if (preSpent.schema !== "zswap-offer-files-real-pre-spent-liveness/v1" ||
    preSpent.runId !== expectedRunId || preSpent.networkId !== "undeployed") {
    throw new Error("pre-spent liveness identity does not match the invalid-fixture run");
  }
  if (typeof preSpent.offerBlob !== "string" || typeof preSpent.rawBase64 !== "string" ||
    typeof preSpent.offerHash !== "string" || !/^[0-9a-f]{64}$/.test(preSpent.offerHash)) {
    throw new Error("pre-spent liveness artifact has no canonical offer encoding/hash");
  }
  const preSpentRaw = Buffer.from(preSpent.rawBase64, "base64");
  if (preSpentRaw.byteLength < 1 || preSpentRaw.byteLength > MAX_OFFER_BYTES ||
    preSpentRaw.toString("base64") !== preSpent.rawBase64 ||
    !Buffer.from(OfferFiles.decode(preSpent.offerBlob)).equals(preSpentRaw) ||
    sha256(preSpentRaw) !== preSpent.offerHash) {
    throw new Error("pre-spent liveness bech32/raw/hash binding is invalid");
  }

  const proofInvalidRaw = tamperProofBytes(raw);
  const proofInvalidBlob = OfferFiles.encode(proofInvalidRaw);
  const proofVerdict = validateZswapOffer(proofInvalidBlob, {
    refState: getBlankRefState(net.id),
    tblock: new Date(),
    maxBytes: MAX_OFFER_BYTES,
    crypto: "verify",
  });
  if (proofVerdict.ok || !["PROOF_INVALID", "SIGNATURE_INVALID"].includes(proofVerdict.code ?? "")) {
    throw new Error(`proof-tampered offer rejected for unexpected code ${proofVerdict.code ?? "OK"}`);
  }
  const garbage = deterministicNonNulGarbage();
  const result = {
    schema: SCHEMA,
    runId: expectedRunId,
    networkId: net.id,
    actorManifest: {
      sha256: sha256(manifestBytes),
      offerHash,
    },
    preSpentLiveness: {
      artifactSha256: sha256(preSpentBytes),
      offerHash: preSpent.offerHash,
      rawBase64: preSpent.rawBase64,
      bytes: preSpentRaw.byteLength,
    },
    validReplay: {
      rawBase64: Buffer.from(raw).toString("base64"),
      bytes: raw.byteLength,
      sha256: offerHash,
    },
    proofInvalid: {
      rawBase64: Buffer.from(proofInvalidRaw).toString("base64"),
      bytes: proofInvalidRaw.byteLength,
      sha256: sha256(proofInvalidRaw),
      localCryptoVerdict: proofVerdict.code,
    },
    arbitraryGarbage: {
      rawBase64: Buffer.from(garbage).toString("base64"),
      bytes: garbage.byteLength,
      sha256: sha256(garbage),
      nulBytes: 0,
    },
  };
  await writePrivateJson(outputPath, result);
  return result;
}

if (import.meta.main) {
  if (process.argv[2] !== "build") {
    throw new Error("usage: solver-offerfiles-real-invalid-fixtures.ts build");
  }
  buildRealInvalidFixtures()
    .then((result) => {
      console.log(JSON.stringify({
        schema: result.schema,
        runId: result.runId,
        status: "PASS",
      }));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
