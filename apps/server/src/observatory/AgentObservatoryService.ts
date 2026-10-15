import {
  AgentObservatoryUpdate,
  AgentObservatoryRead,
  AgentObservatoryNativeRosterPage,
  type AgentObservatorySubscribeInput,
  AgentObservatorySnapshot,
  type ThreadId,
  MessageId,
  type EnvironmentId,
  type OrchestrationV2StoredEvent,
  AgentObservatoryReadNativeRosterInput,
  AgentObservatorySubscribeNativeRosterInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
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
    readonly subscribe: (
      input: AgentObservatorySubscribeInput,
    ) => Stream.Stream<AgentObservatoryRead, AgentObservatoryRefusal>;
    readonly readNativeRoster: (
      input: AgentObservatoryReadNativeRosterInput,
    ) => Effect.Effect<AgentObservatoryNativeRosterPage, AgentObservatoryRefusal>;
    readonly subscribeNativeRoster: (
      input: AgentObservatorySubscribeNativeRosterInput,
    ) => Stream.Stream<AgentObservatoryNativeRosterPage, AgentObservatoryRefusal>;
  }
>()("t3/observatory/AgentObservatoryService") {}

const unavailable = () => new AgentObservatoryRefusal({ reason: "unavailable" });
const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const sink = yield* EventSink.EventSinkV2;
  const store = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const messageId = (threadId: ThreadId) => MessageId.make(`message:observatory:${threadId}`);
  const fromStored = (
    stored: OrchestrationV2StoredEvent,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) =>
    Effect.gen(function* () {
      const event = stored.event;
      if (
        event.type !== "message.updated" ||
        event.threadId !== threadId ||
        event.payload.id !== messageId(threadId)
      )
        return yield* unavailable();
      const metadata = event.payload.observatory;
      if (
        !metadata ||
        metadata.eventId !== event.id ||
        metadata.requestId !== stored.commandId ||
        metadata.owner.environmentId !== environmentId ||
        metadata.owner.threadId !== threadId ||
        metadata.owner.runId !== event.payload.runId ||
        metadata.owner.rootNodeId !== event.payload.nodeId ||
        metadata.nativeFrontier.sequence >= stored.sequence
      )
        return yield* unavailable();
      return yield* Schema.decodeUnknownEffect(AgentObservatorySnapshot)({
        ...metadata,
        sequence: stored.sequence,
      });
    });
  const read = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const environmentId = yield* environment.getEnvironmentId;
      const records = yield* projections.getThreadRecords(threadId, ["messages"], {
        messageIds: [messageId(threadId)],
      });
      const metadata = records.messages[0]?.observatory;
      if (!metadata) return null;
      const events = yield* store
        .readByCommandId({ commandId: metadata.requestId })
        .pipe(Stream.take(2), Stream.runCollect);
      if (events.length !== 1) return yield* unavailable();
      const stored = events.find(
        (stored) => stored.event.id === metadata.eventId && stored.event.threadId === threadId,
      );
      if (!stored) return yield* unavailable();
      const snapshot = yield* fromStored(stored, environmentId, threadId);
      if (
        snapshot.revision !== metadata.revision ||
        Object.entries(metadata.owner).some(
          ([key, value]) =>
            Object.entries(snapshot.owner).find(([name]) => name === key)?.[1] !== value,
        )
      )
        return yield* unavailable();
      return snapshot;
    }).pipe(Effect.mapError(unavailable));
  const bootstrap = (threadId: ThreadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const environmentId = yield* environment.getEnvironmentId;
          // ProjectionStore uses the same SqlClient transaction context (a nested savepoint).
          // This mirrors its existing getThreadSnapshot transaction composition.
          const snapshot = yield* read(threadId);
          const throughSequence = yield* store.latestApplicationSequence;
          if (snapshot && snapshot.sequence > throughSequence) return yield* unavailable();
          return AgentObservatoryRead.make({
            environmentId,
            threadId,
            throughSequence,
            snapshot,
            // A durable authored record is not proof that its provider is currently online.
            status: snapshot ? "stale" : "unsupported",
          });
        }),
      )
      .pipe(Effect.mapError(unavailable));
  const readNativeRoster = (submitted: AgentObservatoryReadNativeRosterInput) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(AgentObservatoryReadNativeRosterInput)(
        submitted,
      );
      const environmentId = yield* environment.getEnvironmentId;
      const threadIds = [...input.threadIds].sort();
      if (input.cursor && input.cursor.environmentId !== environmentId)
        return AgentObservatoryNativeRosterPage.make({
          environmentId,
          threadIds,
          source: "canonical-subagent-index",
          coverage: "recorded-current-only",
          throughSequence: 0,
          status: "stale",
          agents: [],
          nextCursor: null,
        });
      const page = yield* projections.getCurrentNativeAgentRoster({ ...input, threadIds });
      return yield* Schema.decodeUnknownEffect(AgentObservatoryNativeRosterPage)({
        ...page,
        environmentId,
        threadIds,
        nextCursor: page.nextCursor ? { ...page.nextCursor, environmentId } : null,
      });
    }).pipe(Effect.mapError(unavailable));
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
    read,
    subscribe: ({ threadId }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const initial = yield* bootstrap(threadId);
          const live = sink
            .stream({
              threadId,
              eventType: "message.updated",
              afterSequence: initial.throughSequence,
              bounded: true,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "message.updated" &&
                  stored.event.payload.id === messageId(threadId),
              ),
              Stream.mapEffect((stored) =>
                fromStored(stored, initial.environmentId, threadId).pipe(
                  Effect.map((snapshot) =>
                    AgentObservatoryRead.make({
                      environmentId: initial.environmentId,
                      threadId,
                      throughSequence: stored.sequence,
                      status: "stale",
                      snapshot,
                    }),
                  ),
                ),
              ),
            );
          // EventSink subscribes before its own high-water read and replays after our SQL cut.
          // Writes between bootstrap and live subscription are therefore not lost.
          return Stream.concat(Stream.succeed(initial), live);
        }),
      ).pipe(Stream.mapError(unavailable)),
    readNativeRoster,
    subscribeNativeRoster: (submitted) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const input = yield* Schema.decodeUnknownEffect(
            AgentObservatorySubscribeNativeRosterInput,
          )(submitted);
          const initial = yield* readNativeRoster(input);
          if (initial.threadIds.length === 0) return Stream.succeed(initial);
          const selected = new Set(initial.threadIds);
          const onlyThreadId = initial.threadIds.length === 1 ? initial.threadIds[0] : undefined;
          let throughSequence = initial.throughSequence;
          const live = sink
            .stream({
              eventType: "subagent.updated",
              afterSequence: throughSequence,
              bounded: true,
              ...(onlyThreadId === undefined ? {} : { threadId: onlyThreadId }),
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.sequence > throughSequence && selected.has(stored.event.threadId),
              ),
              Stream.mapEffect(() =>
                readNativeRoster({ threadIds: initial.threadIds, limit: input.limit }).pipe(
                  Effect.tap((page) =>
                    Effect.sync(() => {
                      throughSequence = page.throughSequence;
                    }),
                  ),
                ),
              ),
            );
          // Always refresh only the selected indexed first page. No expanded cursor auto-drain.
          return Stream.concat(Stream.succeed(initial), live);
        }),
      ).pipe(Stream.mapError(unavailable)),
  });
});

/** Transport callers authorize the destination selection; native writes require nominal captured invocation. */
export const layer = Layer.effect(AgentObservatoryService, make);
