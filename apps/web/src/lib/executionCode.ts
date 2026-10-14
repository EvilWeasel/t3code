import type { OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { commandHighlightLanguage } from "@t3tools/client-runtime/work-log/command-label";
import { isJavaScriptReplTool } from "@t3tools/shared/toolActivity";

/** References only: recorded inputs must never be copied into panel persistence. */
export interface ExecutionCodeTarget {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly runId: RunId | null;
}

export function matchesExecutionTarget(item: OrchestrationV2TurnItem, target: ExecutionCodeTarget) {
  return (
    item.threadId === target.threadId && item.id === target.itemId && item.runId === target.runId
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Present recorded input, not labels, assistant prose, or today's filesystem contents. */
export function executionCode(item: OrchestrationV2TurnItem) {
  if (item.type !== "command_execution" && item.type !== "dynamic_tool") return null;
  const input = item.input;
  const transportTruncated =
    typeof input === "string" && input.endsWith("\n… output truncated for transport");
  const unavailable =
    input === undefined ||
    input === null ||
    input === "" ||
    transportTruncated ||
    (record(input) && (input.truncated === true || input.redacted === true));
  const text = unavailable
    ? null
    : typeof input === "string"
      ? input
      : JSON.stringify(input, null, 2);
  const language =
    item.type === "command_execution"
      ? commandHighlightLanguage(item.input)
      : typeof input !== "string"
        ? "json"
        : isJavaScriptReplTool(item.toolName)
          ? "typescript"
          : "text";
  return {
    text: text ?? null,
    language,
    shell: item.type === "command_execution",
    title:
      item.type === "command_execution"
        ? "Recorded command"
        : (item.toolName ?? "Recorded tool input"),
    cwd: record(input) && typeof input.cwd === "string" ? input.cwd : null,
    unavailable: transportTruncated
      ? "Complete recorded input is unavailable: the existing item read reached its transport limit."
      : unavailable
        ? "Complete recorded input is unavailable or withheld by the provider."
        : null,
    output:
      item.outputOmitted === true
        ? null
        : typeof item.output === "string"
          ? item.output
          : item.output === undefined
            ? null
            : JSON.stringify(item.output, null, 2),
    outputOmitted: item.outputOmitted === true,
    exitCode: item.type === "command_execution" ? item.exitCode : undefined,
  };
}
