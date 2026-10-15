import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  RunId,
  NodeId,
  MessageId,
  ProviderInstanceId,
  ProviderDriverKind,
  type JarvisCapabilityJobRequest,
  type JarvisNativeRequest,
  type JarvisNativeNotification,
  type JarvisNativeResponse,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Run,
  type OrchestrationV2ExecutionNode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as JarvisClient from "./JarvisClient.ts";
import * as JarvisService from "./JarvisService.ts";

const environmentId = EnvironmentId.make("jarvis-env");
const parentThreadId = ThreadId.make("jarvis-parent");
const childThreadId = ThreadId.make("jarvis-child");
const parentRunId = RunId.make("parent-run");
const childRunId = RunId.make("child-run");
const parentRootId = NodeId.make("parent-root");
const childRootId = NodeId.make("actual-child-root");
const taskId = NodeId.make("task-node-NOT-child-root");
const providerInstanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-10-15T00:00:00Z");
const scope: McpInvocationScope = {
  environmentId,
  requestNamespace: "provider-session:actual-child",
  thread: { threadId: childThreadId, providerSessionId: "fixture-session", providerInstanceId },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const invocation: JarvisCapabilityJobRequest = {
  engineSessionId: "engine-1",
  capabilityId: "browser.fill",
  operationId: "fill",
  registrationRevision: "browser-1",
  arguments: { text: "bounded fixture" },
  target: {
    targetId: "field-1",
    targetKind: "browser_input",
    surfaceId: "owned-tab",
    generation: "1",
    observedContextId: "context-1",
    observedObservationId: "observation-1",
  },
};

const run = (threadId: ThreadId, id: RunId, rootNodeId: NodeId): OrchestrationV2Run => ({
  id,
  threadId,
  ordinal: 1,
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-6.1-sol" },
  providerThreadId: null,
  userMessageId: MessageId.make(`${id}:message`),
  rootNodeId,
  activeAttemptId: null,
  status: "running",
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});
const root = (threadId: ThreadId, runId: RunId, id: NodeId): OrchestrationV2ExecutionNode => ({
  id,
  threadId,
  runId,
  parentNodeId: null,
  rootNodeId: id,
  kind: "root_turn",
  status: "running",
  countsForRun: true,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: null,
  startedAt: now,
  completedAt: null,
});

const fixture = (
  options: {
    readonly paused?: {
      readonly started: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
    readonly streamEpoch?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const parent = idleThreadProjection(liveThreadShell(parentThreadId));
    const child = idleThreadProjection(liveThreadShell(childThreadId));
    const parentProjection: OrchestrationV2ThreadProjection = {
      ...parent,
      runs: [run(parentThreadId, parentRunId, parentRootId)],
      nodes: [root(parentThreadId, parentRunId, parentRootId)],
      subagents: [
        {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId: parentRootId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Controlled native roundtrip",
          title: null,
          model: "gpt-6.1-sol",
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      ],
    };
    const childProjection: OrchestrationV2ThreadProjection = {
      ...child,
      thread: {
        ...child.thread,
        lineage: { rootThreadId: parentThreadId, parentThreadId, relationshipToParent: "subagent" },
      },
      runs: [run(childThreadId, childRunId, childRootId)],
      nodes: [root(childThreadId, childRunId, childRootId)],
    };
    const childState = yield* Ref.make(childProjection);
    const calls = yield* Ref.make<ReadonlyArray<JarvisNativeRequest>>([]);
    const subscriptions = yield* Ref.make(0);
    const transport = JarvisClient.JarvisClient.of({
      engineSessionId: "engine-1",
      call: (request) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (requests) => [...requests, request]);
          if (options.paused) {
            yield* Deferred.succeed(options.paused.started, undefined);
            yield* Deferred.await(options.paused.release);
          }
          return {
            jsonrpc: "2.0",
            id: request.id,
            result:
              request.method === "jarvis.submit"
                ? {
                    schema: "jarvis.v1",
                    requestId: request.params.requestId,
                    status: "accepted",
                    jobId: "job-1",
                  }
                : { schema: "jarvis.v1", engineSessionId: "engine-1" },
          } satisfies JarvisNativeResponse;
        }),
      subscribe: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Ref.update(subscriptions, (count) => count + 1);
            const ack: JarvisNativeResponse = {
              jsonrpc: "2.0",
              id: request.id,
              result: { schema: "jarvis.v1", engineSessionId: "engine-1", cursor: "100", jobs: [] },
            };
            const event: JarvisNativeNotification = {
              jsonrpc: "2.0",
              method: "jarvis.event",
              params: {
                engineSessionId: options.streamEpoch ?? "engine-1",
                event: {
                  schema: "jarvis.v1",
                  sequence: "107",
                  emittedAt: "2026-10-15T00:00:00Z",
                  jobId: "job-1",
                  payload: { kind: "job_changed" },
                },
              },
            };
            return Stream.make(ack, event);
          }),
        ),
    });
    const dependencies = Layer.mergeAll(
      Layer.succeed(JarvisClient.JarvisClient, transport),
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadRecords: (id) =>
          id === parentThreadId ? Effect.succeed(parentProjection) : Ref.get(childState),
      }),
    );
    return {
      dependencies,
      layer: JarvisService.layer.pipe(Layer.provide(dependencies)),
      childState,
      calls,
      subscriptions,
    };
  });

