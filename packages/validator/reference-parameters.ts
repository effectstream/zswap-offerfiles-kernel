// Pinned ledger parameters per Midnight network — the reference state the
// offer validator checks `Transaction.wellFormed` against (00056 FR-001).
//
// Why pinned bytes and not a live read: the state machine must reach the same
// verdict on every kernel and on every replay, so the parameters it validates
// with are part of the code, selected by MIDNIGHT_NETWORK_ID. `global_ttl` is
// static per network (changing it is a hard fork), and it is the only
// parameter the validator's checks depend on today (the intent TTL bound,
// `tblock <= ttl <= tblock + global_ttl`, midnight-ledger
// `ledger-9.1.0.0-rc.3` ledger/src/verify.rs:632-635 and :1721-1742). The
// DUST grace period is read from here too (state-machine expiry derivation).
//
// Why not `LedgerState.blank(networkId)`: a blank state carries the ledger's
// INITIAL_PARAMETERS, whose `global_ttl` is 3600 s, so a validator on a blank
// state refuses every intent TTL more than one hour ahead, although every
// network accepts up to 1,209,600 s (14 days).
//
// `LedgerParameters` has no public constructor, so each entry is the
// serialized `LedgerParameters` (`midnight:ledger-parameters[v8]:` — ledger 9)
// with its provenance. Both decode to `global_ttl` = 1,209,600 s and
// `dust_grace_period` = 10,800 s (reference-parameters.test.ts pins this).
//
// Only ledger-9 networks can appear here: preview, preprod and mainnet still
// run ledger 8 (`ledger-parameters[v5]`, protocol 1000xxx on 2026-09-27),
// whose bytes this ledger-v9 build refuses, and whose transactions it cannot
// deserialize either. An id without an entry fails at startup
// (refstate.ts `requireReferenceParameters`).

export interface ReferenceParametersSnapshot {
  /** Midnight network id (`MIDNIGHT_NETWORK_ID`). */
  readonly networkId: string;
  /** Serialized `LedgerParameters`, lowercase hex. */
  readonly hex: string;
  /** sha256 of the serialized bytes (not of the hex text). */
  readonly sha256: string;
  /** Where the bytes came from, precisely enough to re-derive them. */
  readonly source: string;
}

