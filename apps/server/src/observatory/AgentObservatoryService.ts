import {
  AgentObservatoryUpdate,
  AgentObservatorySnapshot,
  type ThreadId,
  MessageId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  AgentObservatoryInvocation,
  AgentObservatoryRefusal,
  type AgentObservatoryCommitResult,
} from "./AgentObservatoryPorts.ts";

export class AgentObservatoryService extends Context.Service<
  AgentObservatoryService,
  {
    readonly update: (
      input: AgentObservatoryUpdate,
    ) => Effect.Effect<
      AgentObservatoryCommitResult,
      AgentObservatoryRefusal,
      AgentObservatoryInvocation | Crypto.Crypto
    >;
    /** Internal only: the destination read scope must be authorized before calling. */
    readonly read: (
      threadId: ThreadId,
    ) => Effect.Effect<AgentObservatorySnapshot | null, AgentObservatoryRefusal>;
    readonly readNativeRoster: (
      input: ProjectionStore.NativeAgentRosterQuery,
    ) => Effect.Effect<ProjectionStore.NativeAgentRosterPage, AgentObservatoryRefusal>;
  }
>()("t3/observatory/AgentObservatoryService") {}

const unavailable = () => new AgentObservatoryRefusal({ reason: "unavailable" });
const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const sink = yield* EventSink.EventSinkV2;
  const store = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return AgentObservatoryService.of({
    update: (submitted) =>
      Effect.gen(function* () {
        // Decode/detach before yielding to the trusted host operation.
        const codec = Schema.fromJsonString(AgentObservatoryUpdate);
        const encoded = yield* Schema.encodeEffect(codec)(submitted);
        const update = yield* Schema.decodeUnknownEffect(codec)(encoded);
        const invocation = yield* AgentObservatoryInvocation;
        const environmentId = yield* environment.getEnvironmentId;
        return yield* invocation.withOwner((owner, principal) => {
          if (owner.environmentId !== environmentId)
            return Effect.fail(new AgentObservatoryRefusal({ reason: "stale_owner" }));
          return sink.commitObservatoryUpdate({ owner, principal, update });
        });
      }).pipe(
        Effect.mapError((cause) =>
          Schema.is(AgentObservatoryRefusal)(cause) ? cause : unavailable(),
        ),
      ),
    read: (threadId) =>
      Effect.gen(function* () {
        const environmentId = yield* environment.getEnvironmentId;
        const records = yield* projections.getThreadRecords(threadId, ["messages"], {
          messageIds: [MessageId.make(`message:observatory:${threadId}`)],
        });
        const metadata = records.messages[0]?.observatory;
        if (!metadata) return null;
        if (metadata.owner.environmentId !== environmentId || metadata.owner.threadId !== threadId)
          return yield* unavailable();
        // Resolve the original committed sequence; never derive it from latest activity.
        const events = yield* store
          .readByCommandId({ commandId: metadata.requestId })
          .pipe(Stream.runCollect);
        const stored = events.find(
          (stored) => stored.event.id === metadata.eventId && stored.event.threadId === threadId,
        );
        if (stored?.event.type !== "message.updated" || !stored.event.payload.observatory)
          return yield* unavailable();
        return yield* Schema.decodeUnknownEffect(AgentObservatorySnapshot)({
          ...stored.event.payload.observatory,
          sequence: stored.sequence,
        });
      }).pipe(Effect.mapError(unavailable)),
    readNativeRoster: (input) =>
      projections.getCurrentNativeAgentRoster(input).pipe(Effect.mapError(unavailable)),
  });
});

/** No transport or production invocation authority is mounted by this layer. */
export const layer = Layer.effect(AgentObservatoryService, make);
