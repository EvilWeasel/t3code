import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

import { MainRendererDiagnosticsReadInput, MainRendererDiagnosticsReadResult } from "./ipc.ts";

export const DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION = 1 as const;

export const DesktopAppActivationPlatform = Schema.Literals(["darwin", "linux", "win32"]);
export type DesktopAppActivationPlatform = typeof DesktopAppActivationPlatform.Type;

export const DesktopAppActivationRequest = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("open-workspace"),
  workspaceRoot: TrimmedNonEmptyString,
  platform: DesktopAppActivationPlatform,
});
export type DesktopAppActivationRequest = typeof DesktopAppActivationRequest.Type;

export const DesktopAppActivationErrorCode = Schema.Literals([
  "invalid-request",
  "renderer-unavailable",
  "environment-unavailable",
  "platform-mismatch",
  "project-create-failed",
  "thread-open-failed",
  "request-timeout",
  "internal-error",
]);
export type DesktopAppActivationErrorCode = typeof DesktopAppActivationErrorCode.Type;

export const DesktopAppActivationSuccess = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(true),
  projectId: ProjectId,
  threadId: ThreadId,
});
export type DesktopAppActivationSuccess = typeof DesktopAppActivationSuccess.Type;

export const DesktopAppActivationFailure = Schema.Struct({
  version: Schema.Literal(DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION),
  requestId: TrimmedNonEmptyString,
  ok: Schema.Literal(false),
  code: DesktopAppActivationErrorCode,
  message: TrimmedNonEmptyString,
});
export type DesktopAppActivationFailure = typeof DesktopAppActivationFailure.Type;

export const DesktopAppActivationResponse = Schema.Union([
  DesktopAppActivationSuccess,
  DesktopAppActivationFailure,
]);
export type DesktopAppActivationResponse = typeof DesktopAppActivationResponse.Type;


// Separate from activation: these messages never enter the workspace/focus broker.
const LocalDiagnosticNonce = Schema.String.check(
  Schema.makeFilter((value: string) => /^[a-zA-Z0-9:_-]{1,128}$/.test(value)),
);
export const MainRendererLocalDiagnosticsHello = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("main-renderer-diagnostics-hello"),
  requestId: LocalDiagnosticNonce,
  requestNonce: LocalDiagnosticNonce,
  expectedMainPid: PositiveInt,
  stateDir: TrimmedNonEmptyString,
  expiresAtMs: NonNegativeInt,
});
export type MainRendererLocalDiagnosticsHello = typeof MainRendererLocalDiagnosticsHello.Type;
export const MainRendererLocalDiagnosticsCapability = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("main-renderer-diagnostics-capability"),
  requestId: LocalDiagnosticNonce,
  requestNonce: LocalDiagnosticNonce,
  capabilityNonce: LocalDiagnosticNonce,
  mainPid: PositiveInt,
  stateDir: TrimmedNonEmptyString,
  appVersion: TrimmedNonEmptyString,
});
export type MainRendererLocalDiagnosticsCapability = typeof MainRendererLocalDiagnosticsCapability.Type;
export const MainRendererLocalDiagnosticsRead = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("main-renderer-diagnostics-read"),
  capabilityNonce: LocalDiagnosticNonce,
  input: MainRendererDiagnosticsReadInput,
});
export type MainRendererLocalDiagnosticsRead = typeof MainRendererLocalDiagnosticsRead.Type;
export const MainRendererLocalDiagnosticsResult = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("main-renderer-diagnostics-result"),
  requestId: LocalDiagnosticNonce,
  requestNonce: LocalDiagnosticNonce,
  capabilityNonce: LocalDiagnosticNonce,
  result: MainRendererDiagnosticsReadResult,
});
export type MainRendererLocalDiagnosticsResult = typeof MainRendererLocalDiagnosticsResult.Type;
