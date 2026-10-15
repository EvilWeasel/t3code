import {
  JarvisMcpFailure,
  type JarvisMcpResult,
  JarvisCapabilityJobRequest,
  JarvisNativeBinding,
  JarvisNativeRequest,
  JarvisNativeNotification,
  JarvisNativeResponse,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as JarvisClient from "./JarvisClient.ts";

export class JarvisService extends Context.Service<
  JarvisService,
  {
    readonly catalog: (
      scope: McpInvocationScope,
    ) => Effect.Effect<JarvisMcpResult, JarvisMcpFailure>;
    readonly observe: (
      scope: McpInvocationScope,
      input: { readonly cursor?: string | undefined },
    ) => Effect.Effect<JarvisMcpResult, JarvisMcpFailure>;
    readonly prepare: (
      scope: McpInvocationScope,
      invocation: JarvisCapabilityJobRequest,
    ) => Effect.Effect<JarvisMcpResult, JarvisMcpFailure>;
    readonly submit: (
      scope: McpInvocationScope,
      input: { readonly clientRequestId: string; readonly invocation: JarvisCapabilityJobRequest },
    ) => Effect.Effect<JarvisMcpResult, JarvisMcpFailure>;
    readonly status: (
      scope: McpInvocationScope,
      input: { readonly jobId: string },
    ) => Effect.Effect<JarvisMcpResult, JarvisMcpFailure>;
    readonly cancel: (
      scope: McpInvocationScope,
      input: { readonly clientRequestId: string; readonly jobId: string },
    ) => Effect.Effect<JarvisMcpResult, JarvisMcpFailure>;
    readonly events: (
      scope: McpInvocationScope,
      input: { readonly timeoutMs?: number | undefined },
    ) => Effect.Effect<JarvisMcpResult, JarvisMcpFailure>;
  }
>()("t3/integrations/jarvis/JarvisService") {}

const failure = (code: JarvisMcpFailure["code"], message: string) =>
  new JarvisMcpFailure({ code, message });
const unavailable = () =>
  failure("unavailable", "The bound Jarvis capability service is unavailable.");
const unknownOutcome = () =>
  failure(
    "outcome_unknown",
    "The operation outcome or caller binding changed. Reconcile the existing request/job; do not resubmit automatically.",
  );
const mapTransportFailure = (error: JarvisClient.JarvisTransportError) =>
  failure(error.code === "outcome_unknown" ? "outcome_unknown" : "unavailable", error.message);
const bindingCodec = Schema.fromJsonString(JarvisNativeBinding);
const jsonCodec = Schema.fromJsonString(Schema.Json);

const make = Effect.gen(function* () {
  const client = yield* JarvisClient.JarvisClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const crypto = yield* Crypto.Crypto;

  // Every field comes from authenticated scope and canonical projections.
  // In particular, task.id/DelegateTaskResult.childNodeId is never a child root.
  const bindingFor = (scope: McpInvocationScope) =>
    Effect.gen(function* () {
      if (
        !scope.capabilities.has("orchestration") ||
        scope.thread === undefined ||
        scope.client !== undefined
      )
        return yield* failure(
          "capability_denied",
          "This route requires an actual Morrowbyte child provider caller.",
        );
      const environmentId = yield* environment.getEnvironmentId;
      if (scope.environmentId !== environmentId || client.engineSessionId === null)
        return yield* unavailable();
      const child = yield* threads
        .getThreadRecords(scope.thread.threadId, ["runs", "nodes"])
        .pipe(Effect.mapError(unavailable));
      const run = ThreadManagement.latestActiveRun(child);
      const parentThreadId = child.thread.lineage.parentThreadId;
      if (
        child.thread.deletedAt !== null ||
        child.thread.archivedAt !== null ||
        child.thread.lineage.relationshipToParent !== "subagent" ||
        parentThreadId === null ||
        run === undefined ||
        run.rootNodeId === null ||
        run.providerInstanceId !== scope.thread.providerInstanceId
      )
        return yield* unavailable();
      const root = child.nodes.find(
        (node) =>
          node.id === run.rootNodeId &&
          node.runId === run.id &&
          node.kind === "root_turn" &&
          node.rootNodeId === node.id &&
          node.parentNodeId === null,
      );
      if (root === undefined) return yield* unavailable();
      const parent = yield* threads
        .getThreadRecords(parentThreadId, ["subagents", "nodes"])
        .pipe(Effect.mapError(unavailable));
      if (parent.thread.deletedAt !== null || parent.thread.projectId !== child.thread.projectId)
        return yield* unavailable();
      const task = parent.subagents.find(
        (candidate) =>
          candidate.origin === "app_owned" &&
          candidate.childThreadId === child.thread.id &&
          candidate.threadId === parentThreadId &&
          candidate.runId !== null,
      );
      if (task === undefined || task.runId === null) return yield* unavailable();
      const parentRoot = parent.nodes.find(
        (node) =>
          node.id === task.parentNodeId &&
          node.runId === task.runId &&
          node.kind === "root_turn" &&
          node.rootNodeId === node.id &&
          node.parentNodeId === null,
      );
      if (parentRoot === undefined) return yield* unavailable();
      return {
        binding: {
          engineSessionId: client.engineSessionId,
          origin: {
            environmentId,
            projectId: child.thread.projectId,
            parentThreadId,
            parentRunId: task.runId,
            parentRootNodeId: parentRoot.id,
            taskId: task.id,
            childThreadId: child.thread.id,
            childRunId: run.id,
            childRootNodeId: root.id,
          },
        } satisfies JarvisNativeBinding,
        interactionMode: child.thread.interactionMode,
      };
    });

  const recheck = (scope: McpInvocationScope, binding: JarvisNativeBinding) =>
    Effect.gen(function* () {
      const current = yield* bindingFor(scope).pipe(Effect.mapError(unknownOutcome));
      const before = yield* Schema.encodeEffect(bindingCodec)(binding).pipe(
        Effect.mapError(unknownOutcome),
      );
      const after = yield* Schema.encodeEffect(bindingCodec)(current.binding).pipe(
        Effect.mapError(unknownOutcome),
      );
      if (before !== after) return yield* unknownOutcome();
    });
  const requestId = (
    scope: McpInvocationScope,
    binding: JarvisNativeBinding,
    operation: string,
    key: string,
  ) =>
    Effect.gen(function* () {
      if (key.trim().length === 0 || key.length > 256)
        return yield* failure("invalid_request", "Use one bounded stable request key.");
      const encoded = yield* Schema.encodeEffect(jsonCodec)([
        scope.requestNamespace,
        binding.origin.taskId,
        binding.origin.childRunId,
        operation,
        key,
      ]).pipe(Effect.mapError(unavailable));
      const digest = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(encoded))
        .pipe(Effect.mapError(unavailable));
      return `morrowbyte:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    });
  const resultFrom = (response: JarvisNativeResponse) =>
    Effect.gen(function* () {
      if ("error" in response) {
        const detail = response.error.data;
        if (Schema.is(Schema.JsonObject)(detail) && detail.code === "outcome_unknown")
          return yield* unknownOutcome();
        return yield* failure("host_error", response.error.message);
      }
      return response.result;
    });
  const call = (
    scope: McpInvocationScope,
    method: JarvisNativeRequest["method"],
    fields: Schema.JsonObject = {},
    write = false,
    expectedBinding?: JarvisNativeBinding,
  ) =>
    Effect.gen(function* () {
      const { binding, interactionMode } = yield* bindingFor(scope);
      if (expectedBinding !== undefined) yield* recheck(scope, expectedBinding);
      if (write && interactionMode === "plan")
        return yield* failure(
          "capability_denied",
          "The caller's configured plan mode does not submit capability work.",
        );
      const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable));
      const request = yield* Schema.decodeUnknownEffect(JarvisNativeRequest)({
        jsonrpc: "2.0",
        id,
        method,
        params: { binding, ...fields },
      }).pipe(
        Effect.mapError(() => failure("invalid_request", "Invalid canonical capability request.")),
      );
      const response = yield* client.call(request).pipe(Effect.mapError(mapTransportFailure));
      yield* recheck(scope, binding);
      const result = yield* resultFrom(response);
      if (
        Schema.is(Schema.JsonObject)(result) &&
        "engineSessionId" in result &&
        result.engineSessionId !== binding.engineSessionId
      )
        return yield* unknownOutcome();
      return { engineSessionId: binding.engineSessionId, origin: binding.origin, result };
    });
  const invocationFields = (invocation: JarvisCapabilityJobRequest) =>
    Effect.gen(function* () {
      if (invocation.engineSessionId !== client.engineSessionId)
        return yield* failure(
          "invalid_request",
          "Invocation belongs to another configured engine.",
        );
      return yield* Schema.encodeEffect(Schema.toCodecJson(JarvisCapabilityJobRequest))(
        invocation,
      ).pipe(Effect.mapError(() => failure("invalid_request", "Invalid canonical invocation.")));
    });

  return JarvisService.of({
    catalog: (scope) => call(scope, "jarvis.catalog"),
    observe: (scope, input) =>
      call(scope, "jarvis.observe", {
        query: {
          engineSessionId: client.engineSessionId,
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        },
      }),
    prepare: (scope, invocation) =>
      invocationFields(invocation).pipe(
        Effect.flatMap((encoded) => call(scope, "jarvis.prepare", { invocation: encoded })),
      ),
    submit: (scope, input) =>
      Effect.gen(function* () {
        const { binding } = yield* bindingFor(scope);
        const key = yield* requestId(scope, binding, "submit", input.clientRequestId);
        const invocation = yield* invocationFields(input.invocation);
        // No conversation is supplied by the caller. Host uses its private origin binding.
        return yield* call(
          scope,
          "jarvis.submit",
          { requestId: key, clientMessageId: key, invocation },
          true,
          binding,
        );
      }),
    status: (scope, input) => call(scope, "jarvis.status", { jobId: input.jobId }),
    cancel: (scope, input) =>
      Effect.gen(function* () {
        const { binding } = yield* bindingFor(scope);
        const key = yield* requestId(scope, binding, "cancel", input.clientRequestId);
        return yield* call(
          scope,
          "jarvis.cancel",
          { jobId: input.jobId, requestId: key },
          false,
          binding,
        );
      }),
    events: (scope, input) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { binding } = yield* bindingFor(scope);
          const timeoutMs = input.timeoutMs ?? 0;
          if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000)
            return yield* failure(
              "invalid_request",
              "Event waits must be between zero and 30000 milliseconds.",
            );
          const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable));
          const request = {
            jsonrpc: "2.0",
            id,
            method: "jarvis.subscribe",
            params: { binding },
          } as const;
          const captured = yield* Ref.make<ReadonlyArray<Schema.Json>>([]);
          const consume = client.subscribe(request).pipe(
            Stream.take(timeoutMs === 0 ? 1 : 2),
            Stream.runForEach((message) =>
              Effect.gen(function* () {
                if ("id" in message) {
                  const snapshot = yield* resultFrom(message);
                  if (
                    !Schema.is(Schema.JsonObject)(snapshot) ||
                    snapshot.schema !== "jarvis.v1" ||
                    snapshot.engineSessionId !== binding.engineSessionId
                  )
                    return yield* unknownOutcome();
                  yield* Ref.update(captured, (messages) => [...messages, snapshot]);
                  return;
                }
                if (
                  message.method === "jarvis.stream_error" ||
                  message.params.engineSessionId !== binding.engineSessionId
                )
                  return yield* unknownOutcome();
                const event = yield* Schema.encodeEffect(
                  Schema.toCodecJson(JarvisNativeNotification),
                )(message).pipe(Effect.mapError(unknownOutcome));
                yield* Ref.update(captured, (messages) => [...messages, event]);
              }),
            ),
            Effect.mapError((error) =>
              error._tag === "JarvisTransportError" ? mapTransportFailure(error) : error,
            ),
          );
          const completed =
            timeoutMs === 0
              ? Option.some(yield* consume)
              : yield* consume.pipe(Effect.timeoutOption(timeoutMs));
          yield* recheck(scope, binding);
          const messages = yield* Ref.get(captured);
          if (messages.length === 0) return yield* unknownOutcome();
          return {
            engineSessionId: binding.engineSessionId,
            origin: binding.origin,
            result: {
              snapshot: messages[0]!,
              event: messages[1] ?? null,
              timedOut: Option.isNone(completed),
            },
          };
        }),
      ),
  });
});

export const layer = Layer.effect(JarvisService, make);
