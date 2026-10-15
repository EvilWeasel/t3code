import * as Schema from "effect/Schema";

// Canonical Jarvis engine/api/mod.rs at 18bb46c81323d4ac3a1f40e0065a63a0a65e9637.
// These are data codecs, not a second operation registry or authorization policy.
export const JarvisObservedTargetRef = Schema.Struct({
  targetId: Schema.String,
  targetKind: Schema.String,
  surfaceId: Schema.String,
  generation: Schema.String,
  observedContextId: Schema.String,
  observedObservationId: Schema.String,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type JarvisObservedTargetRef = typeof JarvisObservedTargetRef.Type;

export const JarvisCapabilityJobRequest = Schema.Struct({
  engineSessionId: Schema.String,
  capabilityId: Schema.String,
  operationId: Schema.String,
  registrationRevision: Schema.String,
  arguments: Schema.Json,
  target: JarvisObservedTargetRef,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type JarvisCapabilityJobRequest = typeof JarvisCapabilityJobRequest.Type;

export const JarvisCapabilityObserveRequest = Schema.Struct({
  engineSessionId: Schema.String,
  cursor: Schema.optional(Schema.String),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type JarvisCapabilityObserveRequest = typeof JarvisCapabilityObserveRequest.Type;

export const JarvisSubmitCapability = Schema.Struct({
  schema: Schema.Literal("jarvis.v1"),
  kind: Schema.Literal("submit_capability"),
  requestId: Schema.String,
  conversationId: Schema.String,
  clientMessageId: Schema.String,
  invocation: JarvisCapabilityJobRequest,
});
export type JarvisSubmitCapability = typeof JarvisSubmitCapability.Type;
