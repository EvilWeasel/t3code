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
