import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { LiveVoiceEvent } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as CodexLiveSessionService from "./CodexLiveSessionService.ts";

const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeWorkStatus = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      environmentId: Schema.String,
      threadId: Schema.String,
      leaseId: Schema.String,
      generation: Schema.Number,
      tasks: Schema.Array(
        Schema.Struct({
          runId: Schema.String,
          status: Schema.String,
          resultReady: Schema.Boolean,
          commentary: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  ),
);
const readbackState = (json: string) => {
  const decoded = decodeJson(json);
  if (typeof decoded !== "object" || decoded === null) return undefined;
  const readback = (decoded as Record<string, unknown>).readback;
  if (typeof readback !== "object" || readback === null) return undefined;
  return (readback as Record<string, unknown>).state;
};

it.effect.each([false, true])(
  "uses the native planner, gates active, and queues durable work (reuse runtime: %s)",
  (reuseRuntime) =>
    Effect.gen(function* () {
      const nativeEvents =
        yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2LiveVoiceEvent>();
      const secondNativeEvents = reuseRuntime
        ? nativeEvents
        : yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2LiveVoiceEvent>();
      const secondProviderSessionId = ProviderSessionId.make(
        reuseRuntime ? "provider-session-test" : "provider-session-test-2",
      );
      let submitWork:
        | ((input: {
            plannerNativeThreadId: string;
            plannerTurnId: string;
            callId: string;
            message: string;
          }) => Effect.Effect<string, ProviderAdapter.ProviderAdapterV2Error>)
        | undefined;
      let plannerOptions:
        | { serviceTier?: string | null; reasoningEffort?: string | null }
        | undefined;
      let controlWork: Parameters<
        ProviderAdapter.ProviderAdapterV2LiveVoiceRuntime["preparePlanner"]
      >[0]["onWorkControl"];
      const workCompletion = yield* Deferred.make<void>();
      const workFinished = yield* Deferred.make<void>();
      let completedWork = 0;
      let steers = 0;
      let rejectSteerAtAdmission = false;
      let sends = 0;
      let stops = 0;
      const spoken: Array<{ plannerNativeThreadId: string; text: string }> = [];
      let appendAttempts = 0;
      let appendSpeechFails = false;
      let resolveAppendAttempt: (() => void) | undefined;
      let appendAttemptObserved = new Promise<void>((resolve) => {
        resolveAppendAttempt = resolve;
      });
      let resolveSpeech: (() => void) | undefined;
      let speechObserved = new Promise<void>((resolve) => {
        resolveSpeech = resolve;
      });
      let gateReadResolvers: Array<() => void> = [];
      let durableProjection: OrchestrationV2ThreadProjection;
      let activePrincipalLookups = 0;
      let principalLookupGate:
        | {
            readonly callNumber: number;
            readonly started: Promise<void>;
            readonly release: () => void;
            readonly wait: Promise<void>;
            readonly markStarted: () => void;
          }
        | undefined;
      const holdDispatchPrincipalLookup = () => {
        let markStarted!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        principalLookupGate = {
          callNumber: activePrincipalLookups + 2,
          started,
          release,
          wait,
          markStarted,
        };
        return principalLookupGate;
      };
      const t3EventQueues = new Map([
        ["run.updated", yield* Queue.unbounded<OrchestrationV2StoredEvent>()],
        ["subagent.updated", yield* Queue.unbounded<OrchestrationV2StoredEvent>()],
        ["checkpoint.captured", yield* Queue.unbounded<OrchestrationV2StoredEvent>()],
        ["message.updated", yield* Queue.unbounded<OrchestrationV2StoredEvent>()],
      ]);
      let plannerCalls = 0;
      let plannerAttempts = 0;
      let plannerFailure: "managed_account_required" | "planner_restriction_failed" | undefined;
      const runtime = {
        instanceId: ProviderInstanceId.make("codex-test"),
        providerSessionId: ProviderSessionId.make("provider-session-test"),
        driver: "codex",
        liveVoice: {
          events: Stream.fromQueue(nativeEvents),
          preparePlanner: (input: {
            serviceTier?: string | null;
            reasoningEffort?: string | null;
            onSubmitWork: (input: {
              plannerNativeThreadId: string;
              plannerTurnId: string;
              callId: string;
              message: string;
            }) => Effect.Effect<string>;
            onWorkControl: NonNullable<typeof controlWork>;
          }) =>
            Effect.suspend(() => {
              plannerAttempts += 1;
              if (plannerFailure !== undefined) {
                return Effect.fail(
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: ProviderDriverKind.make("codex"),
                    detail:
                      plannerFailure === "managed_account_required"
                        ? "Managed ChatGPT account is required for Codex Live."
                        : "Codex Live planner settings were not confirmed.",
                  }),
                );
              }
              return Effect.sync(() => {
                plannerCalls += 1;
                submitWork = input.onSubmitWork;
                controlWork = input.onWorkControl;
                plannerOptions = {
                  ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
                  ...(input.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: input.reasoningEffort }),
                };
                return { plannerNativeThreadId: `planner-native-${plannerCalls}` };
              });
            }),
          start: () => Effect.void,
          stop: () =>
            Effect.sync(() => {
              stops += 1;
            }),
          appendSpeech: (input: { plannerNativeThreadId: string; text: string }) =>
            Effect.gen(function* () {
              appendAttempts += 1;
              resolveAppendAttempt?.();
              if (appendSpeechFails)
                return yield* Effect.fail(
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: ProviderDriverKind.make("codex"),
                    detail: "Ambiguous native append acknowledgement.",
                  }),
                );
              spoken.push(input);
              resolveSpeech?.();
            }),
        },
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      const secondRuntime = {
        ...runtime,
        providerSessionId: secondProviderSessionId,
        liveVoice: {
          ...runtime.liveVoice,
          events: Stream.fromQueue(secondNativeEvents),
        },
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      const sessionId = AuthSessionId.make("live-test-principal");
      const session = {
        sessionId,
        subject: "principal-subject",
        method: "browser-session-cookie" as const,
        scopes: [AuthOrchestrationOperateScope],
      };
      const threadId = "thread-live-test" as never;
      const projectId = "project-live-test" as never;
      const providerInstanceId = ProviderInstanceId.make("codex-test");
      const modelSelection = {
        instanceId: providerInstanceId,
        model: "codex-test-model",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
      } as never;
      const projection = {
        thread: {
          id: threadId,
          projectId,
          providerInstanceId,
          activeProviderThreadId: null,
          modelSelection,
          archivedAt: null,
          runtimeMode: "approval-required",
          interactionMode: "default",
          worktreePath: "/private/test-worktree",
        },
        providerThreads: [],
        providerSessions: [
          { id: ProviderSessionId.make("provider-session-test"), providerInstanceId },
        ],
      };
      durableProjection = {
        ...projection,
        runs: [],
        attempts: [],
        nodes: [],
        subagents: [],
        checkpoints: [],
        messages: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const policy = {
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/private/test-worktree",
      } as never;
      let currentPolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy = policy;
      const dependencies = Layer.mergeAll(
        NodeSqliteClient.layer({ filename: ":memory:" }),
        NodeCrypto.layer,
        Layer.succeed(SessionStore.SessionStore, {
          listActive: () => {
            activePrincipalLookups += 1;
            const gate = principalLookupGate;
            if (gate?.callNumber === activePrincipalLookups) {
              principalLookupGate = undefined;
              gate.markStarted();
              return Effect.promise(() => gate.wait).pipe(
                Effect.as([{ sessionId, subject: session.subject, scopes: session.scopes }]),
              );
            }
            return Effect.succeed([
              { sessionId, subject: session.subject, scopes: session.scopes },
            ]);
          },
        } as unknown as SessionStore.SessionStore["Service"]),
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed("env-live-test" as never),
        }),
        Layer.succeed(RuntimePolicy.RuntimePolicyV2, {
          resolve: () => Effect.succeed(currentPolicy),
        }),
        Layer.succeed(ProviderSessionManager.ProviderSessionManagerV2, {
          get: (providerSessionId: ProviderSessionId) =>
            Effect.succeed(
              Option.some(
                !reuseRuntime && providerSessionId === secondProviderSessionId
                  ? secondRuntime
                  : runtime,
              ),
            ),
        } as unknown as ProviderSessionManager.ProviderSessionManagerV2Shape),
        Layer.succeed(ThreadManagementService.ThreadManagementService, {
          getThreadProjection: () => Effect.succeed(durableProjection),
          getProjectThread: () =>
            Effect.sync(() => {
              const resolve = gateReadResolvers.shift();
              resolve?.();
              return durableProjection;
            }),
          getThreadEventSequence: () => Effect.succeed(0),
          streamStoredEventsFrom: (input: { eventType?: string }) =>
            Stream.fromQueue(t3EventQueues.get(input.eventType ?? "")!),
          sendToThread: () =>
            Effect.gen(function* () {
              sends += 1;
              if (sends === 1)
                yield* Deferred.await(workCompletion).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      completedWork += 1;
                    }),
                  ),
                  Effect.tap(() => Deferred.succeed(workFinished, undefined)),
                  Effect.forkChild,
                );
              return { delivery: "queued", run: { id: `durable-run-${sends}` } };
            }),
          dispatch: (
            command: Extract<
              Parameters<ThreadManagementService.ThreadManagementServiceShape["dispatch"]>[0],
              { type: "message.dispatch" }
            >,
          ) =>
            Effect.gen(function* () {
              if (
                command.dispatchMode.type !== "steer_active" ||
                command.dispatchMode.onInactive !== "reject"
              )
                return yield* new Orchestrator.OrchestratorCommandRejectedError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "Expected exact, fail-closed steering.",
                });
              const targetRunId = command.dispatchMode.targetRunId;
              const run = durableProjection.runs.find((candidate) => candidate.id === targetRunId);
              if (
                rejectSteerAtAdmission ||
                !run ||
                !["running", "starting", "waiting"].includes(run.status)
              )
                return yield* new Orchestrator.OrchestratorCommandRejectedError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "Target run ended at admission.",
                });
              steers += 1;
              durableProjection = {
                ...durableProjection,
                messages: [
                  ...durableProjection.messages,
                  {
                    id: command.messageId,
                    threadId,
                    runId: run.id,
                    role: "user",
                    text: command.text,
                  } as never,
                ],
              };
              return { events: [] };
            }),
        } as unknown as ThreadManagementService.ThreadManagementServiceShape),
        Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
          getInstance: () => Effect.succeed({ driverKind: "codex" }),
        } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]),
      );
      const program = Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const service = yield* CodexLiveSessionService.CodexLiveSessionService;
        const prepared = yield* service.prepare(session, {
          threadId,
          clientRequestId: "prepare-1",
        });
        assert.equal(prepared.status, "prepared");
        assert.equal(prepared.providerSessionId, "provider-session-test");
        assert.equal(prepared.plannerNativeThreadId, "planner-native-1");
        assert.deepEqual(plannerOptions, { serviceTier: "priority", reasoningEffort: "high" });
        const duplicatePrepare = yield* service.prepare(session, {
          threadId,
          clientRequestId: "prepare-1",
        });
        assert.equal(duplicatePrepare.leaseId, prepared.leaseId);
        assert.equal(plannerCalls, 1);

        const delivered = yield* Queue.unbounded<LiveVoiceEvent>();
        const observedStatuses: string[] = [];
        yield* service
          .subscribe(session, {
            leaseId: prepared.leaseId,
            generation: prepared.generation,
          })
          .pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "status") observedStatuses.push(event.session.status);
              }).pipe(Effect.andThen(Queue.offer(delivered, event))),
            ),
            Effect.forkChild({ startImmediately: true }),
          );
        const waitForEvent = (predicate: (event: LiveVoiceEvent) => boolean) =>
          Effect.gen(function* () {
            while (true) {
              const event = yield* Queue.take(delivered);
              if (predicate(event)) return event;
            }
          });
        const initial = yield* waitForEvent(
          (event) =>
            event.type === "status" &&
            event.session.leaseId === prepared.leaseId &&
            event.session.generation === prepared.generation &&
            event.session.status === "prepared",
        );
        assert.equal(initial.type, "status");

        const acknowledged = yield* service.start(session, {
          leaseId: prepared.leaseId,
          generation: prepared.generation,
          offerSdp: "v=0\r\n",
          clientRequestId: "start-1",
        });
        assert.equal(acknowledged.status, "starting");

        yield* Queue.offer(nativeEvents, {
          type: "sdp",
          plannerNativeThreadId: "planner-native-1",
          sdp: "v=0\\r\\nanswer",
        });
        const notStartedYet = yield* service.status(session, {
          leaseId: prepared.leaseId,
          generation: prepared.generation,
        });
        assert.equal(notStartedYet.status, "starting");
        yield* Queue.offer(nativeEvents, {
          type: "started",
          plannerNativeThreadId: "planner-native-1",
          realtimeSessionId: `${prepared.leaseId}:${prepared.generation}`,
        });
        const activeEvent = yield* waitForEvent(
          (event) => event.type === "status" && event.session.status === "active",
        );
        assert.equal(activeEvent.type, "status");

        assert.isTrue(typeof submitWork === "function");
        const invokeWithPlanner = (
          plannerNativeThreadId: string,
          callId: string,
          message: string,
          plannerTurnId: string,
        ) =>
          submitWork!({
            plannerNativeThreadId,
            plannerTurnId,
            callId,
            message,
          });
        const invoke = (callId: string, message: string, plannerTurnId = "planner-turn-1") =>
          invokeWithPlanner("planner-native-1", callId, message, plannerTurnId);
        currentPolicy = { ...currentPolicy, cwd: "/changed-worktree" };
        const policyChanged = yield* Effect.exit(
          invoke("call-stale", "A request captured under old settings", "planner-turn-stale"),
        );
        assert.isTrue(Exit.isFailure(policyChanged));
        assert.equal(sends, 0);
        currentPolicy = policy;
        const firstReceipt = yield* invoke("call-1", "Implement the requested change");
        const duplicateReceipt = yield* invoke("call-2", "Implement the requested change");
        assert.equal(firstReceipt, duplicateReceipt);
        assert.equal(sends, 1);

        const makeRunProjection = (
          runId: string,
          childStatus: "running" | "completed",
          finalText = `  ${`durable answer for ${runId} `.repeat(400)}\n  `,
        ) => {
          const commentaryText = `commentary for ${runId}`;
          const commentaryNodeId = `commentary-${runId}`;
          const finalNodeId = `assistant-${runId}`;
          const commentaryMessageId = `commentary-message-${runId}`;
          const finalMessageId = `final-${runId}`;
          return {
            ...projection,
            runs: [
              {
                id: runId,
                threadId,
                ordinal: runId.endsWith("1") ? 1 : 2,
                providerInstanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: `user-${runId}`,
                rootNodeId: `root-${runId}`,
                activeAttemptId: `attempt-${runId}`,
                status: "completed",
                requestedAt: "2026-10-14T00:00:00.000Z",
                startedAt: "2026-10-14T00:00:01.000Z",
                completedAt: "2026-10-14T00:00:03.000Z",
                checkpointId: `checkpoint-${runId}`,
              },
            ],
            nodes: [
              {
                id: commentaryNodeId,
                threadId,
                runId,
                parentNodeId: `root-${runId}`,
                rootNodeId: `root-${runId}`,
                kind: "assistant_message",
                status: "completed",
                countsForRun: false,
                providerThreadId: "provider-thread-test",
                providerTurnId: "provider-turn-test",
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: "2026-10-14T00:00:02.000Z",
                completedAt: "2026-10-14T00:00:03.000Z",
              },
              {
                id: finalNodeId,
                threadId,
                runId,
                parentNodeId: `root-${runId}`,
                rootNodeId: `root-${runId}`,
                kind: "assistant_message",
                status: "completed",
                countsForRun: false,
                providerThreadId: "provider-thread-test",
                providerTurnId: "provider-turn-test",
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: "2026-10-14T00:00:02.000Z",
                completedAt: "2026-10-14T00:00:03.000Z",
              },
            ],
            attempts: [
              {
                id: `attempt-${runId}`,
                runId,
                attemptOrdinal: 1,
                rootNodeId: `root-${runId}`,
                providerInstanceId,
                providerThreadId: "provider-thread-test",
                providerTurnId: "provider-turn-test",
                reason: "initial",
                status: "completed",
                startedAt: "2026-10-14T00:00:01.000Z",
                completedAt: "2026-10-14T00:00:03.000Z",
              },
            ],
            subagents: [
              {
                id: `child-${runId}`,
                threadId,
                runId,
                parentNodeId: `root-${runId}`,
                origin: "app_owned",
                createdBy: "assistant",
                driver: "codex",
                providerInstanceId,
                providerThreadId: null,
                childThreadId: null,
                nativeTaskRef: null,
                prompt: "required child work",
                title: null,
                model: null,
                status: childStatus,
                result: null,
                startedAt: "2026-10-14T00:00:01.000Z",
                completedAt: childStatus === "completed" ? "2026-10-14T00:00:03.000Z" : null,
                updatedAt: "2026-10-14T00:00:03.000Z",
              },
            ],
            messages: [
              {
                id: commentaryMessageId,
                threadId,
                runId,
                nodeId: commentaryNodeId,
                role: "assistant",
                text: commentaryText,
                streaming: false,
                attachments: [],
                createdAt: "2026-10-14T00:00:02.000Z",
                updatedAt: "2026-10-14T00:00:03.000Z",
              },
              {
                id: finalMessageId,
                threadId,
                runId,
                nodeId: finalNodeId,
                role: "assistant",
                text: finalText,
                streaming: false,
                attachments: [],
                createdAt: "2026-10-14T00:00:02.000Z",
                updatedAt: "2026-10-14T00:00:03.000Z",
              },
            ],
            turnItems: [
              {
                id: `commentary-item-${runId}`,
                threadId,
                runId,
                nodeId: commentaryNodeId,
                providerThreadId: "provider-thread-test",
                providerTurnId: "provider-turn-test",
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "completed",
                title: null,
                startedAt: "2026-10-14T00:00:02.000Z",
                completedAt: "2026-10-14T00:00:03.000Z",
                updatedAt: "2026-10-14T00:00:03.000Z",
                type: "assistant_message",
                messageId: commentaryMessageId,
                text: commentaryText,
                streaming: false,
              },
              {
                id: `final-item-${runId}`,
                threadId,
                runId,
                nodeId: finalNodeId,
                providerThreadId: "provider-thread-test",
                providerTurnId: "provider-turn-test",
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 2,
                status: "completed",
                title: null,
                startedAt: "2026-10-14T00:00:02.000Z",
                completedAt: "2026-10-14T00:00:03.000Z",
                updatedAt: "2026-10-14T00:00:03.000Z",
                type: "assistant_message",
                messageId: finalMessageId,
                text: finalText,
                streaming: false,
              },
            ],
            checkpoints: [],
          } as unknown as OrchestrationV2ThreadProjection;
        };
        const makeReadyProjection = (runId: string, ordinal: number, finalText?: string) =>
          ({
            ...makeRunProjection(runId, "completed", finalText),
            checkpoints: [
              {
                id: `checkpoint-${runId}`,
                threadId,
                scopeId: `scope-root-${ordinal}`,
                runId,
                nodeId: `root-${runId}`,
                parentCheckpointId: null,
                ordinalWithinScope: 1,
                appRunOrdinal: ordinal,
                ref: `checkpoint-ref-${ordinal}`,
                status: "ready",
                files: [],
                capturedAt: "2026-10-14T00:00:03.000Z",
              },
            ],
          }) as unknown as OrchestrationV2ThreadProjection;
        const eventFor = (event: OrchestrationV2StoredEvent["event"]) =>
          ({
            sequence: 1,
            commandId: null,
            event,
          }) as OrchestrationV2StoredEvent;
        const waitForGateRead = () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                gateReadResolvers.push(resolve);
              }),
          );

        // The canonical job is held at its completion boundary while this same
        // conversation admits status, priority changes, and more transcript events.
        const completedFixture = makeRunProjection("durable-run-1", "running");
        durableProjection = {
          ...completedFixture,
          runs: completedFixture.runs.map((run) => ({
            ...run,
            status: "running",
            completedAt: null,
          })),
          messages: completedFixture.messages.filter((message) =>
            message.id.startsWith("commentary-"),
          ),
        };
        const control = (
          action: "status" | "steer",
          callId: string,
          runId?: string,
          message?: string,
        ) =>
          controlWork!({
            plannerNativeThreadId: "planner-native-1",
            plannerTurnId: `conversation-${callId}`,
            callId,
            action,
            ...(runId === undefined ? {} : { runId }),
            ...(message === undefined ? {} : { message }),
          });
        const beforePriority = decodeWorkStatus(
          yield* control("status", "status-1", "durable-run-1"),
        );
        assert.equal(beforePriority.threadId, threadId);
        assert.equal(beforePriority.environmentId, "env-live-test");
        assert.equal(beforePriority.leaseId, prepared.leaseId);
        assert.equal(beforePriority.generation, prepared.generation);
        assert.deepEqual(beforePriority.tasks, [
          {
            runId: "durable-run-1",
            status: "running",
            resultReady: false,
            commentary: "commentary for durable-run-1",
          },
        ]);
        assert.equal(completedWork, 0);
        yield* Queue.offer(nativeEvents, {
          type: "transcript",
          plannerNativeThreadId: "planner-native-1",
          role: "user",
          text: "Please prioritize the small fix while we keep talking.",
        });
        yield* waitForEvent(
          (event) => event.type === "transcript" && event.text.includes("prioritize"),
        );
        const priority = yield* control(
          "steer",
          "priority-1",
          "durable-run-1",
          "Prioritize the small fix.",
        );
        assert.equal(
          priority,
          yield* control("steer", "priority-1", "durable-run-1", "Prioritize the small fix."),
        );
        assert.equal(steers, 1);
        const changedSteerIntent = yield* Effect.exit(
          control("steer", "priority-1", "durable-run-1", "A different instruction."),
        );
        assert.isTrue(Exit.isFailure(changedSteerIntent));
        const afterPriority = decodeWorkStatus(yield* control("status", "status-2"));
        assert.equal(afterPriority.tasks[0]!.status, "running");
        assert.equal(completedWork, 0);
        assert.equal(sends, 1, "conversational control must never queue a replacement job");
        assert.equal(spoken.length, 0, "no invented final while canonical work is held");
        yield* Queue.offer(nativeEvents, {
          type: "transcript",
          plannerNativeThreadId: "planner-native-1",
          role: "assistant",
          text: "The task is still running; we can keep talking.",
        });
        yield* waitForEvent(
          (event) => event.type === "transcript" && event.text.includes("keep talking"),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(control("status", "foreign-run", "another-thread-run")),
          ),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              controlWork!({
                plannerNativeThreadId: "stale-planner",
                plannerTurnId: "stale",
                callId: "stale",
                action: "status",
              }),
            ),
          ),
        );
        currentPolicy = { ...currentPolicy, cwd: "/changed-context" };
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              control("steer", "changed-context", "durable-run-1", "Must not cross contexts."),
            ),
          ),
        );
        currentPolicy = policy;
        const originalThread = durableProjection.thread;
        durableProjection = {
          ...durableProjection,
          thread: { ...originalThread, id: "other-thread" as never },
        };
        assert.isTrue(Exit.isFailure(yield* Effect.exit(control("status", "changed-thread"))));
        durableProjection = { ...durableProjection, thread: originalThread };
        yield* sql`UPDATE codex_live_voice_leases SET environment_id = 'other-environment' WHERE lease_id = ${prepared.leaseId}`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(control("status", "changed-environment"))));
        yield* sql`UPDATE codex_live_voice_leases SET environment_id = 'env-live-test' WHERE lease_id = ${prepared.leaseId}`;
        rejectSteerAtAdmission = true;
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              control("steer", "rollover", "durable-run-1", "Must not reach the next run."),
            ),
          ),
        );
        rejectSteerAtAdmission = false;
        assert.equal(steers, 1);
        assert.equal(sends, 1);
        yield* Deferred.succeed(workCompletion, undefined);

        durableProjection = makeRunProjection("durable-run-1", "running");
        const firstGateRead = waitForGateRead();
        yield* Queue.offer(
          t3EventQueues.get("run.updated")!,
          eventFor({
            type: "run.updated",
            id: "event-run-1",
            threadId,
            runId: "durable-run-1",
            nodeId: "root-durable-run-1",
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:03.000Z",
            payload: durableProjection.runs[0] as never,
          } as never),
        );
        yield* firstGateRead;
        assert.equal(spoken.length, 0, "a still-running required child blocks speech");
        assert.deepEqual(
          decodeWorkStatus(yield* control("status", "child-pending", "durable-run-1")).tasks,
          [{ runId: "durable-run-1", status: "completed", resultReady: false, commentary: null }],
        );

        durableProjection = {
          ...durableProjection,
          subagents: [{ ...durableProjection.subagents[0]!, status: "completed" }],
        } as unknown as OrchestrationV2ThreadProjection;
        const childGateRead = waitForGateRead();
        yield* Queue.offer(
          t3EventQueues.get("subagent.updated")!,
          eventFor({
            type: "subagent.updated",
            id: "event-child-1",
            threadId,
            runId: "durable-run-1",
            nodeId: "child-durable-run-1",
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:04.000Z",
            payload: durableProjection.subagents[0] as never,
          } as never),
        );
        yield* childGateRead;
        assert.equal(spoken.length, 0, "speech waits for the matching checkpoint");

        durableProjection = {
          ...durableProjection,
          checkpoints: [
            {
              id: "checkpoint-durable-run-1",
              threadId,
              scopeId: "scope-root-1",
              runId: "durable-run-1",
              nodeId: "root-durable-run-1",
              parentCheckpointId: null,
              ordinalWithinScope: 1,
              appRunOrdinal: 1,
              ref: "checkpoint-ref-1",
              status: "ready",
              files: [],
              capturedAt: "2026-10-14T00:00:03.000Z",
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const checkpointGateRead = waitForGateRead();
        yield* Queue.offer(
          t3EventQueues.get("checkpoint.captured")!,
          eventFor({
            type: "checkpoint.captured",
            id: "event-checkpoint-1",
            threadId,
            runId: "durable-run-1",
            nodeId: "root-durable-run-1",
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:03.000Z",
            payload: durableProjection.checkpoints[0] as never,
          } as never),
        );
        yield* checkpointGateRead;
        yield* Effect.promise(() => speechObserved);
        yield* Deferred.await(workFinished);
        assert.equal(completedWork, 1, "the held canonical job completes exactly once");
        assert.deepEqual(
          decodeWorkStatus(yield* control("status", "result-ready", "durable-run-1")).tasks,
          [{ runId: "durable-run-1", status: "completed", resultReady: true, commentary: null }],
        );
        assert.deepEqual(spoken, [
          {
            plannerNativeThreadId: "planner-native-1",
            text: `  ${`durable answer for durable-run-1 `.repeat(400)}\n  `,
          },
        ]);
        const sentReceipt = yield* sql<{ receipt_json: string }>`
          SELECT receipt_json FROM codex_live_voice_intents
          WHERE lease_id = ${prepared.leaseId} AND generation = ${prepared.generation}
            AND planner_turn_id = ${"planner-turn-1"}
        `;
        assert.equal(readbackState(sentReceipt[0]!.receipt_json), "sent");
        speechObserved = new Promise<void>((resolve) => {
          resolveSpeech = resolve;
        });
        appendSpeechFails = true;
        yield* invoke("call-next", "Queue follow-up work", "planner-turn-2");
        assert.equal(sends, 2);
        durableProjection = {
          ...makeRunProjection("durable-run-2", "completed"),
          checkpoints: [
            {
              id: "checkpoint-durable-run-2",
              threadId,
              scopeId: "scope-root-2",
              runId: "durable-run-2",
              nodeId: "root-durable-run-2",
              parentCheckpointId: null,
              ordinalWithinScope: 1,
              appRunOrdinal: 2,
              ref: "checkpoint-ref-2",
              status: "ready",
              files: [],
              capturedAt: "2026-10-14T00:00:03.000Z",
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection;
        const ambiguousGateRead = waitForGateRead();
        yield* Queue.offer(
          t3EventQueues.get("run.updated")!,
          eventFor({
            type: "run.updated",
            id: "event-run-2",
            threadId,
            runId: "durable-run-2",
            nodeId: "root-durable-run-2",
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:03.000Z",
            payload: durableProjection.runs[0] as never,
          } as never),
        );
        yield* ambiguousGateRead;
        yield* Effect.promise(() => appendAttemptObserved);
        assert.equal(appendAttempts, 2);
        assert.equal(
          spoken.length,
          1,
          "ambiguous append acknowledgement is not treated as delivery",
        );
        const unknownReceipt = yield* sql<{ receipt_json: string }>`
          SELECT receipt_json FROM codex_live_voice_intents
          WHERE lease_id = ${prepared.leaseId} AND generation = ${prepared.generation}
            AND planner_turn_id = ${"planner-turn-2"}
        `;
        assert.equal(readbackState(unknownReceipt[0]!.receipt_json), "unknown");
        appendAttemptObserved = new Promise<void>((resolve) => {
          resolveAppendAttempt = resolve;
        });
        const duplicateReadback = yield* invoke(
          "call-next-retry",
          "Queue follow-up work",
          "planner-turn-2",
        );
        assert.equal(
          duplicateReadback,
          yield* invoke("call-next-again", "Queue follow-up work", "planner-turn-2"),
        );
        assert.equal(appendAttempts, 2, "a claimed readback is never blindly retried");

        appendSpeechFails = false;
        yield* invoke("call-empty-final", "Queue commentary and an empty final", "planner-turn-3");
        assert.equal(sends, 3);
        durableProjection = makeReadyProjection("durable-run-3", 3, " \t\n");
        const emptyFinalGateRead = waitForGateRead();
        yield* Queue.offer(
          t3EventQueues.get("run.updated")!,
          eventFor({
            type: "run.updated",
            id: "event-run-3",
            threadId,
            runId: "durable-run-3",
            nodeId: "root-durable-run-3",
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:03.000Z",
            payload: durableProjection.runs[0] as never,
          } as never),
        );
        yield* emptyFinalGateRead;
        assert.equal(
          appendAttempts,
          2,
          "an empty terminal final item cannot fall back to earlier commentary",
        );
        const staleGeneration = yield* Effect.exit(
          service.status(session, {
            leaseId: prepared.leaseId,
            generation: prepared.generation + 1,
          }),
        );
        assert.isTrue(Exit.isFailure(staleGeneration));
        const staleReplay = yield* Effect.exit(
          invoke("call-stale-retry", "A request captured under old settings", "planner-turn-stale"),
        );
        assert.isTrue(Exit.isFailure(staleReplay));
        assert.equal(sends, 3);
        const changedIntent = yield* Effect.exit(invoke("call-3", "Submit a different request"));
        assert.isTrue(Exit.isFailure(changedIntent));
        assert.equal(sends, 3);

        const wrongSubject = {
          ...session,
          subject: "different-subject",
        };
        const unauthorized = yield* Effect.exit(
          service.status(wrongSubject, {
            leaseId: prepared.leaseId,
            generation: prepared.generation,
          }),
        );
        assert.isTrue(Exit.isFailure(unauthorized));

        const workReceiptBeforeStop = yield* invoke(
          "call-before-stop",
          "Queue work that must outlive Live",
          "planner-turn-4",
        );
        assert.equal(sends, 4);
        durableProjection = makeReadyProjection("durable-run-4", 4);
        const stopped = yield* service.stop(session, {
          leaseId: prepared.leaseId,
          generation: prepared.generation,
          clientRequestId: "stop-1",
        });
        assert.equal(stopped.status, "stopping");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(control("status", "after-end"))));
        assert.equal(stops, 1);
        assert.equal(sends, 4);
        yield* Queue.offer(
          t3EventQueues.get("run.updated")!,
          eventFor({
            type: "run.updated",
            id: "event-run-4",
            threadId,
            runId: "durable-run-4",
            nodeId: "root-durable-run-4",
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:03.000Z",
            payload: durableProjection.runs[0] as never,
          } as never),
        );
        yield* Effect.yieldNow;
        assert.equal(
          appendAttempts,
          2,
          "Stop Live suppresses readback without cancelling queued work",
        );
        const acceptedWorkAfterStop = yield* invoke(
          "call-5",
          "Queue work that must outlive Live",
          "planner-turn-4",
        );
        assert.equal(acceptedWorkAfterStop, workReceiptBeforeStop);
        const afterStop = yield* Effect.exit(
          invoke("call-6", "A request after stopping is refused", "planner-turn-5"),
        );
        assert.isTrue(Exit.isFailure(afterStop));
        assert.equal(sends, 4);
        const statusesBeforeLateReadiness = observedStatuses.length;
        yield* Queue.offer(nativeEvents, {
          type: "started",
          plannerNativeThreadId: "planner-native-1",
          realtimeSessionId: `${prepared.leaseId}:${prepared.generation}`,
        });
        yield* Queue.offer(nativeEvents, {
          type: "sdp",
          plannerNativeThreadId: "planner-native-1",
          sdp: "late-answer-after-stop",
        });
        yield* Queue.offer(nativeEvents, {
          type: "closed",
          plannerNativeThreadId: "planner-native-1",
        });
        yield* waitForEvent(
          (event) =>
            event.type === "status" &&
            event.session.leaseId === prepared.leaseId &&
            event.session.generation === prepared.generation &&
            event.session.status === "closed",
        );

        assert.isFalse(
          observedStatuses.slice(statusesBeforeLateReadiness).includes("active"),
          "late readiness must not resurrect a stopping call",
        );

        durableProjection = {
          ...projection,
          providerSessions: [{ id: secondProviderSessionId, providerInstanceId }],
          runs: [],
          attempts: [],
          nodes: [],
          subagents: [],
          checkpoints: [],
          messages: [],
          turnItems: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const secondPrepared = yield* service.prepare(session, {
          threadId,
          clientRequestId: "prepare-2",
        });
        assert.equal(secondPrepared.providerSessionId, secondProviderSessionId);
        assert.equal(secondPrepared.plannerNativeThreadId, "planner-native-2");
        yield* service
          .subscribe(session, {
            leaseId: secondPrepared.leaseId,
            generation: secondPrepared.generation,
          })
          .pipe(
            Stream.runForEach((event) => Queue.offer(delivered, event)),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* waitForEvent(
          (event) =>
            event.type === "status" &&
            event.session.leaseId === secondPrepared.leaseId &&
            event.session.generation === secondPrepared.generation &&
            event.session.status === "prepared",
        );
        yield* service.start(session, {
          leaseId: secondPrepared.leaseId,
          generation: secondPrepared.generation,
          offerSdp: "v=0\\r\\n",
          clientRequestId: "start-2",
        });
        yield* Queue.offer(secondNativeEvents, {
          type: "started",
          plannerNativeThreadId: "planner-native-1",
          realtimeSessionId: `${prepared.leaseId}:${prepared.generation}`,
        });
        yield* Queue.offer(secondNativeEvents, {
          type: "sdp",
          plannerNativeThreadId: "planner-native-2",
          sdp: "v=0\\r\\nanswer",
        });
        yield* Queue.offer(secondNativeEvents, {
          type: "started",
          plannerNativeThreadId: "planner-native-2",
          realtimeSessionId: `${secondPrepared.leaseId}:${secondPrepared.generation}`,
        });
        yield* waitForEvent(
          (event) =>
            event.type === "status" &&
            event.session.leaseId === secondPrepared.leaseId &&
            event.session.generation === secondPrepared.generation &&
            event.session.status === "active",
        );

        assert.equal(
          (yield* service.status(session, {
            leaseId: prepared.leaseId,
            generation: prepared.generation,
          })).status,
          "closed",
          "an old planner notification cannot resurrect the ended call",
        );

        const raceReceipt = yield* invokeWithPlanner(
          "planner-native-2",
          "call-native-error-race",
          "Queue readback before a native failure",
          "planner-turn-native-error-race",
        );
        assert.equal(sends, 5);
        const raceRunId = `durable-run-${sends}`;
        durableProjection = makeReadyProjection(raceRunId, 5);
        const principalGate = holdDispatchPrincipalLookup();
        const raceGateRead = waitForGateRead();
        yield* Queue.offer(
          t3EventQueues.get("run.updated")!,
          eventFor({
            type: "run.updated",
            id: "event-run-native-error-race",
            threadId,
            runId: raceRunId,
            nodeId: `root-${raceRunId}`,
            providerInstanceId,
            occurredAt: "2026-10-14T00:00:03.000Z",
            payload: durableProjection.runs[0] as never,
          } as never),
        );
        yield* raceGateRead;
        yield* Effect.promise(() => principalGate.started);
        yield* Queue.offer(secondNativeEvents, {
          type: "error",
          plannerNativeThreadId: "planner-native-2",
        });
        yield* waitForEvent(
          (event) =>
            event.type === "status" &&
            event.session.leaseId === secondPrepared.leaseId &&
            event.session.generation === secondPrepared.generation &&
            event.session.status === "failed",
        );
        principalGate.release();
        const duplicateRaceReceipt = yield* invokeWithPlanner(
          "planner-native-2",
          "call-native-error-race",
          "Queue readback before a native failure",
          "planner-turn-native-error-race",
        );
        assert.equal(duplicateRaceReceipt, raceReceipt);
        assert.equal(sends, 5);
        assert.equal(
          appendAttempts,
          2,
          "a native failure committed during principal lookup prevents appendSpeech",
        );
        const refusedReceipt = yield* sql<{ receipt_json: string }>`
          SELECT receipt_json FROM codex_live_voice_intents
          WHERE lease_id = ${secondPrepared.leaseId}
            AND generation = ${secondPrepared.generation}
            AND planner_turn_id = ${"planner-turn-native-error-race"}
        `;
        assert.equal(readbackState(refusedReceipt[0]!.receipt_json), "refused");
        assert.isString(raceReceipt);

        for (const code of ["managed_account_required", "planner_restriction_failed"] as const) {
          plannerFailure = code;
          const clientRequestId = `prepare-failure-${code}`;
          const error = yield* Effect.flip(service.prepare(session, { threadId, clientRequestId }));
          assert.equal(error.code, code);
          const failed = yield* service.prepare(session, { threadId, clientRequestId });
          assert.equal(failed.status, "failed");
          assert.isNull(failed.plannerNativeThreadId);
          const attempts = plannerAttempts;
          assert.equal(
            (yield* service.prepare(session, { threadId, clientRequestId })).leaseId,
            failed.leaseId,
          );
          assert.equal(plannerAttempts, attempts, "a failed prepare request remains idempotent");
        }

        const historical = yield* service.prepare(session, {
          threadId,
          clientRequestId: "prepare-failure-planner_restriction_failed",
        });
        const lease = {
          leaseId: historical.leaseId,
          generation: historical.generation,
          clientRequestId: "stop-historical",
        };
        yield* sql`UPDATE codex_live_voice_leases SET status = 'unknown' WHERE lease_id = ${lease.leaseId}`;
        const status = () => service.status(session, lease).pipe(Effect.map((value) => value.status));
        for (const invalidPrincipal of [
          { ...session, scopes: [] },
          { ...session, subject: "different-subject" },
          { ...session, sessionId: AuthSessionId.make("different-session") },
        ]) {
          assert.isTrue(Exit.isFailure(yield* Effect.exit(service.stop(invalidPrincipal, lease))));
          assert.equal(yield* status(), "unknown");
        }
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              service.stop(session, { ...lease, generation: lease.generation + 1 }),
            ),
          ),
        );
        yield* sql`UPDATE codex_live_voice_leases SET principal_session_id = 'different-owner' WHERE lease_id = ${lease.leaseId}`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(service.stop(session, lease))));
        yield* sql`UPDATE codex_live_voice_leases SET principal_session_id = ${sessionId},
          planner_native_thread_id = 'unresolved-native-planner', provider_session_id = NULL
          WHERE lease_id = ${lease.leaseId}`;
        assert.equal(
          (yield* service.stop(session, lease)).status,
          "unknown",
          "a lease that may own a native planner cannot be cleared locally",
        );
        yield* sql`UPDATE codex_live_voice_leases SET planner_native_thread_id = NULL WHERE lease_id = ${lease.leaseId}`;
        const stopsBeforeHistorical = stops;
        assert.equal((yield* service.stop(session, lease)).status, "failed");
        assert.equal(stops, stopsBeforeHistorical, "no native session exists to stop");
        const neverStartedOrphan = {
          principalSessionId: String(sessionId),
          principalSubject: session.subject,
          status: "unknown",
          plannerNativeThreadId: null as string | null,
          nativeStarted: 0,
          nativeSdpReceived: 0,
          startClientRequestId: null as string | null,
        };
        for (const unsafe of [
          { ...neverStartedOrphan, reason: "foreign-session", principalSessionId: "different-owner" },
          { ...neverStartedOrphan, reason: "foreign-subject", principalSubject: "different-subject" },
          { ...neverStartedOrphan, reason: "not-unknown", status: "prepared" },
          { ...neverStartedOrphan, reason: "planner", plannerNativeThreadId: "unresolved-planner" },
          { ...neverStartedOrphan, reason: "native-started", nativeStarted: 1 },
          { ...neverStartedOrphan, reason: "native-sdp", nativeSdpReceived: 1 },
          { ...neverStartedOrphan, reason: "start-request", startClientRequestId: "uncertain-start" },
        ]) {
          yield* sql`UPDATE codex_live_voice_leases SET
            principal_session_id = ${unsafe.principalSessionId},
            principal_subject = ${unsafe.principalSubject}, status = ${unsafe.status},
            planner_native_thread_id = ${unsafe.plannerNativeThreadId},
            native_started = ${unsafe.nativeStarted}, native_sdp_received = ${unsafe.nativeSdpReceived},
            start_client_request_id = ${unsafe.startClientRequestId}
            WHERE lease_id = ${lease.leaseId}`;
          const error = yield* Effect.flip(
            service.prepare(session, { threadId, clientRequestId: `unsafe-orphan-${unsafe.reason}` }),
          );
          assert.equal(error.code, "dispatch_conflict", unsafe.reason);
          const persisted = yield* sql<{ status: string }>`
            SELECT status FROM codex_live_voice_leases WHERE lease_id = ${lease.leaseId}
          `;
          assert.equal(persisted[0]!.status, unsafe.status, "unsafe leases remain untouched");
        }
        yield* sql`UPDATE codex_live_voice_leases SET
          principal_session_id = ${sessionId}, principal_subject = ${session.subject}, status = 'unknown',
          planner_native_thread_id = NULL, native_started = 0, native_sdp_received = 0,
          start_client_request_id = NULL WHERE lease_id = ${lease.leaseId}`;
        plannerFailure = undefined;
        const retry = yield* service.prepare(session, {
          threadId,
          clientRequestId: "prepare-after-restart-orphan",
        });
        const retiredOrphan = yield* sql<{ status: string }>`
          SELECT status FROM codex_live_voice_leases WHERE lease_id = ${lease.leaseId}
        `;
        assert.equal(retiredOrphan[0]!.status, "failed", "new prepare retires only its own never-started orphan");
        assert.equal(stops, stopsBeforeHistorical, "orphan recovery never calls the native runtime");
        assert.equal(
          retry.status,
          "prepared",
          "failed preparation and historical empty leases do not block a new call",
        );
        yield* sql`UPDATE codex_live_voice_leases SET status = 'unknown',
          planner_native_thread_id = NULL WHERE lease_id = ${retry.leaseId}`;
        const activeConflict = yield* Effect.flip(
          service.prepare(session, { threadId, clientRequestId: "active-runtime-is-not-an-orphan" }),
        );
        assert.equal(activeConflict.code, "dispatch_conflict", "an in-memory active lease cannot be retired");
        yield* sql`UPDATE codex_live_voice_leases SET status = 'prepared',
          planner_native_thread_id = ${retry.plannerNativeThreadId} WHERE lease_id = ${retry.leaseId}`;
      });
      yield* program.pipe(
        Effect.provide(Layer.provideMerge(CodexLiveSessionService.layer, dependencies)),
      );
    }),
);
