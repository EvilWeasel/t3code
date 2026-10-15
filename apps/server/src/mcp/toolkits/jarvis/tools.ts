import {
  JarvisCapabilityJobRequest,
  JarvisMcpFailure,
  JarvisMcpResult,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as JarvisService from "../../../integrations/jarvis/JarvisService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  JarvisService.JarvisService,
];
const failure = Schema.Union([JarvisMcpFailure, OrchestratorMcpFailure]);
const requestKey = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const jobId = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const description =
  "Co-located Linux Jarvis only, from an actual active Morrowbyte child registered by the trusted Jarvis outbound service. Host/task/root/engine binding is derived from authenticated scope and canonical projections. No arbitrary host/path or conversation can be supplied. ";

const catalog = Tool.make("jarvis_catalog", {
  description:
    description +
    "Read the canonical capability catalog and availability. Discovery grants no execution authority.",
  success: JarvisMcpResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, true);
const observe = Tool.make("jarvis_observe", {
  description:
    description +
    "Observe the Host-configured surface, without selecting/focusing a tab or inventing a target. Reuse only retained observation references.",
  parameters: Schema.Struct({ cursor: Schema.optional(Schema.String) }),
  success: JarvisMcpResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, true);
const prepare = Tool.make("jarvis_prepare", {
  description:
    description +
    "Prepare a canonical typed invocation against the Host's current registry and retained observation. Preparation is not submission, execution or verification.",
  parameters: Schema.Struct({ invocation: JarvisCapabilityJobRequest }),
  success: JarvisMcpResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, true);
const submit = Tool.make("jarvis_submit", {
  description:
    description +
    "Submit a prepared typed capability through the existing Jarvis AppService/Decisions path. Reuse clientRequestId only for the same operation; unknown output requires reconciliation, never automatic resubmission. ACK does not mean execution or verification. Host chooses its privately bound conversation.",
  parameters: Schema.Struct({
    clientRequestId: requestKey,
    invocation: JarvisCapabilityJobRequest,
  }),
  success: JarvisMcpResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Destructive, true);
const status = Tool.make("jarvis_status", {
  description:
    description +
    "Read only an origin-owned canonical capability job. Report the actual returned state and evidence, not an assumed result from ACK.",
  parameters: Schema.Struct({ jobId }),
  success: JarvisMcpResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, true);
const cancel = Tool.make("jarvis_cancel", {
  description:
    description +
    "Request cancellation of one origin-owned capability job. This does not StopSpeech, resume/clear physical Escape, or cancel another origin. After-dispatch uncertainty remains until verification.",
  parameters: Schema.Struct({ jobId, clientRequestId: requestKey }),
  success: JarvisMcpResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Destructive, true);
const events = Tool.make("jarvis_events", {
  description:
    description +
    "Recover through an atomic origin-only App snapshot, optionally await one queued event for at most timeoutMs (max30000). Preserve App string cursors; filtered sequences need not be contiguous. No cursor replay claim or automatic reconnect/resubmit; engine changes and stream errors require explicit snapshot reconciliation.",
  parameters: Schema.Struct({
    timeoutMs: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(30_000)),
    ),
  }),
  success: JarvisMcpResult,
  failure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, true);

export const JarvisToolkit = Toolkit.make(
  catalog,
  observe,
  prepare,
  submit,
  status,
  cancel,
  events,
);
