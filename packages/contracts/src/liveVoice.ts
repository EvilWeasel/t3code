import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  ProviderSessionId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const LiveVoiceLeaseId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export const LiveVoiceGeneration = Schema.Number.check(
  Schema.makeFilter(
    (value) => (Number.isInteger(value) && value >= 1) || "Expected a positive integer generation.",
  ),
);
export const LiveVoiceClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const LiveVoicePrepareInput = Schema.Struct({
  threadId: ThreadId,
  clientRequestId: LiveVoiceClientRequestId,
});
export type LiveVoicePrepareInput = typeof LiveVoicePrepareInput.Type;

export const LiveVoiceStartInput = Schema.Struct({
  leaseId: LiveVoiceLeaseId,
  generation: LiveVoiceGeneration,
  offerSdp: Schema.String.check(
    Schema.makeFilter(
      (value) =>
        (value.length > 0 && value.length <= 256_000) ||
        "SDP must be between 1 and 256000 characters.",
    ),
  ),
  clientRequestId: LiveVoiceClientRequestId,
});
export type LiveVoiceStartInput = typeof LiveVoiceStartInput.Type;

export const LiveVoiceStopInput = Schema.Struct({
  leaseId: LiveVoiceLeaseId,
  generation: LiveVoiceGeneration,
  clientRequestId: LiveVoiceClientRequestId,
});
export type LiveVoiceStopInput = typeof LiveVoiceStopInput.Type;

export const LiveVoiceSubscribeInput = Schema.Struct({
  leaseId: LiveVoiceLeaseId,
  generation: LiveVoiceGeneration,
});
export type LiveVoiceSubscribeInput = typeof LiveVoiceSubscribeInput.Type;

export const LiveVoiceStatus = Schema.Literals([
  "preparing",
  "prepared",
  "starting",
  "active",
  "stopping",
  "closed",
  "failed",
  "unknown",
]);
export type LiveVoiceStatus = typeof LiveVoiceStatus.Type;

export const LiveVoiceSession = Schema.Struct({
  leaseId: LiveVoiceLeaseId,
  generation: LiveVoiceGeneration,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: ProviderSessionId,
  plannerNativeThreadId: TrimmedNonEmptyString,
  status: LiveVoiceStatus,
});
export type LiveVoiceSession = typeof LiveVoiceSession.Type;

export const LiveVoiceEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("status"), session: LiveVoiceSession }),
  Schema.Struct({
    type: Schema.Literal("answer"),
    leaseId: LiveVoiceLeaseId,
    generation: LiveVoiceGeneration,
    sdp: Schema.String.check(Schema.isMaxLength(256_000)),
  }),
  Schema.Struct({
    type: Schema.Literal("transcript"),
    leaseId: LiveVoiceLeaseId,
    generation: LiveVoiceGeneration,
    role: Schema.Literals(["user", "assistant"]),
    text: Schema.String.check(Schema.isMaxLength(16_384)),
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    leaseId: LiveVoiceLeaseId,
    generation: LiveVoiceGeneration,
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  }),
]);
export type LiveVoiceEvent = typeof LiveVoiceEvent.Type;

export class LiveVoiceError extends Schema.TaggedError<LiveVoiceError>()("LiveVoiceError", {
  code: Schema.Literals([
    "unsupported_provider",
    "managed_account_required",
    "session_not_found",
    "stale_lease",
    "planner_restriction_failed",
    "invalid_state",
    "dispatch_conflict",
    "runtime_unavailable",
  ]),
  detail: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
}) {
  override get message(): string {
    return this.detail;
  }
}
