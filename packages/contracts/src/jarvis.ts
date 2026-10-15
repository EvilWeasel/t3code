import * as Schema from "effect/Schema";

// Preserve extra keys until validation: ordinary Struct decoding strips them.
// The Host's deny_unknown_fields boundary must also hold for our callers.
const strictStruct = <const Fields extends Schema.Struct.Fields>(fields: Fields) => {
  const keys = new Set(Object.keys(fields));
  return Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]).check(
    Schema.makeFilter((value) => Object.keys(value).every((key) => keys.has(key)), {
      expected: "only canonical Jarvis request fields",
      toJsonSchema: () => [{ additionalProperties: false }, true],
    }),
  );
};

// Canonical Jarvis engine/api/mod.rs at 18bb46c81323d4ac3a1f40e0065a63a0a65e9637.
// These are data codecs, not a second operation registry or authorization policy.
export const JarvisObservedTargetRef = strictStruct({
  targetId: Schema.String,
  targetKind: Schema.String,
  surfaceId: Schema.String,
  generation: Schema.String,
  observedContextId: Schema.String,
  observedObservationId: Schema.String,
});
export type JarvisObservedTargetRef = typeof JarvisObservedTargetRef.Type;

export const JarvisCapabilityJobRequest = strictStruct({
  engineSessionId: Schema.String,
  capabilityId: Schema.String,
  operationId: Schema.String,
  registrationRevision: Schema.String,
  arguments: Schema.Json,
  target: JarvisObservedTargetRef,
});
export type JarvisCapabilityJobRequest = typeof JarvisCapabilityJobRequest.Type;

export const JarvisCapabilityObserveRequest = strictStruct({
  engineSessionId: Schema.String,
  cursor: Schema.optional(Schema.String),
});
export type JarvisCapabilityObserveRequest = typeof JarvisCapabilityObserveRequest.Type;

export const JarvisSubmitCapability = strictStruct({
  schema: Schema.Literal("jarvis.v1"),
  kind: Schema.Literal("submit_capability"),
  requestId: Schema.String,
  conversationId: Schema.String,
  clientMessageId: Schema.String,
  invocation: JarvisCapabilityJobRequest,
});
export type JarvisSubmitCapability = typeof JarvisSubmitCapability.Type;

// Native transport candidate 72e964b9ccce939ecda4ecd99629199e3f50b8b3.
// Qualification of this later transport is separate from the data golden above.
export const JarvisNativeTaskOrigin = strictStruct({
  environmentId: Schema.String,
  projectId: Schema.String,
  parentThreadId: Schema.String,
  parentRunId: Schema.String,
  parentRootNodeId: Schema.String,
  taskId: Schema.String,
  childThreadId: Schema.String,
  childRunId: Schema.String,
  childRootNodeId: Schema.String,
});
export type JarvisNativeTaskOrigin = typeof JarvisNativeTaskOrigin.Type;

export const JarvisNativeBinding = strictStruct({
  engineSessionId: Schema.String,
  origin: JarvisNativeTaskOrigin,
});
export type JarvisNativeBinding = typeof JarvisNativeBinding.Type;

const nativeRequest = <const Method extends string, const Fields extends Schema.Struct.Fields>(
  method: Method,
  fields: Fields,
) =>
  strictStruct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.String,
    method: Schema.Literal(method),
    params: strictStruct({ binding: JarvisNativeBinding, ...fields }),
  });

export const JarvisNativeRequest = Schema.Union([
  nativeRequest("jarvis.catalog", {}),
  nativeRequest("jarvis.observe", { query: JarvisCapabilityObserveRequest }),
  nativeRequest("jarvis.prepare", { invocation: JarvisCapabilityJobRequest }),
  nativeRequest("jarvis.submit", { envelope: JarvisSubmitCapability }),
  nativeRequest("jarvis.status", { jobId: Schema.String }),
  nativeRequest("jarvis.cancel", { requestId: Schema.String, jobId: Schema.String }),
  nativeRequest("jarvis.subscribe", {}),
]);
export type JarvisNativeRequest = typeof JarvisNativeRequest.Type;

export const JarvisNativeResponse = Schema.Union([
  strictStruct({ jsonrpc: Schema.Literal("2.0"), id: Schema.String, result: Schema.Json }),
  strictStruct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.String,
    error: Schema.Struct({
      code: Schema.Int,
      message: Schema.String,
      data: Schema.optional(Schema.Json),
    }),
  }),
]);
export type JarvisNativeResponse = typeof JarvisNativeResponse.Type;

export const JarvisNativeNotification = Schema.Union([
  strictStruct({
    jsonrpc: Schema.Literal("2.0"),
    method: Schema.Literal("jarvis.event"),
    params: strictStruct({
      engineSessionId: Schema.String,
      event: Schema.Struct({
        schema: Schema.String,
        sequence: Schema.String,
        emittedAt: Schema.String,
        conversationId: Schema.optional(Schema.String),
        jobId: Schema.optional(Schema.String),
        actionId: Schema.optional(Schema.String),
        payload: Schema.Json,
      }),
    }),
  }),
  strictStruct({
    jsonrpc: Schema.Literal("2.0"),
    method: Schema.Literal("jarvis.stream_error"),
    params: Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      retryable: Schema.Boolean,
    }),
  }),
]);
export type JarvisNativeNotification = typeof JarvisNativeNotification.Type;