export const REFERENCE_PARAMETERS: Readonly<Record<string, ReferenceParametersSnapshot>> = Object.freeze({
  // The local devnet's node: midnight-node tag `node-2.0.0-rc.4` (the dev node
  // in effectstream/binaries 0.3.120), `res/genesis/genesis_state_undeployed.mn`
  // (sha256 7185bc999e77163db6f0b99ea384b7491b1f48eda738455bf044c071b0e44936,
  // `ledger-state[v18]`), `LedgerState.deserialize(...).parameters.serialize()`.
  undeployed: Object.freeze({
    networkId: "undeployed",
    hex:
    "6d69646e696768743a6c65646765722d706172616d65746572735b76385d3ac64a0600008e0a8c0072618b007eed6000" +
    "4ec66a008ef07200feaf7200f6d97c00a247090156426700c647eb00161f30005a1469008a7ab1005e5f74005298b100" +
    "762490008abe8d008e4d7300d208840000466dba00e507fed717b0b25a040000163c060000da4f5000d2726f009e0e65" +
    "0066552a0015065ec12a000d068abc7700d27877000a1c10007ec71a00ba0cab000afb1800567e9300f200100052dd1a" +
    "005e58ab00aa0f19007a1094005aee26001c624d060000824c9500763c8c000a4b7600e96df69ca80015660a5a81019d" +
    "64004e4f2f0249c07212bd00004a586c0392ab6e175ee1200251c10241bd0000f2613903421045170a87e60012d65f00" +
    "9248a200b6e55b00664599022a1a01005aa30100b622240200b56bd2f661026e4d760385fa00fe75470259f5ed236628" +
    "0c03fe61940286150100314a1e86fa01aa46010049209e8b6402d6606e0389fc00e2e21f029d4c3d427e550703e6704c" +
    "0a0e910200ce3a140100b28587038a891f17226ffc05d6f96506ea8201003a2a43010082f361028aa450187e622b066e" +
    "3f060002ff3217d54926142a420320c6305b034df61ec3f2051601aa90d15012f316001e3e791e82759d140076447102" +
    "ea503eb0bae1912312eea6549608753602127a0002fd4314000284d71700000000000000000040000000000000000000" +
    "000000000000000100000000000000000000000000000001000000000000000200400002127a000700d6117e030b0020" +
    "4aa9d1010b00204aa9d10102093d00420d030002c2eb0b00000000000000800000000000000000020080020700f2052a" +
    "012d81302a000000000000000000000000000000000000000000000a0000000000000025d4d53c1379effc0000000000" +
    "000000ccc0fdbed66917ff000000000000000019d3a8865c58ac010100000000000000f597837db9c44c020100000000" +
    "000000007512000000000000000000000000000000000000000040000000000000000000000000000000006400000000" +
    "000000d107a10f00000000000000000a00000000000000",
    sha256: "d7d5f27e5dba936f21c14a8a8a1d5128c65f17fd09b2958c5b3c3593a94cd708",
    source:
      "midnight-node node-2.0.0-rc.4 res/genesis/genesis_state_undeployed.mn " +
      "(sha256 7185bc999e77163db6f0b99ea384b7491b1f48eda738455bf044c071b0e44936), .parameters",
  }),
  // The live chain: stagenet indexer `{ block { ledgerParameters } }` at block
  // 637,700 (808f87ca70f3c822342c3fc9435b9e00a2208fc65807ec52f1654d8ab187ee97),
  // 2026-09-26 — the same bytes as packages/node/test-support/
  // stagenet-ledger-parameters.hex (00055). It differs from the node-2.0.0-rc.4
  // stagenet genesis parameters only in the four fee-price factors.
  stagenet: Object.freeze({
    networkId: "stagenet",
    hex:
    "6d69646e696768743a6c65646765722d706172616d65746572735b76385d3ac64a0600008e0a8c0072618b007eed6000" +
    "4ec66a008ef07200feaf7200f6d97c00a247090156426700c647eb00161f30005a1469008a7ab1005e5f74005298b100" +
    "762490008abe8d008e4d7300d208840000466dba00e507fed717b0b25a040000163c060000da4f5000d2726f009e0e65" +
    "0066552a0015065ec12a000d068abc7700d27877000a1c10007ec71a00ba0cab000afb1800567e9300f200100052dd1a" +
    "005e58ab00aa0f19007a1094005aee26001c624d060000824c9500763c8c000a4b7600e96df69ca80015660a5a81019d" +
    "64004e4f2f0249c07212bd00004a586c0392ab6e175ee1200251c10241bd0000f2613903421045170a87e60012d65f00" +
    "9248a200b6e55b00664599022a1a01005aa30100b622240200b56bd2f661026e4d760385fa00fe75470259f5ed236628" +
    "0c03fe61940286150100314a1e86fa01aa46010049209e8b6402d6606e0389fc00e2e21f029d4c3d427e550703e6704c" +
    "0a0e910200ce3a140100b28587038a891f17226ffc05d6f96506ea8201003a2a43010082f361028aa450187e622b066e" +
    "3f060002ff3217d54926142a420320c6305b034df61ec3f2051601aa90d15012f316001e3e791e82759d140076447102" +
    "ea503eb0bae1912312eea6549608753602127a0002fd4314000284d71700000000000000000040000000000000000000" +
    "000000000000000100000000000000000000000000000001000000000000000200400002127a000700d6117e030b0020" +
    "4aa9d1010b00204aa9d10102093d00420d030002c2eb0b00000000000000800000000000000000020080020700f2052a" +
    "012d81302a000000000000000000000000000000000000000000000a0000000000000049922449922449920000000000" +
    "000000499224499224499200000000000000004992244992244992000000000000000024499224499224490200000000" +
    "000000007512000000000000000000000000000000000000000040000000000000000000000000000000006400000000" +
    "000000d107a10f00000000000000000a00000000000000",
    sha256: "27eb882109310560df1a1bed6109a85999ae27cf7453c234163a178abad850d5",
    source:
      "stagenet indexer https://indexer.stagenet.shielded.tools/api/v4/graphql block 637700 " +
      "(808f87ca70f3c822342c3fc9435b9e00a2208fc65807ec52f1654d8ab187ee97), ledgerParameters, 2026-09-26",
  }),
});
