import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestrationV2Command,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpExternalDelegateTaskInput,
  OrchestratorMcpExternalTaskEventsInput,
} from "./orchestratorMcp.ts";

const decodeCreateThreadsInput = Schema.decodeUnknownSync(OrchestratorMcpCreateThreadsInput);
const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeThreadInterruptInput = Schema.decodeUnknownSync(OrchestratorMcpThreadInterruptInput);
const decodeThreadListInput = Schema.decodeUnknownSync(OrchestratorMcpThreadListInput);
const decodeThreadReadInput = Schema.decodeUnknownSync(OrchestratorMcpThreadReadInput);
const decodeThreadSendInput = Schema.decodeUnknownSync(OrchestratorMcpThreadSendInput);
const decodeThreadWaitInput = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitInput);

describe("orchestrator MCP contracts", () => {
  const externalParent = {
    environmentId: "environment-one",
    projectId: "project-one",
    parentThreadId: "parent-one",
    parentRunId: "run-one",
    parentRootNodeId: "root-one",
  };
  it("requires explicit real parent identities and a retry key for external delegation", () => {
    const decode = Schema.decodeUnknownSync(OrchestratorMcpExternalDelegateTaskInput);
    expect(
      decode({
        ...externalParent,
        task: "Inspect the controlled fixture",
        clientRequestId: "request-one",
      }).parentRootNodeId,
    ).toBe("root-one");
    expect(() => decode({ task: "Inspect", clientRequestId: "request-one" })).toThrow();
    expect(() => decode({ ...externalParent, task: "Inspect" })).toThrow();
    expect(() =>
      decode({
        ...externalParent,
        parentRootNodeId: "",
        task: "Inspect",
        clientRequestId: "request-one",
      }),
    ).toThrow();
    expect(() =>
      decode({ ...externalParent, task: "Inspect", clientRequestId: "request-one", mode: "wait" }),
    ).toThrow();
  });
  it("bounds external event waits while preserving the canonical nonnegative cursor", () => {
    const decode = Schema.decodeUnknownSync(OrchestratorMcpExternalTaskEventsInput);
    const input = { ...externalParent, taskId: "task-one", afterSequence: 0, timeoutMs: 30_000 };
    expect(decode(input).afterSequence).toBe(0);
    expect(() => decode({ ...input, timeoutMs: 30_001 })).toThrow();
    expect(() => decode({ ...input, afterSequence: -1 })).toThrow();
  });
  it("accepts explicit worktree isolation and keeps shared delegation as the default", () => {
    expect(decodeDelegateTaskInput({ task: "Review changes" }).isolation).toBeUndefined();
    expect(
      decodeDelegateTaskInput({ task: "Review changes", isolation: "worktree" }).isolation,
    ).toBe("worktree");
    expect(() => decodeDelegateTaskInput({ task: "Review changes", isolation: "copy" })).toThrow();
  });
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
  });

  it("decodes target model options in canonical and shorthand shapes", () => {
    const canonical = decodeDelegateTaskInput({
      task: "Say hello.",
      target: {
        providerInstanceId: "codex",
        model: "gpt-5.6-luna",
        options: [{ id: "reasoning", value: "low" }],
      },
    });
    const shorthand = decodeDelegateTaskInput({
      task: "Say hello.",
      target: {
        providerInstanceId: "codex",
        model: "gpt-5.6-luna",
        options: { reasoning: "low", fastMode: true },
      },
    });

    expect(canonical.target?.options).toEqual([{ id: "reasoning", value: "low" }]);
    expect(shorthand.target?.options).toEqual([
      { id: "reasoning", value: "low" },
      { id: "fastMode", value: true },
    ]);
  });

  it("rejects target model options that are not strings or booleans", () => {
    expect(() =>
      decodeDelegateTaskInput({
        task: "Say hello.",
        target: {
          providerInstanceId: "codex",
          model: "gpt-5.6-luna",
          // Must fail loudly instead of being dropped like legacy persistence.
          options: { reasoning: 3 },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeDelegateTaskInput({
        task: "Say hello.",
        target: {
          providerInstanceId: "codex",
          model: "gpt-5.6-luna",
          options: [{ id: "reasoning", value: null }],
        },
      }),
    ).toThrow();
  });

  it("decodes mixed prompted and empty thread batches", () => {
    const request = decodeCreateThreadsInput({
      clientRequestId: "threads-1",
      threads: [
        { title: "Inherited empty thread" },
        {
          prompt: "Review the API.",
          target: { driverKind: "claudeAgent" },
          runtimeMode: "approval-required",
        },
      ],
    });

    expect(request.threads).toHaveLength(2);
    expect(request.threads[0]?.prompt).toBeUndefined();
    expect(request.threads[1]?.target?.driverKind).toBe("claudeAgent");
  });

  it("decodes project-scoped thread orchestration requests", () => {
    expect(
      decodeThreadListInput({
        statuses: ["running", "completed"],
        includeSubagents: false,
        limit: 25,
      }).statuses,
    ).toEqual(["running", "completed"]);
    expect(
      decodeThreadReadInput({
        threadId: "thread-loop-1",
        view: "activity",
        afterPosition: 10,
      }).afterPosition,
    ).toBe(10);
    expect(
      decodeThreadSendInput({
        threadId: "thread-loop-1",
        message: "Continue with the next iteration.",
        mode: "steer",
        clientRequestId: "send-loop-2",
      }).mode,
    ).toBe("steer");
    expect(
      decodeThreadWaitInput({
        threadId: "thread-loop-1",
        runId: "run-loop-2",
        timeoutMs: 5_000,
      }).runId,
    ).toBe("run-loop-2");
    expect(
      decodeThreadInterruptInput({
        threadId: "thread-loop-1",
        reason: "Loop converged.",
      }).reason,
    ).toBe("Loop converged.");
  });
});

it("preserves explicit atomic late-steer rejection while leaving ordinary delivery unchanged", () => {
  const decode = Schema.decodeUnknownSync(OrchestrationV2Command);
  const command = {
    type: "message.dispatch",
    commandId: "strict-steer",
    threadId: "child",
    messageId: "message",
    text: "Keep the exact run",
    attachments: [],
    createdBy: "agent",
    creationSource: "mcp",
    dispatchMode: { type: "steer_active", targetRunId: "child-run", onInactive: "reject" },
  };
  expect(decode(command)).toMatchObject({
    dispatchMode: { type: "steer_active", targetRunId: "child-run", onInactive: "reject" },
  });
  const ordinary = decode({
    ...command,
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: "steer_active", targetRunId: "child-run" },
  });
  expect(ordinary).not.toHaveProperty("dispatchMode.onInactive");
  expect(() =>
    decode({ ...command, dispatchMode: { ...command.dispatchMode, onInactive: "retarget" } }),
  ).toThrow();
});