describe("Jarvis bound capability service", () => {
  it.effect(
    "derives actual task lineage and child root, with stable Host-owned admission IDs",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          const service = yield* JarvisService.JarvisService;
          const first = yield* service.submit(scope, { clientRequestId: "once", invocation });
          const repeated = yield* service.submit(scope, { clientRequestId: "once", invocation });
          expect(first.origin).toMatchObject({
            taskId,
            childThreadId,
            childRunId,
            childRootNodeId: childRootId,
            parentRootNodeId: parentRootId,
          });
          expect(first.origin.childRootNodeId).not.toBe(first.origin.taskId);
          expect(repeated.result).toMatchObject({ jobId: "job-1", status: "accepted" });
          const calls = yield* Ref.get(f.calls);
          expect(calls).toHaveLength(2);
          const a = calls[0]!;
          const b = calls[1]!;
          if (a.method !== "jarvis.submit" || b.method !== "jarvis.submit")
            return yield* Effect.die("Expected canonical submit calls");
          expect(a.params.requestId).toBe(b.params.requestId);
          expect(a.params.clientMessageId).toBe(b.params.clientMessageId);
          expect(a.params).not.toHaveProperty("conversationId");
          expect(a.params).not.toHaveProperty("envelope");
          expect(a.params.binding.origin.childRootNodeId).toBe(childRootId);
        }).pipe(Effect.provide(f.layer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "refuses external, cross-environment and stale-provider callers before native transport",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          const service = yield* JarvisService.JarvisService;
          const denied: ReadonlyArray<McpInvocationScope> = [
            {
              ...scope,
              thread: undefined,
              client: { sessionId: "outside", label: "outside", access: "read-only" },
            },
            { ...scope, environmentId: EnvironmentId.make("other") },
            {
              ...scope,
              thread: { ...scope.thread!, providerInstanceId: ProviderInstanceId.make("other") },
            },
          ];
          for (const caller of denied) {
            yield* service.catalog(caller).pipe(Effect.flip);
          }
          expect(yield* Ref.get(f.calls)).toHaveLength(0);
        }).pipe(Effect.provide(f.layer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not substitute the task-node alias when the actual child root is absent", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Ref.update(f.childState, (child) => ({
        ...child,
        runs: child.runs.map((run) => ({ ...run, rootNodeId: taskId })),
      }));
      yield* Effect.gen(function* () {
        expect(
          (yield* (yield* JarvisService.JarvisService).catalog(scope).pipe(Effect.flip)).code,
        ).toBe("unavailable");
      }).pipe(Effect.provide(f.layer));
      expect(yield* Ref.get(f.calls)).toHaveLength(0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reports unknown after a real transport await changes the active child root, without resubmission",
    () =>
      Effect.gen(function* () {
        const paused = {
          started: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        const f = yield* fixture({ paused });
        yield* Effect.gen(function* () {
          const service = yield* JarvisService.JarvisService;
          const pending = yield* service
            .submit(scope, { clientRequestId: "paused", invocation })
            .pipe(Effect.flip, Effect.forkChild);
          yield* Deferred.await(paused.started);
          const changedRoot = NodeId.make("new-child-root");
          yield* Ref.update(f.childState, (child) => ({
            ...child,
            runs: child.runs.map((run) => ({ ...run, rootNodeId: changedRoot })),
            nodes: [...child.nodes, root(childThreadId, childRunId, changedRoot)],
          }));
          yield* Deferred.succeed(paused.release, undefined);
          expect((yield* Fiber.join(pending)).code).toBe("outcome_unknown");
          expect(yield* Ref.get(f.calls)).toHaveLength(1);
        }).pipe(Effect.provide(f.layer));
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps App cursor gaps and epoch binding without inventing replay or reconnecting",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          const result = yield* (yield* JarvisService.JarvisService).events(scope, {
            timeoutMs: 1000,
          });
          expect(result.result).toMatchObject({
            snapshot: { cursor: "100" },
            event: { method: "jarvis.event", params: { event: { sequence: "107" } } },
            timedOut: false,
          });
        }).pipe(Effect.provide(f.layer));
        expect(yield* Ref.get(f.subscriptions)).toBe(1);
        const wrongEpoch = yield* fixture({ streamEpoch: "new-engine" });
        yield* Effect.gen(function* () {
          expect(
            (yield* (yield* JarvisService.JarvisService)
              .events(scope, { timeoutMs: 1000 })
              .pipe(Effect.flip)).code,
          ).toBe("outcome_unknown");
        }).pipe(Effect.provide(wrongEpoch.layer));
        expect(yield* Ref.get(wrongEpoch.subscriptions)).toBe(1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "refuses a configured plan-mode submit and wrong invocation engine without dispatch",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Ref.update(f.childState, (child) => ({
          ...child,
          thread: { ...child.thread, interactionMode: "plan" },
        }));
        yield* Effect.gen(function* () {
          const service = yield* JarvisService.JarvisService;
          expect(
            (yield* service
              .submit(scope, { clientRequestId: "plan", invocation })
              .pipe(Effect.flip)).code,
          ).toBe("capability_denied");
          expect(
            (yield* service
              .prepare(scope, { ...invocation, engineSessionId: "other" })
              .pipe(Effect.flip)).code,
          ).toBe("invalid_request");
        }).pipe(Effect.provide(f.layer));
        expect(yield* Ref.get(f.calls)).toHaveLength(0);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.effect("registers real MCP tools and returns bound data while rejecting an outside writer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const client = McpSchema.McpServerClient.of({
        clientId: 1,
        protocolVersion: "2025-06-18",
        clientCapabilities: {},
        clientInfo: { name: "jarvis-fixture", version: "1" },
        initializePayload: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "jarvis-fixture", version: "1" },
        },
        getClient: Effect.die("unused"),
      });
      const layer = McpHttpServer.layerJarvisToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(f.dependencies),
      );
      yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const actual = yield* server
          .callTool({ name: "jarvis_catalog", arguments: {} })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(actual.isError).not.toBe(true);
        expect(actual.structuredContent).toMatchObject({
          engineSessionId: "engine-1",
          origin: { childRootNodeId: childRootId, taskId },
          result: { schema: "jarvis.v1" },
        });
        const outside: McpInvocationScope = {
          ...scope,
          thread: undefined,
          client: { sessionId: "outside", label: "outside", access: "read-only" },
        };
        const refused = yield* server
          .callTool({
            name: "jarvis_submit",
            arguments: { clientRequestId: "outside", invocation },
          })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, outside),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(refused.isError).toBe(true);
        expect(yield* Ref.get(f.calls)).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
