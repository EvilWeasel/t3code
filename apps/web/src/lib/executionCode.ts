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
  // Show an explicitly recorded script field as code, retaining all original
  // structured arguments separately. Never read a filename to fill this in.
  const inputField =
    !unavailable && record(input)
      ? ["code", "script", "command", "cmd"].find((key) => typeof input[key] === "string")
      : undefined;
  const fieldText = inputField && record(input) ? input[inputField] : undefined;
  const text = unavailable
    ? null
    : typeof fieldText === "string"
      ? fieldText
      : typeof input === "string"
        ? input
        : JSON.stringify(input, null, 2);
  const language =
    item.type === "command_execution" || inputField === "command" || inputField === "cmd"
      ? commandHighlightLanguage(typeof text === "string" ? text : "")
      : record(input) && typeof input.language === "string"
        ? input.language
        : item.type === "dynamic_tool" && isJavaScriptReplTool(item.toolName)
          ? "typescript"
          : typeof input !== "string"
            ? "json"
            : isJavaScriptReplTool(item.toolName)
              ? "typescript"
              : "text";
  return {
    text: text ?? null,
    inputField: inputField ?? null,
    argumentsText: inputField ? JSON.stringify(input, null, 2) : null,
    language,
    shell: language === "shellscript",
    title:
      item.type === "command_execution"
        ? "Recorded command"
        : (item.toolName ?? "Recorded tool input"),
    cwd:
      record(input) && typeof input.cwd === "string"
        ? input.cwd
        : record(input) && typeof input.workdir === "string"
          ? input.workdir
          : null,
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
