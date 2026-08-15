import { genEvent, registerEvents } from "@effectstream/event-client";
import { Type } from "@sinclair/typebox";

// Effectstream's event schema currently supports primitive wire fields. Keep
// the discriminated lifecycle envelope as canonical JSON in one non-indexed
// string; event-bus.ts validates it again before exposing it through SSE.
// blockHeight is auto-indexed by registerEvents and injected by the runtime
// only after the enclosing block transaction commits.
export const ZswapAppEvents = registerEvents({
  Lifecycle: genEvent({
    name: "ZswapOfferLifecycle",
    fields: [{
      name: "eventJson",
      // event-client 0.103.1's conditional input type reduces schemas from a
      // consumer-resolved TypeBox patch copy to `never`. This cast adapts that
      // public typing bug only; the runtime value remains a TString schema.
      type: Type.String() as never,
      indexed: false,
    }],
  }),
});
