// Pinned ledger parameters per Midnight network: the reference state the
// offer validator checks `Transaction.wellFormed` against.
//
// Why pinned bytes and not a live read: the state machine must reach the same
// verdict on every kernel and on every replay, so the parameters it validates
// with are part of the code, selected by MIDNIGHT_NETWORK_ID. The validator's
// checks depend on `global_ttl`, the intent TTL bound
// `tblock <= ttl <= tblock + global_ttl` (midnight-ledger `ledger-9.1.0.0`,
// ledger/src/verify.rs:641-645 and :1731-1750). The state machine also reads
// the DUST grace period from here (offer expiry derivation).
//
// Why not `LedgerState.blank(networkId)`: a blank state carries the ledger's
// INITIAL_PARAMETERS, whose `global_ttl` is 3600 s
// (ledger/src/structure.rs:1371), so a validator on a blank state refuses
// every intent TTL more than one hour ahead, although every network accepts
// up to 1,209,600 s (14 days).
//
// `LedgerParameters` has no public constructor, so each entry is the
// serialized `LedgerParameters` (`midnight:ledger-parameters[v8]:`, ledger 9)
// with its provenance. Every entry decodes to `global_ttl` = 1,209,600 s and
// `dust_grace_period` = 10,800 s (reference-parameters.test.ts pins this).
//
// A live chain's parameters change from block to block in `fee_prices` only:
// the ledger moves the four price factors after each block. A snapshot is
// therefore "the parameters at block N", and its sha256 equals the live
// chain's only while those factors stay put. Fee prices play no part in the
// validator's verdicts (open offers are checked with balancing off).
//
// An id without an entry fails at startup (refstate.ts
// `requireReferenceParameters`). A network the kernel supports but has not
// pinned yet is listed in UNPINNED_REFERENCE_PARAMETERS below with the reason,
// so its startup error says "not pinned yet" instead of "unknown network".
//
// This module has no imports on purpose: the startup profiles read it before
// the ledger WASM or midnight-env is loaded.

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

/**
 * Keyed by network id, in the order the startup error lists them. Live
 * networks name the block they were read at; re-derive one with the indexer
 * query `{ block(offset: { height: N }) { hash ledgerParameters } }` or the
 * node RPC `state_call("MidnightRuntimeApi_get_ledger_parameters", "0x",
 * <block hash>)` (a SCALE `Ok(Vec<u8>)` around the same bytes).
 */
export const REFERENCE_PARAMETERS: Readonly<Record<string, ReferenceParametersSnapshot>> = Object.freeze({
  // The local devnet. midnight-node `2.1.0-806ff70-ledger9final`
  // (effectstream/binaries release 0.3.120, built from midnight-node
  // `release/node-2.1.0` @ 806ff702f74908503c674035f478eb43d9539239) compiles
  // `res/genesis/genesis_state_undeployed.mn` into its dev chain spec; the
  // linux arm64 and amd64 binaries both embed that file byte for byte. The
  // entry is `LedgerState.deserialize(file).parameters.serialize()`. It
  // differs from the public networks' parameters in `max_contract_metadata_size`
  // (10,485,760 instead of 50,000) and in the fee prices.
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
      "midnight-node 2.1.0-806ff70-ledger9final (effectstream/binaries 0.3.120; source " +
      "release/node-2.1.0 @ 806ff702f74908503c674035f478eb43d9539239) " +
      "res/genesis/genesis_state_undeployed.mn " +
      "(sha256 203123b300a29319040208b420251738e1c1b5e01c644ea67d87da9b706df4d2, ledger-state[v18]), " +
      ".parameters, read 2026-11-09",
  }),
  // The public preview chain (node 2.1.101, runtime spec 2001100), read from
  // the Midnight-hosted indexer at its tip on 2026-11-09. The node RPC's
  // `MidnightRuntimeApi_get_ledger_parameters` at the same block hash
  // (https://rpc.preview.midnight.network) returned the same bytes.
  preview: Object.freeze({
    networkId: "preview",
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
    "4aa9d1010b00204aa9d10102093d00420d030002c2eb0b00000000000000800000000000000000420d03000700f2052a" +
    "012d81302a000000000000000000000000000000000000000000000a000000000000009881701be6d127920000000000" +
    "0000009881701be6d12792000000000000000071f65c5b9b14119300000000000000005f06c26d98479f480200000000" +
    "000000007512000000000000000000000000000000000000000040000000000000000000000000000000006400000000" +
    "000000d107a10f00000000000000000a00000000000000",
    sha256: "a6e7a3192b21b75725038921a88074211fc75bd56106851a8797c8d1f579a4a1",
    source:
      "preview indexer https://indexer.preview.midnight.network/api/v4/graphql block 40171 " +
      "(ef0ad3d78498a5bf0f4573f489f22210ca77f7d6cb0f2c57efe940e25d9ab504, 2026-11-09T20:02:06Z), " +
      "ledgerParameters, read 2026-11-09",
  }),
  // The public preprod chain (node 2.1.101, runtime spec 2001100), read from
  // the Blockfrost indexer at its tip on 2026-11-09 (the endpoint takes a
  // per-project token in `project_id`; it is not part of the provenance). The
  // Blockfrost node RPC's `MidnightRuntimeApi_get_ledger_parameters` at the
  // same block hash returned the same bytes.
  preprod: Object.freeze({
    networkId: "preprod",
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
    "4aa9d1010b00204aa9d10102093d00420d030002c2eb0b00000000000000800000000000000000420d03000700f2052a" +
    "012d81302a000000000000000000000000000000000000000000000a00000000000000420e6112fdae40700000000000" +
    "00000061f9a57e66560398000000000000000058bf7425a83eb936010000000000000006398449f4bb02c10100000000" +
    "000000007512000000000000000000000000000000000000000040000000000000000000000000000000006400000000" +
    "000000d107a10f00000000000000000a00000000000000",
    sha256: "2d96bd99f58d85d54dd6474a5e391405fe0ddbacf4dcebff78f7476b0f7daaf3",
    source:
      "preprod indexer https://midnight-preprod.blockfrost.io/api/v0 block 3352707 " +
      "(a0e9d746493144e8c719804f37e5ae7165d5a3fd87c2d6f322f3b5f04b8ee508, 2026-11-09T20:01:30Z), " +
      "ledgerParameters, read 2026-11-09",
  }),
  // TODO(mainnet): pin mainnet's ledger-9 parameters here. They are not
  // pinned yet. The mainnet genesis in midnight-node is a ledger-8 state
  // (`ledger-state[v13]`, which this ledger-v9 build refuses), so the ledger-9
  // bytes exist only on the live chain: the node runtime API
  // `MidnightRuntimeApi_get_ledger_parameters`, called with `state_call` at a
  // block hash, returns them. Add a `mainnet` entry with the block hash,
  // height and date of the read and the sha256 of the bytes, and remove
  // `mainnet` from UNPINNED_REFERENCE_PARAMETERS. Until then
  // MIDNIGHT_NETWORK_ID=mainnet stops at startup (node and batcher).
});

/**
 * Networks the kernel supports whose parameters are not pinned yet, with the
 * reason. Every service refuses to start on them, naming the reason, instead
 * of reporting an unknown network. An id is never both here and in
 * REFERENCE_PARAMETERS.
 */
export const UNPINNED_REFERENCE_PARAMETERS: Readonly<Record<string, string>> = Object.freeze({
  mainnet:
    "mainnet's ledger-9 parameters exist only on the live chain (the node runtime API " +
    "MidnightRuntimeApi_get_ledger_parameters returns them at a block hash) and none has been pinned",
});
