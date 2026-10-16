import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  EnvironmentId,
  ThreadId,
  RunId,
  RunAttemptId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ProviderDriverKind,
  MessageId,
  EventId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Database from "../persistence/Sqlite.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Executor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Trusted from "./TrustedAppControlInvocation.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Observatory from "../observatory/AgentObservatoryService.ts";
import { makeObservatoryInvocationCallback } from "../orchestration-v2/RunExecutionService.ts";

const now = DateTime.makeUnsafe("2026-10-15T00:00:00Z");
const threadId = ThreadId.make("thread:trusted-control");
const runId = RunId.make("run:trusted-control");
const attemptId = RunAttemptId.make("attempt:trusted-control");
const rootNodeId = NodeId.make("node:trusted-control");
const instanceId = ProviderInstanceId.make("codex");
const sessionId = ProviderSessionId.make("session:trusted-control");
const providerThreadId = ProviderThreadId.make("provider-thread:trusted-control");
const providerTurnId = ProviderTurnId.make("provider-turn:trusted-control");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-6" };
const thread = {
  id: threadId,
  createdBy: "user" as const,
  creationSource: "web" as const,
  projectId: ProjectId.make("project:trusted"),
  title: "Control",
  providerInstanceId: instanceId,
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  activeProviderThreadId: providerThreadId,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
const run = {
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId: instanceId,
  modelSelection,
  providerThreadId,
  userMessageId: MessageId.make("message:trusted"),
  rootNodeId,
  activeAttemptId: attemptId,
  status: "running" as const,
  queuePosition: null,
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const providerThread = {
  id: providerThreadId,
  driver,
  providerInstanceId: instanceId,
  providerSessionId: sessionId,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" as const },
  nativeConversationHeadRef: null,
  status: "active" as const,
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
};
const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
  instanceId,
  driver,
  providerSessionId: sessionId,
  providerSession: {
    id: sessionId,
    driver,
    providerInstanceId: instanceId,
    status: "ready",
    cwd: "/fixture",
    model: "gpt-6",
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: now,
    updatedAt: now,
    lastError: null,
  },
  events: Stream.empty,
  ensureThread: () => Effect.succeed(providerThread),
  resumeThread: () => Effect.succeed(providerThread),
  startTurn: () => Effect.die("unexpected start"),
  steerTurn: () => Effect.die("unexpected steer"),
  interruptTurn: () => Effect.die("unexpected interrupt"),
  respondToRuntimeRequest: () => Effect.die("unexpected response"),
  readThreadSnapshot: () => Effect.die("unexpected snapshot"),
  rollbackThread: () => Effect.die("unexpected rollback"),
  forkThread: () => Effect.die("unexpected fork"),
};
const captured: Trusted.CapturedAppControlExecution = {
  threadId,
  runId,
  attemptId,
  rootNodeId,
  providerInstanceId: instanceId,
  providerThreadId,
  runtime,
};
const native = {
  nativeThreadId: "native-thread",
  nativeTurnId: "native-turn",
  callId: "native-call",
  providerTurnId,
};
const seed = Effect.gen(function* () {
  const projections = yield* Projections.ProjectionStoreV2;
  const base = { threadId, runId, occurredAt: now, providerInstanceId: instanceId };
  const events: OrchestrationV2DomainEvent[] = [
    { ...base, id: EventId.make("event:trusted:thread"), type: "thread.created", payload: thread },
    { ...base, id: EventId.make("event:trusted:run"), type: "run.created", payload: run },
    {
      ...base,
      id: EventId.make("event:trusted:attempt"),
      type: "run-attempt.created",
      payload: {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId,
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId,
        reason: "initial",
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    },
    {
      ...base,
      id: EventId.make("event:trusted:provider-thread"),
      type: "provider-thread.updated",
      payload: providerThread,
    },
    {
      ...base,
      id: EventId.make("event:trusted:turn"),
      type: "provider-turn.updated",
      payload: {
        id: providerTurnId,
        providerThreadId,
        nodeId: rootNodeId,
        runAttemptId: attemptId,
        nativeTurnRef: { driver, nativeId: "native-turn", strength: "strong" },
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    },
  ];
  for (const event of events) yield* projections.apply(event);
});
const database = Database.layerMemory;
const stores = Projections.layer.pipe(Layer.provideMerge(database));
const environment = Layer.mock(Environment.ServerEnvironment)({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:trusted")),
});
const dependencies = Layer.mergeAll(stores, environment, Executor.layer, NodeCrypto.layer);
const serviceLayer = (
  get: () => Effect.Effect<Option.Option<ProviderAdapter.ProviderAdapterV2SessionRuntime>>,
) =>
  Trusted.layer.pipe(
    Layer.provideMerge(
      Layer.merge(dependencies, Layer.mock(Sessions.ProviderSessionManagerV2)({ get })),
    ),
  );

it.effect(
  "captures a canonical live turn and refuses copied capabilities or old native envelopes",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Trusted.TrustedAppControlInvocation;
      const owner = yield* service.capture(captured, native);
      assert.equal(owner.identity.runId, runId);
      assert.equal(owner.identity.authorTurnId, providerTurnId);
      yield* service.validate(owner);
      assert.equal(
        (yield* service.validate(Object.create(owner)).pipe(Effect.flip)).reason,
        "invalid_owner",
      );
      for (const changed of [
        { ...native, nativeTurnId: "old-turn" },
        { ...native, nativeThreadId: "foreign-thread" },
      ])
        assert.equal(
          (yield* service.capture(captured, changed).pipe(Effect.flip)).reason,
          "stale_owner",
        );
    }).pipe(Effect.provide(Layer.fresh(serviceLayer(() => Effect.succeed(Option.some(runtime)))))),
);
it.effect("rechecks the exact SQL owner when a runtime await overlaps terminalization", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        yield* seed;
        const service = yield* Trusted.TrustedAppControlInvocation;
        const pending = yield* service.capture(captured, native).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const projections = yield* Projections.ProjectionStoreV2;
        yield* projections.apply({
          id: EventId.make("event:trusted:completed"),
          threadId,
          runId,
          occurredAt: now,
          type: "run.updated",
          payload: { ...run, status: "completed", completedAt: now },
        });
        yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.join(pending).pipe(Effect.flip)).reason, "stale_owner");
      }).pipe(
        Effect.provide(
          Layer.fresh(
            serviceLayer(() =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(Option.some(runtime)),
              ),
            ),
          ),
        ),
      );
    }),
  ),
);
it.effect(
  "does not transfer a captured invocation to a replacement runtime with the same session id",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Trusted.TrustedAppControlInvocation;
      assert.equal(
        (yield* service.capture(captured, native).pipe(Effect.flip)).reason,
        "stale_owner",
      );
    }).pipe(
      Effect.provide(Layer.fresh(serviceLayer(() => Effect.succeed(Option.some({ ...runtime }))))),
    ),
);

