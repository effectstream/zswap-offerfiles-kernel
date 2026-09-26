// Does a merged transaction keep its constituent zswaps SEPARABLE?
//
// The proposal: an individual zswap is a sealed balance (-N +M). If two are
// merged into one transaction, the accounting unit should still be each sealed
// balance, not the flattened whole. That eliminates the fabricated cross pairs
// by construction and counts each -N/+M once.
//
// It only works if the segments survive the merge. MIP-0006's deriveTokenLegs
// deliberately FLATTENS across segments (derive.ts: "the codec already nets per
// (color, layer) … the authoritative semantics"), so this asks the ledger
// directly: what does imbalances(segId) return, per segment, before flattening?

import { readFileSync } from "node:fs";
import { Transaction } from "@midnightntwrk/ledger-v9";
import { OfferFiles } from "@effectstream/mip-zswap-offer/mip5";
import { blobStorePath } from "./actors/wallets.ts";
import { OUT_DIR } from "./config.ts";

const load = (h: string) => readFileSync(`${blobStorePath()}/${h}.bech32`, "utf-8").trim();
const deser = (b: string) =>
  Transaction.deserialize("signature", "proof", "binding", OfferFiles.decode(b)) as any;

const L = JSON.parse(readFileSync(`${OUT_DIR}ledger.json`, "utf-8"));
const wb = (o: any) => o.offerHash && o.state !== "planned" && o.state !== "casualty";
const ss = L.offers.find((o: any) => o.layer === "ss" && wb(o));
const uu = L.offers.find((o: any) => o.layer === "uu" && wb(o));

function segments(label: string, tx: any): void {
  const intentKeys = tx.intents ? Array.from(tx.intents.keys() as Iterable<number>) : [];
  const fallibleKeys = tx.fallibleOffer ? Array.from(tx.fallibleOffer.keys() as Iterable<number>) : [];
  const ids = Array.from(new Set<number>([0, ...intentKeys, ...fallibleKeys]));
  console.log(`\n${label}  segments: [${ids.join(", ")}]`);
  for (const id of ids) {
    const rows: string[] = [];
    for (const [tt, delta] of tx.imbalances(id)) {
      const t = tt as any;
      if (t.tag === "dust") continue;
      rows.push(`${t.tag}:${String(t.raw).slice(0, 8)}=${delta > 0n ? "+" : ""}${delta}`);
    }
    console.log(`  segment ${id}: ${rows.length ? rows.join("  ") : "(empty / dust only)"}`);
  }
}

segments("shielded offer alone", deser(load(ss.offerHash)));
segments("unshielded offer alone", deser(load(uu.offerHash)));
segments("MERGED", deser(load(ss.offerHash)).merge(deser(load(uu.offerHash))));

console.log(
  "\nIf the merged transaction shows the two sealed balances in DIFFERENT segments,\n" +
    "per-segment attribution recovers the real pairs and drops the fabricated ones.\n" +
    "If they collapse into one segment, the merge is lossy and the constituent\n" +
    "zswaps cannot be recovered from the bytes — the accounting unit has to be\n" +
    "decided some other way.",
);
