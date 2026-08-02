import { Type } from "@sinclair/typebox";
import { builtinGrammars } from "@effectstream/sm/grammar";
import type { GrammarDefinition } from "@effectstream/concise";

export const grammar = {
  // Primitives
  "celestia-zswap": builtinGrammars.celestiaGeneric,
  "midnight-zswap": builtinGrammars.midnightGeneric,
  // Midnight:NullifierAndCommitment (effectstream#838): discriminated
  // union on payload.kind = "nullifier" | "commitment". 0.103.0 exports the
  // typed grammar only from primitives/src (not via builtinGrammars or
  // /builtin), so this stays Type.Any() with the shape enforced in the STM
  // handler's kind dispatch.
  "midnight-zswap-event": [["payload", Type.Any()]],
  "midnight-unshielded-spend": [["payload", Type.Any()]],
  "midnight-unshielded-create": [["payload", Type.Any()]],
  "midnight-zswap-root": [["payload", Type.Any()]],

  // Scheduled game input used for TTL cleanup.
  "zswap-ttl-cleanup": [["offerId", Type.Integer()]],
} as const satisfies GrammarDefinition;
