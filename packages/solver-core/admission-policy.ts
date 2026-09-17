// The one typed job-admission policy (spec 00005 FR-002, finding P4-F02).
//
// WHY THIS MODULE EXISTS. The policy used to be re-declared field by field at
// every layer it crossed — config (`env.ts`), publication
// (`RelayLadderOptions` → `LadderPushOptions` → `DeriveLadderOptions`) and
// executor admission — and forwarded by hand-rolled conditional spreads. That
// is exactly how P4-F02 happened: `run.ts` passed `supportedPairs`/
// `minJobOutput` into the relay client's `ladder:` bag, `RelayLadderOptions`
// never declared them, `runPush` never forwarded them, and the solver published
// a ladder for pairs and sizes its own executor would refuse. Nothing about
// that was visible at runtime — the fields simply evaporated.
//
// So the policy is ONE interface that every layer EXTENDS, plus ONE forwarding
// function. Two consequences, both deliberate:
//
//   * a new policy field is added in one place and reaches every layer,
//     because `forwardAdmissionPolicy` iterates `ADMISSION_POLICY_FIELDS`
//     rather than naming fields, and the tuple is checked against
//     `keyof JobAdmissionPolicy` at COMPILE time (see `_fieldsAreExhaustive`);
//   * no layer may narrow the policy to a subset of its fields, because it
//     inherits the declarations instead of restating them.
//
// This module is intentionally dependency-free and pure: it is imported by the
// pure derivation core, by the relay client, and by the executor.

/**
 * The static economic admission policy, in the shape every layer sees it.
 *
 * `null` and `undefined` both mean OPEN for a field — the Q-RF-2 amendment lets
 * an operator run without one of these groups, and `loadSolverAdmissionEnv`
 * reports every open group as a recurring warning. A SUPPLIED value is always
 * enforced, at publication and again at admission.
 */
export interface JobAdmissionPolicy {
  /** Directed allowlist keyed by `admissionPairKey(tokenIn, tokenOut)`. */
  supportedPairs?: ReadonlySet<string> | null;
  /** Per-output-token minimum job output. A supplied map requires every output
   *  token to appear in it; an absent token is a refusal, not a default. */
  minJobOutput?: ReadonlyMap<string, bigint> | null;
}

/**
 * Every field of `JobAdmissionPolicy`, in a fixed order.
 *
 * The single list `forwardAdmissionPolicy` walks. Adding a field to the
 * interface without adding it here is a COMPILE error (`_fieldsAreExhaustive`
 * below), which is the guard P4-F02 lacked.
 */
export const ADMISSION_POLICY_FIELDS = ["supportedPairs", "minJobOutput"] as const;

/** Compile-time exhaustiveness: resolves to `true` only while
 *  `ADMISSION_POLICY_FIELDS` covers every key of `JobAdmissionPolicy`. */
type _FieldsAreExhaustive =
  Exclude<keyof JobAdmissionPolicy, (typeof ADMISSION_POLICY_FIELDS)[number]> extends never
    ? true
    : never;
const _fieldsAreExhaustive: _FieldsAreExhaustive = true;
void _fieldsAreExhaustive;

/**
 * The ONLY sanctioned way to hand the policy from one layer to the next.
 *
 * Returns a fresh object carrying every declared field the source actually
 * defines, so it can be spread into an options bag without turning an absent
 * field into an explicit `undefined` (which `exactOptionalPropertyTypes`
 * rejects and which reads as "configured open" rather than "not configured").
 */
export function forwardAdmissionPolicy(policy: JobAdmissionPolicy): JobAdmissionPolicy {
  const forwarded: Record<string, unknown> = {};
  for (const field of ADMISSION_POLICY_FIELDS) {
    const value = policy[field];
    if (value !== undefined) forwarded[field] = value;
  }
  return forwarded as JobAdmissionPolicy;
}

/**
 * The directed-pair key `SOLVER_SUPPORTED_PAIRS` is written in and both the
 * derivation and the executor match against.
 *
 * Deliberately NOT `ladder-schema`'s `pairKey` (which joins with `|`): that one
 * is an internal grouping key, this one is a CONFIGURED grammar an operator
 * types. Keeping them distinct functions keeps a change to either from
 * silently reinterpreting the other.
 */
export const admissionPairKey = (tokenIn: string, tokenOut: string): string =>
  `${tokenIn.toLowerCase()}->${tokenOut.toLowerCase()}`;

/**
 * Token → amount the solver can actually move right now.
 *
 * Live inventory, NOT policy, so it is passed separately from
 * `JobAdmissionPolicy` and read per push rather than per process. Sourced from
 * `Stock.available` (wallet shielded balance minus outstanding payout
 * reservations), which is the same number the executor admits against.
 */
export type SpendableInventory = ReadonlyMap<string, bigint>;
