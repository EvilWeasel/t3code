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
    (value) =>
      (Number.isSafeInteger(value) && value >= 1) || "Expected a positive integer generation.",
  ),
);
export const LiveVoiceClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const LiveVoicePrepareInput = Schema.Struct({
  threadId: ThreadId,
  clientRequestId: LiveVoiceClientRequestId,
  nativePreparation: Schema.optionalKey(
    Schema.Struct({
      providerInstanceId: ProviderInstanceId,
      configurationId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    }),
  ),
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

export const LiveVoiceErrorCode = Schema.Literals([
  "unsupported_provider",
  "managed_account_required",
  "session_not_found",
  "stale_lease",
  "planner_restriction_failed",
  "invalid_state",
  "dispatch_conflict",
  "runtime_unavailable",
]);
export type LiveVoiceErrorCode = typeof LiveVoiceErrorCode.Type;

export const liveVoicePublicErrorMessage = (code: LiveVoiceErrorCode): string => {
  switch (code) {
    case "unsupported_provider":
      return "Live voice is available only for a managed Codex thread.";
    case "managed_account_required":
      return "Sign in to a supported ChatGPT account to use Live voice.";
    case "session_not_found":
      return "This Live voice session is no longer available.";
    case "stale_lease":
      return "This Live voice session has changed. Reconnect to continue.";
    case "planner_restriction_failed":
      return "Live voice could not establish its restricted planning session.";
    case "invalid_state":
      return "This action is not available in the current Live voice state.";
    case "dispatch_conflict":
      return "This voice request conflicts with a request already submitted.";
    case "runtime_unavailable":
      return "The Codex runtime is currently unavailable.";
  }
};

export const LiveVoiceSession = Schema.Struct({
  leaseId: LiveVoiceLeaseId,
  generation: LiveVoiceGeneration,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: Schema.NullOr(ProviderSessionId),
  plannerNativeThreadId: Schema.NullOr(TrimmedNonEmptyString),
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
    code: LiveVoiceErrorCode,
  }),
]);
export type LiveVoiceEvent = typeof LiveVoiceEvent.Type;

export class LiveVoiceError extends Schema.TaggedError<LiveVoiceError>()("LiveVoiceError", {
  code: LiveVoiceErrorCode,
}) {
  override get message(): string {
    return liveVoicePublicErrorMessage(this.code);
  }
}
