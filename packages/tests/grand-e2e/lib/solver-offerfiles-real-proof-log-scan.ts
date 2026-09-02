const DEBUG_OR_TRACE = /\b(?:DEBUG|TRACE)\b/i;

function fail(label: string, detail: string): never {
  throw new Error(`${label}: ${detail}`);
}

/** Signatures that are unsafe regardless of which service emitted them. */
export function assertNoProofMaterialLogSignatures(label: string, text: string): void {
  if (/Received request:/i.test(text)) fail(label, "raw proving request signature detected");
  if (/\bwitness\b/i.test(text)) fail(label, "witness material signature detected");
  if (/[0-9a-fA-F]{4096,}/.test(text)) fail(label, "long hexadecimal proving payload detected");
}

/** Direct `docker logs` output from the proof container has authoritative provenance. */
export function assertDirectProofLogSafe(label: string, text: string): void {
  assertNoProofMaterialLogSignatures(label, text);
  if (DEBUG_OR_TRACE.test(text)) fail(label, "proof DEBUG/TRACE output detected");
}

function composeProofServiceLine(line: string): boolean {
  const pipe = line.indexOf("|");
  if (pipe < 0) return false;
  const service = line.slice(0, pipe).trim();
  return /(?:^|[-_])proof-server(?:[-_][0-9]+)?$/i.test(service);
}

/** Mixed Compose output rejects DEBUG/TRACE only when the line is proof-service attributed. */
export function assertMixedComposeProofLogSafe(label: string, text: string): void {
  assertNoProofMaterialLogSignatures(label, text);
  for (const line of text.split(/\r?\n/)) {
    if (composeProofServiceLine(line) && DEBUG_OR_TRACE.test(line)) {
      fail(label, "proof-prefixed DEBUG/TRACE output detected");
    }
  }
}
