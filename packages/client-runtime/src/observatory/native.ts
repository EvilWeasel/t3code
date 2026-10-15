import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadShell,
  RunId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { EnvironmentShellState } from "../state/shell.ts";
import type { EnvironmentThreadState } from "../state/threads.ts";

export type ObservatorySourceStatus = "live" | "synchronizing" | "offline" | "denied" | "unknown";
export interface ObservatoryEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly generation: number;
  readonly status: ObservatorySourceStatus;
  readonly shell: EnvironmentShellState | null;
}
export interface ObservatoryNode {
  readonly key: string;
  readonly ref: ScopedThreadRef;
  readonly title: string;
  readonly nativeStatus: OrchestrationV2ThreadShell["status"];
  readonly runId: RunId | null;
  readonly parentKey: string | null;
  readonly shell: OrchestrationV2ThreadShell;
}
export const observatoryKey = (ref: ScopedThreadRef) =>
  `${ref.environmentId.length}:${ref.environmentId}${ref.threadId}`;

/** One derived node array feeds graph/list/dashboard; it is never a second native store. */
export function projectObservatoryNative(environments: readonly ObservatoryEnvironment[]) {
  const nodes: ObservatoryNode[] = [];
  const sources = environments.map((source) => {
    const snapshot =
      source.status === "live" &&
      source.shell?.status === "live" &&
      Option.isNone(source.shell.error)
        ? Option.getOrNull(source.shell.snapshot)
        : null;
    const threads = snapshot?.threads ?? [];
    const remaining = Math.max(0, 500 - nodes.length);
    for (const shell of threads.slice(0, remaining)) {
      const ref = { environmentId: source.environmentId, threadId: shell.id };
      nodes.push({
        key: observatoryKey(ref),
        ref,
        title: shell.title,
        nativeStatus: shell.status,
        runId: shell.activeRunId ?? shell.latestRunId,
        parentKey:
          shell.lineage.parentThreadId === null
            ? null
            : observatoryKey({
                environmentId: source.environmentId,
                threadId: shell.lineage.parentThreadId,
              }),
        shell,
      });
    }
    return {
      environmentId: source.environmentId,
      label: source.label,
      status:
        source.status === "live" && snapshot === null ? ("synchronizing" as const) : source.status,
      visibleThreads: Math.min(remaining, threads.length),
      omittedThreads: Math.max(0, threads.length - remaining),
    };
  });
  return {
    nodes,
    sources,
    nativeAgentCoverage:
      "Selected-thread details only; other provider-native agents are not enumerated." as const,
  };
}

export function projectObservatoryDetails(
  node: ObservatoryNode,
  source: ObservatoryEnvironment,
  detail: EnvironmentThreadState | null,
) {
  const projection =
    detail === null || detail.status !== "live" || Option.isSome(detail.error)
      ? null
      : Option.getOrNull(detail.data);
  if (
    source.status !== "live" ||
    source.shell?.status !== "live" ||
    projection === null ||
    projection.thread.id !== node.ref.threadId ||
    source.environmentId !== node.ref.environmentId ||
    (node.runId !== null && !projection.runs.some((run) => run.id === node.runId))
  )
    return null;
  const currentItems = projection.visibleTurnItems.filter(
    (row) => row.sourceThreadId === node.ref.threadId && row.item.runId === node.runId,
  );
  const plans = projection.plans.filter(
    (plan) => plan.runId === node.runId && plan.status !== "superseded",
  );
  const todo = [...plans].reverse().find((plan) => plan.kind === "todo_list");
  const steps = todo?.kind === "todo_list" ? todo.steps : [];
  const tools = currentItems.filter(
    (row) => row.item.type === "dynamic_tool" || row.item.type === "command_execution",
  );
  const chat = currentItems.filter(
    (row) => row.item.type === "user_message" || row.item.type === "assistant_message",
  );
  const compactions = projection.visibleTurnItems.filter((row) => row.item.type === "compaction");
  return {
    projection,
    plans: plans.slice(-8),
    steps,
    currentStep: steps.find((step) => step.status === "running") ?? null,
    completedSteps: steps.filter((step) => step.status === "completed"),
    nextSteps: steps.filter((step) => step.status === "pending"),
    tools: tools.slice(-24),
    omittedTools: Math.max(0, tools.length - 24),
    chat: chat.slice(-20),
    omittedChat: Math.max(0, chat.length - 20),
    compactions: compactions.slice(-8),
    omittedCompactions: Math.max(0, compactions.length - 8),
    pendingRequests: projection.runtimeRequests.filter((request) => request.status === "pending"),
    subagents: projection.subagents.filter((agent) => agent.runId === node.runId),
    history: detail!.history,
  };
}
export type ObservatoryNativeGraph = ReturnType<typeof projectObservatoryNative>;
export type ObservatoryNativeDetails = NonNullable<ReturnType<typeof projectObservatoryDetails>>;
export function nativeItemText(row: OrchestrationV2ProjectedTurnItem): string | null {
  const item = row.item;
  if (item.type === "assistant_message" || item.type === "user_message")
    return item.text.slice(0, 8000);
  if (item.type === "compaction") return item.summary?.slice(0, 8000) ?? null;
  return null;
}
