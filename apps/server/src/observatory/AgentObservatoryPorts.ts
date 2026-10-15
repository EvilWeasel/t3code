import {
  AgentObservatoryOwner,
  AgentObservatorySnapshot,
  AgentObservatoryUpdate,
  ProviderSessionId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Internal host-attested provenance. Not a tool/RPC decoder or bearer scope. */
export const AgentObservatoryPrincipal = Schema.Struct({
  providerSessionId: ProviderSessionId,
  nativeThreadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  nativeTurnId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  runtimeIncarnation: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
export type AgentObservatoryPrincipal = typeof AgentObservatoryPrincipal.Type;
export class AgentObservatoryRefusal extends Schema.TaggedError<AgentObservatoryRefusal>()(
  "AgentObservatoryRefusal",
  {
    reason: Schema.Literals([
      "unsupported",
      "stale_owner",
      "revision_conflict",
      "request_conflict",
      "unavailable",
    ]),
  },
) {
  override get message() {
    return `Agent observatory update refused: ${this.reason}.`;
  }
}

/** Future nominal host bridge supplies this per invocation, never from decoded model fields.
 * No production layer is provided here. The operation must retain the canonical thread lock;
 * the bridge validates runtime/native ownership before entering use, without recursive locking.
 */
export class AgentObservatoryInvocation extends Context.Service<
  AgentObservatoryInvocation,
  {
    readonly withOwner: <A, E, R>(
      use: (
        owner: AgentObservatoryOwner,
        principal: AgentObservatoryPrincipal,
      ) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | AgentObservatoryRefusal, R>;
  }
>()("t3/observatory/AgentObservatoryInvocation") {}

export interface AgentObservatoryCommit {
  readonly owner: AgentObservatoryOwner;
  readonly principal: AgentObservatoryPrincipal;
  readonly update: AgentObservatoryUpdate;
}
export interface AgentObservatoryCommitResult {
  readonly replayed: boolean;
  readonly snapshot: AgentObservatorySnapshot;
}
