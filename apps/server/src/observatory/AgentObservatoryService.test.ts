import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AgentObservatoryOwner,
  AgentObservatoryVisualState,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as AgentObservatoryService from "./AgentObservatoryService.ts";
import { AgentObservatoryInvocation } from "./AgentObservatoryPorts.ts";
const providerInstanceId = ProviderInstanceId.make("codex");
const providerDriver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(database),
);
const sink = EventSink.layer.pipe(Layer.provide(stores));
const environment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(EnvironmentId.make("env:observatory")),
  getDescriptor: Effect.die("Descriptor is not used by observatory."),
});
const dependencies = Layer.mergeAll(stores, sink, environment);
const layer = Layer.mergeAll(
  dependencies,
  AgentObservatoryService.layer.pipe(Layer.provide(dependencies)),
  NodeServices.layer,
);

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: `Thread ${threadId}`,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function threadCreatedEvent(input: {
  readonly id: string;
  readonly thread: OrchestrationV2AppThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(input.id),
    type: "thread.created",
    threadId: input.thread.id,
    providerInstanceId,
    occurredAt: input.now,
    payload: input.thread,
  };
}

const seedObservatoryOwner = (suffix: string) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`thread:observatory:${suffix}`);
    const owner: AgentObservatoryOwner = {
      environmentId: EnvironmentId.make("env:observatory"),
      threadId,
      runId: RunId.make(`run:observatory:${suffix}`),
      attemptId: RunAttemptId.make(`attempt:observatory:${suffix}`),
      rootNodeId: NodeId.make(`node:observatory:${suffix}`),
      providerInstanceId,
      providerThreadId: ProviderThreadId.make(`provider-thread:observatory:${suffix}`),
      providerTurnId: ProviderTurnId.make(`provider-turn:observatory:${suffix}`),
    };
    const principal = {
      providerSessionId: ProviderSessionId.make(`session:observatory:${suffix}`),
      nativeThreadId: `native-thread:${suffix}`,
      nativeTurnId: `native-turn:${suffix}`,
      runtimeIncarnation: `runtime:${suffix}`,
    };
    const thread = makeThread(threadId, now);
    const run: OrchestrationV2Run = {
      id: owner.runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: owner.providerThreadId,
      userMessageId: MessageId.make(`input:${suffix}`),
      rootNodeId: owner.rootNodeId,
      activeAttemptId: owner.attemptId,
      status: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
      threadCreatedEvent({ id: `event:obs:${suffix}:thread`, thread, now }),
      {
        id: EventId.make(`event:obs:${suffix}:run`),
        type: "run.created",
        threadId,
        occurredAt: now,
        payload: run,
      },
      {
        id: EventId.make(`event:obs:${suffix}:attempt`),
        type: "run-attempt.created",
        threadId,
        occurredAt: now,
        payload: {
          id: owner.attemptId,
          runId: owner.runId,
          attemptOrdinal: 1,
          rootNodeId: owner.rootNodeId,
          providerInstanceId,
          providerThreadId: owner.providerThreadId,
          providerTurnId: owner.providerTurnId,
          reason: "initial",
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      },
      {
        id: EventId.make(`event:obs:${suffix}:provider-thread`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: owner.providerThreadId,
          driver: providerDriver,
          providerInstanceId,
          providerSessionId: principal.providerSessionId,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver: providerDriver,
            nativeId: principal.nativeThreadId,
            strength: "strong",
          },
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: EventId.make(`event:obs:${suffix}:turn`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: owner.providerTurnId,
          providerThreadId: owner.providerThreadId,
          nodeId: owner.rootNodeId,
          runAttemptId: owner.attemptId,
          nativeTurnRef: {
            driver: providerDriver,
            nativeId: principal.nativeTurnId,
            strength: "strong",
          },
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      },
    ];
    yield* sink.write({ events });
    const state: AgentObservatoryVisualState = {
      title: "Inspect actual routing",
      steps: [{ id: "inspect", label: "Inspect", status: "active" }],
      todos: [],
      currentStepId: "inspect",
      requestedCheckpoint: {
        id: "review",
        label: "Review before write",
        when: "Cause established",
      },
      layout: "single",
      panels: [{ kind: "plan", collapsed: false }],
    };
    const input = {
      owner,
      principal,
      update: { requestId: CommandId.make(`command:obs:${suffix}`), expectedRevision: 0, state },
    };
    return { input, run, thread, now };
  });

it.layer(layer)("Agent observatory service with real persistence", (it) => {
  it.effect(
    "uses the same update/read service and detaches input before the trusted boundary yields",
    () =>
      Effect.gen(function* () {
        const service = yield* AgentObservatoryService.AgentObservatoryService;
        const { input } = yield* seedObservatoryOwner("service");
        assert.equal(yield* service.read(input.owner.threadId), null);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        // This port models the external trusted host boundary, not native-auth acceptance.
        const invocation = AgentObservatoryInvocation.of({
          withOwner: (use) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(use(input.owner, input.principal)),
            ),
        });
        const submitted = {
          ...input.update,
          state: { ...input.update.state, title: "Before boundary" },
        };
        const work = yield* service
          .update(submitted)
          .pipe(Effect.provideService(AgentObservatoryInvocation, invocation), Effect.forkScoped);
        yield* Deferred.await(entered);
        submitted.state.title = "Mutated outside service";
        yield* Deferred.succeed(release, undefined);
        const committed = yield* Fiber.join(work);
        assert.equal(committed.snapshot.state.title, "Before boundary");
        assert.deepEqual(yield* service.read(input.owner.threadId), committed.snapshot);
      }).pipe(Effect.scoped),
  );

  it.effect("refuses a foreign destination before any canonical write", () =>
    Effect.gen(function* () {
      const service = yield* AgentObservatoryService.AgentObservatoryService;
      const { input } = yield* seedObservatoryOwner("service-foreign");
      const invocation = AgentObservatoryInvocation.of({
        withOwner: (use) =>
          use({ ...input.owner, environmentId: EnvironmentId.make("foreign") }, input.principal),
      });
      const result = yield* service
        .update(input.update)
        .pipe(Effect.provideService(AgentObservatoryInvocation, invocation), Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "stale_owner");
      assert.equal(yield* service.read(input.owner.threadId), null);
    }),
  );
});
