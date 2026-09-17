import { MidnightBalancingAdapter } from "@effectstream/batcher-sdk";
import { waitForDustFundsWithRetry } from "@effectstream/midnight-contracts";
import type { BatcherConfig } from "./config.ts";
import {
  BATCHER_NIGHT_UTXO_TARGET,
  ensureBatcherNightUtxos,
} from "./night-utxo-bootstrap.ts";

export function createMidnightBalancingAdapter(
  batcherConfig: BatcherConfig,
): MidnightBalancingAdapter {
  // Why this approach instead of passing a `walletResult` built by buildWalletFacade:
  //
  // Midnight Preview has ~83k historical dust commitment entries. The wallet must
  // scan them all to find recently-registered dust UTXOs. The default path uses
  // stallTimeoutMs=60s and maxRetries=5, covering only ~6k entries before giving up.
  //
  // waitForDustFundsWithRetry with stallTimeoutMs=7_200_000 (2h) lets the entire
  // 81-minute scan finish in a single attempt without a false stall. It also saves
  // state to dust-state/ on disk, so a restart resumes from where it left off
  // (via the batcher_dust Docker volume).
  const firstSeed = Array.isArray(batcherConfig.walletSeed)
    ? batcherConfig.walletSeed[0]!
    : batcherConfig.walletSeed;

  const networkUrls = {
    id: batcherConfig.midnight.id,
    indexer: batcherConfig.midnight.indexer,
    indexerWS: batcherConfig.midnight.indexerWS,
    node: batcherConfig.midnight.node,
    proofServer: batcherConfig.midnight.proofServer,
  };

  const devBootstrap = batcherConfig.midnight.id === "undeployed";
  const walletResultPromise = waitForDustFundsWithRetry(
    {
      networkUrls: networkUrls as any,
      seed: firstSeed,
      networkId: batcherConfig.midnight.id as any,
      // The dev bootstrap needs the unshielded wallet long enough to inspect
      // and, when necessary, self-split NIGHT. The adapter suspends the two
      // auxiliary wallet syncs after this promise resolves. Deployed networks
      // keep the cheaper dust-only path.
      syncMode: devBootstrap ? "all" : "dust-only",
      stallTimeoutMs: 7_200_000,  // 2h per attempt — enough for the full 81-min scan
      maxRetries: 3,
    },
  ).then(async ({ walletResult }) => {
    if (devBootstrap) {
      const ready = await ensureBatcherNightUtxos(walletResult, {
        target: BATCHER_NIGHT_UTXO_TARGET,
        minSpendableDustPerCoin: batcherConfig.minSpendableDustPerCoin,
      });
      console.log(
        `[zswap-da-batcher] NIGHT bootstrap: ${ready.registeredNightUtxos} registered UTXOs, ` +
          `${ready.spendableDustUtxos} spendable dust streams${ready.split ? " (self-split)" : ""}`,
      );
    }
    if (allowContractTx()) {
      installContractTxValidationLane(walletResult, batcherConfig.midnight.id);
    }
    return walletResult;
  });

  return new MidnightBalancingAdapter([firstSeed], {
    indexer: batcherConfig.midnight.indexer,
    indexerWS: batcherConfig.midnight.indexerWS,
    node: batcherConfig.midnight.node,
    proofServer: batcherConfig.midnight.proofServer,
    walletNetworkId: batcherConfig.midnight.id,
    syncProtocolName: "parallelMidnight",
    walletResult: walletResultPromise as any,
    walletFundingTimeoutSeconds: 7200,
    // Concurrency ceiling. Real slots = min(floor(dustUtxos/costPerTx), this);
    // one wallet with one big NIGHT UTXO still gets one slot, so raising this
    // only helps once the wallet's NIGHT is split into multiple dust UTXOs.
    maxSlotsPerWallet: batcherConfig.maxSlotsPerWallet,
    // #847 hardening: value-aware dust gate, wait budget, intake size cap.
    // undefined defers to SDK defaults (1.5x wallet overhead / 60s / 500k).
    dustWaitTimeoutMs: batcherConfig.dustWaitTimeoutMs,
    minSpendableDustPerCoin: batcherConfig.minSpendableDustPerCoin,
    maxInputChars: batcherConfig.maxInputChars,
  });
}

// ── contract-transaction validation lane ────────────────────────────────────
//
// The balancing adapter validates every merged transaction through the wallet
// facade, whose validation service checks wellFormed against a BLANK ledger
// state. A blank state cannot hold any contract's verifier keys, so a
// delegated transaction that CALLS a contract (e.g. the zswap-da frontend's
// faucet mint) always fails with "call to non-existant contract" — the same
// failure class packages/validator/validate.ts handles for contract-maker
// offers. Mirror that lane here: strict validation runs first, and ONLY the
// exact missing-contract failure widens to a retry with
// verifyContractProofs=false. Native zswap/dust proofs and signatures are
// still verified on the retry; the contract-call proof is verified by the
// node at settlement. Opt-in via BATCHER_ALLOW_CONTRACT_TX, matching the
// kernel's ALLOW_CONTRACT_MAKER_OFFERS pattern.
export function allowContractTx(): boolean {
  return process.env["BATCHER_ALLOW_CONTRACT_TX"] === "true";
}

const MISSING_CONTRACT_RE = /non-existant contract|non-existent contract/i;

function causeChain(error: unknown): string {
  const parts: string[] = [];
  let cursor: unknown = error;
  for (let i = 0; i < 8 && cursor; i++) {
    parts.push(String((cursor as { message?: unknown }).message ?? cursor));
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return parts.join(" <- ");
}

export function installContractTxValidationLane(
  // The facade type is structural here on purpose: the adapter only needs
  // validateTransaction to keep its (tx, options) contract.
  walletResult: { wallet: any },
  networkId: string,
): void {
  const wallet = walletResult.wallet;
  const strictValidate = wallet.validateTransaction.bind(wallet);
  wallet.validateTransaction = async (tx: any, options: any) => {
    try {
      return await strictValidate(tx, options);
    } catch (error) {
      const chain = causeChain(error);
      if (!MISSING_CONTRACT_RE.test(chain)) throw error;
      const parameters = options?.blockData?.ledgerParameters;
      if (!parameters) throw error; // fail closed without real limits/params
      const { LedgerState, WellFormedStrictness } = await import(
        "@midnightntwrk/ledger-v9"
      );
      const state = LedgerState.blank(networkId);
      state.parameters = parameters;
      const strictness = new WellFormedStrictness();
      strictness.enforceBalancing = options?.flags?.enforceBalancing ?? true;
      strictness.verifySignatures = options?.flags?.verifySignatures ?? true;
      strictness.enforceLimits = options?.flags?.enforceLimits ?? true;
      strictness.verifyContractProofs = false;
      tx.wellFormed(state, strictness, new Date());
      console.log(
        "[zswap-da-batcher] contract-tx lane: wellFormed passed with " +
          "verifyContractProofs=false (missing-contract retry; node verifies " +
          "the contract proof at settlement)",
      );
    }
  };
}