it.effect(
  "a new canonical run does not inherit an older invocation even if its old projection still says running",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Trusted.TrustedAppControlInvocation;
      const owner = yield* service.capture(captured, native);
      const projections = yield* Projections.ProjectionStoreV2;
      yield* projections.apply({
        id: EventId.make("event:trusted:rollover"),
        threadId,
        occurredAt: now,
        type: "run.created",
        payload: {
          ...run,
          id: RunId.make("run:trusted:new"),
          ordinal: 2,
          activeAttemptId: RunAttemptId.make("attempt:trusted:new"),
          rootNodeId: NodeId.make("node:trusted:new"),
        },
      });
      assert.equal((yield* service.validate(owner).pipe(Effect.flip)).reason, "stale_owner");
    }).pipe(Effect.provide(Layer.fresh(serviceLayer(() => Effect.succeed(Option.some(runtime)))))),
);

it.effect(
  "retains the canonical thread lock through validated use without recursively taking it",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Trusted.TrustedAppControlInvocation;
      const executor = yield* Executor.ThreadCommandExecutor;
      const owner = yield* service.capture(captured, native);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const competing = yield* Deferred.make<void>();
      const operation = yield* service
        .withValidatedOwner(owner, (identity) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(identity.runId),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const waiter = yield* executor
        .withLock(threadId, Deferred.succeed(competing, undefined))
        .pipe(Effect.forkScoped({ startImmediately: true }));
      assert.isFalse(yield* Deferred.isDone(competing));
      yield* Deferred.succeed(release, undefined);
      assert.equal(yield* Fiber.join(operation), runId);
      yield* Fiber.join(waiter);
      assert.isTrue(yield* Deferred.isDone(competing));
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.fresh(serviceLayer(() => Effect.succeed(Option.some(runtime))))),
    ),
);

it.effect("checks runtime incarnation again inside the lock before invoking use", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let reads = 0;
    let used = false;
    yield* Effect.gen(function* () {
      yield* seed;
      const service = yield* Trusted.TrustedAppControlInvocation;
      const owner = yield* service.capture(captured, native);
      const pending = yield* service
        .withValidatedOwner(owner, () =>
          Effect.sync(() => {
            used = true;
          }),
        )
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(pending);
      assert.equal(result._tag, "Failure");
      assert.isFalse(used);
    }).pipe(
      Effect.provide(
        Layer.fresh(
          serviceLayer(() =>
            Effect.suspend(() =>
              ++reads === 1
                ? Effect.succeed(Option.some(runtime))
                : Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(Option.some({ ...runtime })),
                  ),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect(
  "captured native callback reads and publishes through the real canonical observatory service",
  () => {
    const eventStore = EventStore.layer.pipe(Layer.provide(Database.layerMemory));
    const storage = Layer.mergeAll(stores, eventStore);
    const sink = EventSink.layer.pipe(Layer.provide(storage));
    const observatory = Observatory.layer.pipe(
      Layer.provide(Layer.mergeAll(storage, sink, environment)),
    );
    return Effect.gen(function* () {
      yield* seed;
      const trusted = yield* Trusted.TrustedAppControlInvocation;
      const service = yield* Observatory.AgentObservatoryService;
      const crypto = yield* Crypto.Crypto;
      const call = makeObservatoryInvocationCallback(captured, trusted, service, crypto);
      const initial = yield* call(native, { action: "read" });
      assert.equal(initial.action, "read");
      assert.equal(initial.snapshot, null);
      const intent = {
        action: "publish" as const,
        requestId: CommandId.make("command:trusted-observatory"),
        expectedRevision: 0,
        state: {
          title: "Inspect current source",
          steps: [],
          todos: [],
          currentStepId: null,
          requestedCheckpoint: {
            id: "review",
            label: "Wait for review",
            when: "Before deployment",
          },
          layout: "single" as const,
          panels: [{ kind: "plan" as const, collapsed: false }],
        },
      };
      const committed = yield* call({ ...native, callId: "publish-call" }, intent);
      assert.equal(committed.action, "publish");
      assert.equal(committed.snapshot?.owner.runId, runId);
      assert.equal(committed.snapshot?.owner.attemptId, attemptId);
      const read = yield* call({ ...native, callId: "read-after-publish" }, { action: "read" });
      assert.deepEqual(read.snapshot, committed.snapshot);
      const replay = yield* call({ ...native, callId: "retry-publish" }, intent);
      if (replay.action === "publish") assert.isTrue(replay.replayed);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          serviceLayer(() => Effect.succeed(Option.some(runtime))),
          observatory,
          storage,
        ),
      ),
    );
  },
);
