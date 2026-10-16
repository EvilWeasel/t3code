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
    const threads =
      snapshot === null
        ? []
        : [
            ...new Map(
              [...snapshot.archivedThreads, ...snapshot.threads].map(
                (thread) => [thread.id, thread] as const,
              ),
            ).values(),
          ].filter((thread) => thread.deletedAt === null);
    for (const shell of threads) {
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
      totalThreads: snapshot === null ? null : threads.length,
    };
  });
  return {
    nodes,
    sources,
    nativeAgentCoverage:
      "Selected-thread details only; other provider-native agents are not enumerated." as const,
  };
}

export interface ObservatoryQuery {
  readonly environmentId: EnvironmentId | null;
  readonly search: string;
  /** First visible identity, not an array offset: source reordering cannot retarget a page. */
  readonly anchorKey: string | null;
}
export const OBSERVATORY_PAGE_SIZE = 50;
export const EMPTY_OBSERVATORY_QUERY: ObservatoryQuery = {
  environmentId: null,
  search: "",
  anchorKey: null,
};

/** Local shell-only pagination. Every authorized known shell remains reachable without detail reads. */
export function projectObservatoryPage<Node extends ObservatoryNode>(
  graph: Omit<ObservatoryNativeGraph, "nodes"> & { readonly nodes: readonly Node[] },
  query: ObservatoryQuery,
) {
  const search = query.search.slice(0, 200).trim().toLowerCase();
  const labels = new Map(graph.sources.map((source) => [source.environmentId, source.label]));
  const matching = graph.nodes
    .filter(
      (node) =>
        (query.environmentId === null || query.environmentId === node.ref.environmentId) &&
        (search === "" ||
          `${node.title} ${node.ref.threadId} ${node.ref.environmentId} ${labels.get(node.ref.environmentId) ?? ""} ${node.shell.archivedAt === null ? "" : "archived"}`
            .toLowerCase()
            .includes(search)),
    )
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const anchorIndex =
    query.anchorKey === null
      ? 0
      : matching.findIndex((node) => node.key >= (query.anchorKey ?? ""));
  const lastStart = Math.max(
    0,
    Math.floor((matching.length - 1) / OBSERVATORY_PAGE_SIZE) * OBSERVATORY_PAGE_SIZE,
  );
  const start = matching.length === 0 ? 0 : anchorIndex < 0 ? lastStart : anchorIndex;
  const pageNodes = matching.slice(start, start + OBSERVATORY_PAGE_SIZE);
  const allKeys = new Set(graph.nodes.map((node) => node.key));
  const pageKeys = new Set(pageNodes.map((node) => node.key));
  const counts = new Map<EnvironmentId, { matching: number; visible: number }>();
  for (const node of matching) {
    const count = counts.get(node.ref.environmentId) ?? { matching: 0, visible: 0 };
    count.matching++;
    if (pageKeys.has(node.key)) count.visible++;
    counts.set(node.ref.environmentId, count);
  }
  return {
    ...graph,
    nodes: pageNodes.map((node) => ({
      ...node,
      parentLocation:
        node.parentKey === null
          ? ("root" as const)
          : pageKeys.has(node.parentKey)
            ? ("page" as const)
            : allKeys.has(node.parentKey)
              ? ("outside-page" as const)
              : ("unknown" as const),
    })),
    sources: graph.sources.map((source) => {
      const count = counts.get(source.environmentId) ?? { matching: 0, visible: 0 };
      return {
        ...source,
        matchingThreads: count.matching,
        visibleThreads: count.visible,
        omittedThreads: source.totalThreads === null ? null : source.totalThreads - count.visible,
        filteredThreads: source.totalThreads === null ? null : source.totalThreads - count.matching,
        offPageThreads: count.matching - count.visible,
      };
    }),
    page: {
      query: { ...query, search: query.search.slice(0, 200) },
      size: OBSERVATORY_PAGE_SIZE,
      totalKnownThreads: graph.nodes.length,
      matchingThreads: matching.length,
      from: matching.length === 0 ? 0 : start + 1,
      to: start + pageNodes.length,
      previousKey:
        start > 0 ? (matching[Math.max(0, start - OBSERVATORY_PAGE_SIZE)]?.key ?? null) : null,
      nextKey: matching[start + OBSERVATORY_PAGE_SIZE]?.key ?? null,
      lastKey: matching[lastStart]?.key ?? null,
      hasPrevious: start > 0,
      hasNext: start + pageNodes.length < matching.length,
    },
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
