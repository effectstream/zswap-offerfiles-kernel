// Can a cross-layer offer EXIST? — the question blocking PR-E (§2.4).
//
// The same-layer rule is unenforced in the ladder, and the suite cannot test
// that because wallet-sdk-facade silently drops the mismatched leg (ISSUES.md
// §3) — so no wallet we have builds one. But a wallet is not the only way to
// make a transaction: balancing IS a merge, and the ledger exposes
// Transaction.merge() directly.
//
// This probe answers the ledger-level question with REAL offers produced by a
// grand run: take a shielded-only offer and an unshielded-only offer, merge
// them, and see what MIP-0006's own derivation says about the result. If the
// merge yields ≥1 give and ≥1 want on DIFFERENT layers, then a cross-layer
// offer is constructible by anyone holding both halves — and an indexer with
// no same-layer rule will accept it.
//
// No stack required: it reads blobs from out/blobs/ and out/ledger.json.
//
//   bun run packages/tests/grand-e2e/probe-cross-layer.ts

import { readFileSync } from "node:fs";
import { Transaction } from "@midnight-ntwrk/ledger-v8";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { P2pAtomicSwaps } from "@effectstream/mip-zswap-offer/mip6";
import { getBlankRefState, validateZswapOfferBytes } from "@zswap-da/validator";
import { midnightNetworkConfig as net } from "@effectstream/midnight-contracts/midnight-env";
import { blobStorePath } from "./actors/wallets.ts";
import { OUT_DIR } from "./config.ts";

const load = (hash: string) => readFileSync(`${blobStorePath()}/${hash}.bech32`, "utf-8").trim();
const deser = (blob: string) =>
  Transaction.deserialize("signature", "proof", "binding", OfferFiles.decode(blob)) as any;

function describe(label: string, tx: any): void {
  const { gives, wants } = P2pAtomicSwaps.deriveTokenLegs(tx);
  const fmt = (l: any[]) => l.map((x) => `${x.type}:${x.token.slice(0, 8)}=${x.amount}`).join(" ") || "(none)";
  console.log(`  ${label}\n    gives: ${fmt(gives)}\n    wants: ${fmt(wants)}`);
}

const ledger = JSON.parse(readFileSync(`${OUT_DIR}ledger.json`, "utf-8"));
const withBlob = (o: any) => o.offerHash && o.state !== "planned" && o.state !== "casualty";
const ss = ledger.offers.find((o: any) => o.layer === "ss" && withBlob(o));
const uu = ledger.offers.find((o: any) => o.layer === "uu" && withBlob(o));
if (!ss || !uu) {
  console.error("need one ss and one uu offer in out/ledger.json — run the suite first");
  process.exit(1);
}

console.log(`shielded  source: offer#${ss.index} ${ss.giveToken}->${ss.wantToken} ${ss.offerHash.slice(0, 12)}`);
console.log(`unshielded source: offer#${uu.index} ${uu.giveToken}->${uu.wantToken} ${uu.offerHash.slice(0, 12)}\n`);

const txSs = deser(load(ss.offerHash));
const txUu = deser(load(uu.offerHash));
console.log("Inputs, as MIP-0006 derives them:");
describe("shielded offer", txSs);
describe("unshielded offer", txUu);

console.log("\nAttempting Transaction.merge(shielded, unshielded)…");
let merged: any;
try {
  merged = txSs.merge(txUu);
} catch (e) {
  console.log(`  REFUSED by the ledger: ${e instanceof Error ? e.message : String(e)}`);
  console.log(
    "\nVERDICT: cross-layer offers may be unconstructible at the ledger level.\n" +
      "If merge is the only route, §2.4 closes without code — but confirm this is a\n" +
      "structural refusal and not an artifact of these two particular offers\n" +
      "(different makers, already-spent inputs, segment-id collisions).",
  );
  process.exit(0);
}

console.log("  MERGED.");
describe("merged transaction", merged);

const { gives, wants } = P2pAtomicSwaps.deriveTokenLegs(merged);
const layers = new Set([...gives, ...wants].map((l: any) => l.type));
const twoSided = P2pAtomicSwaps.isTwoSided(gives, wants);
const crossLayer = layers.size > 1;

console.log(`\n  two-sided: ${twoSided}   layers present: ${[...layers].join(" + ")}`);

// What would OUR ladder say about it? This is the whole point: the structural
// steps run without a DB, so the verdict here is exactly what the STM's
// structural phase would produce.
const v = validateZswapOfferBytes(merged.serialize(), {
  refState: getBlankRefState(net.id),
  tblock: new Date(ss.indexedAt ?? Date.now()),
  maxBytes: 1024 * 1024,
  crypto: "verify", // proofs AND signatures — merge preserves both
});
console.log(`  our validator (FULL ladder, wellFormed included): ${v.ok ? "ACCEPTED" : `rejected ${v.code}`}`);

// §2.5 falls out of the same object. The market queries join per (offer, color)
// filtered to (base, quote), so every give x want combination matches as its own
// "trade" — at a price computed as if the other legs did not exist.
console.log(
  `\n  market impact: ${gives.length} gives x ${wants.length} wants = ` +
    `${gives.length * wants.length} pairs this ONE transaction would register as trades:`,
);
for (const g of gives) {
  for (const w of wants) {
    console.log(
      `    pair(${g.token.slice(0, 6)},${w.token.slice(0, 6)}) price=` +
        `${(Number(w.amount) / Number(g.amount)).toFixed(4)}  [${g.type}->${w.type}]`,
    );
  }
}

console.log(
  `\nVERDICT: ${
    crossLayer && twoSided && v.ok
      ? "cross-layer offers ARE constructible and our ladder ACCEPTS them.\n" +
        "§2.4 is a real, reachable gap: anyone holding both halves can publish one,\n" +
        "and nothing in the ingestion ladder refuses it. PR-E should add CROSS_LAYER."
      : crossLayer && twoSided
        ? `constructible, but our ladder rejects it as ${v.code}.\n` +
          "Check WHY: if the refusal is incidental (a stale root, a spent nullifier)\n" +
          "rather than structural, the gap is still real."
        : "the merge did not produce a two-sided cross-layer offer from these inputs.\n" +
          "Inconclusive — try two offers built for this purpose rather than reused ones."
  }`,
);
