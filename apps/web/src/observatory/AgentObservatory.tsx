import { useState, type ReactNode } from "react";
import { nativeItemText, type ObservatoryView } from "@t3tools/client-runtime/observatory";
import type { OrchestrationV2ProjectedTurnItem, ScopedThreadRef } from "@t3tools/contracts";
import { Button } from "../components/ui/button";
import { ObservatoryGraph } from "./ObservatoryGraph";

export function AgentObservatory({
  view,
  onSelect,
  onOpenThread,
  renderTool,
}: {
  readonly view: ObservatoryView;
  readonly onSelect: (ref: ScopedThreadRef | null) => void;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
  readonly renderTool: (row: OrchestrationV2ProjectedTurnItem, ref: ScopedThreadRef) => ReactNode;
}) {
  const [mode, setMode] = useState<"graph" | "list">("graph");
  const selection = view.selection;
  return (
    <main className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h1 className="text-lg font-semibold">Agent observatory</h1>
          <p className="text-sm text-muted-foreground">
            Live observed activity · Read-only dashboard
          </p>
        </div>
        <div className="flex gap-2">
          {selection && (
            <Button variant="outline" onClick={() => onSelect(null)}>
              All threads
            </Button>
          )}
          <Button variant="outline" onClick={() => setMode(mode === "graph" ? "list" : "graph")}>
            {mode === "graph" ? "Show list" : "Show graph"}
          </Button>
        </div>
      </header>
      <section aria-label="Environment coverage" className="border-b px-5 py-3 text-sm">
        {!view.catalogReady && <p>Environment coverage unknown: catalog not ready.</p>}
        {view.sources.map((source) => (
          <p key={source.environmentId}>
            {source.label}: {source.status} · {source.visibleThreads} visible threads
            {source.omittedThreads > 0 && ` · ${source.omittedThreads} omitted (view limit)`}
          </p>
        ))}
        <p className="text-muted-foreground">
          {view.nativeAgentCoverage} Agent-authored updates are unavailable until the canonical
          service is connected.
        </p>
      </section>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {selection ? (
          <Dashboard
            key={`${selection.node.key}:${selection.node.runId}:${selection.source.generation}`}
            selection={selection}
            onOpenThread={onOpenThread}
            renderTool={renderTool}
          />
        ) : (
          <>
            <h2 className="mb-3 font-medium">
              {mode === "graph" ? "Thread relationships" : "Threads"}
            </h2>
            {view.nodes.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No currently authorized live threads available. Offline and unknown coverage is
                shown above.
              </p>
            )}
            {mode === "graph" ? (
              <ObservatoryGraph nodes={view.nodes} onSelect={onSelect} />
            ) : (
              <>
                <div
                  role="list"
                  aria-label="Agent list"
                  className={
                    mode === "graph"
                      ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
                      : "flex flex-col gap-2"
                  }
                >
                  {view.nodes.map((node) => (
                    <div
                      role="listitem"
                      key={node.key}
                      className="min-w-0 break-words rounded-lg border bg-card p-4"
                    >
                      <Button
                        variant="ghost"
                        size="sm-multiline"
                        onClick={() => onSelect(node.ref)}
                      >
                        {node.title}
                      </Button>
                      <p className="text-sm">
                        Observed: {node.nativeStatus} · {node.ref.environmentId}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {node.parentKey === null
                          ? "Root thread"
                          : `Parent: ${view.nodes.find((parent) => parent.key === node.parentKey)?.title ?? "outside loaded coverage"}`}
                      </p>
                      {node.authoredRevision !== null && (
                        <p className="text-xs">Agent-authored revision {node.authoredRevision}</p>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function Dashboard({
  selection,
  onOpenThread,
  renderTool,
}: {
  readonly selection: NonNullable<ObservatoryView["selection"]>;
  readonly onOpenThread: (ref: ScopedThreadRef) => void;
  readonly renderTool: (row: OrchestrationV2ProjectedTurnItem, ref: ScopedThreadRef) => ReactNode;
}) {
  const [showText, setShowText] = useState(false);
  const [toolId, setToolId] = useState<string | null>(null);
  const detail = selection.detail;
  const authored = selection.visual.status === "ready" ? selection.visual : null;
  const state = authored?.snapshot.state;
  const title = state?.title ?? selection.node.title;
  const chosenTool = detail?.tools.find((row) => row.sourceItemId === toolId);
  const panels = state?.panels ?? [];
  const collapsed = (kind: (typeof panels)[number]["kind"]) =>
    panels.find((panel) => panel.kind === kind)?.collapsed === true;
  return (
    <article aria-label="Selected agent dashboard" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">
            Observed status: {selection.node.nativeStatus}. Silence does not establish pause or
            completion.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowText(!showText)}>
            {showText ? "Hide text" : "Show text"}
          </Button>
          <Button variant="outline" onClick={() => onOpenThread(selection.node.ref)}>
            Open canonical thread
          </Button>
        </div>
      </div>
      <p className="text-sm">
        Declarative dashboard:{" "}
        {authored
          ? `${authored.snapshot.provenance} · revision ${authored.snapshot.revision}`
          : selection.visual.status}
        . Editing from an agent is unavailable until the canonical owner invocation is wired.
      </p>
      <section
        aria-label="Agent overview"
        className="grid gap-3 rounded-lg border bg-card p-4 text-sm sm:grid-cols-2 lg:grid-cols-3"
      >
        <p>
          <strong>Current:</strong>{" "}
          {state
            ? (state.steps.find((step) => step.id === state.currentStepId)?.label ?? "Unknown")
            : (detail?.currentStep?.text ?? "Unknown / not recorded")}
        </p>
        <p>
          <strong>Completed:</strong>{" "}
          {state
            ? state.steps.filter((step) => step.status === "completed").length
            : (detail?.completedSteps.length ?? "Unknown")}
        </p>
        <p>
          <strong>Next:</strong>{" "}
          {state
            ? (state.steps.find((step) => step.status === "pending")?.label ?? "None declared")
            : (detail?.nextSteps[0]?.text ?? "Unknown / not recorded")}
        </p>
        <p>
          <strong>Pending requests:</strong> {detail?.pendingRequests.length ?? "Unknown"}
          {detail && detail.pendingRequests.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => onOpenThread(selection.node.ref)}>
              Review in thread
            </Button>
          )}
        </p>
        <p>
          <strong>Pausepoint:</strong>{" "}
          {state?.requestedCheckpoint
            ? `${state.requestedCheckpoint.label} · ${authored?.checkpointReached ? "Reached with canonical evidence" : "Requested, not proven reached"}`
            : "No reached evidence"}
        </p>
      </section>
      {detail === null ? (
        <p role="status">
          Selected details unavailable or synchronizing. Cached activity is hidden.
        </p>
      ) : (
        <>
          <section aria-label="Pending requests" className="rounded-lg border p-4">
            <h3 className="font-medium">Pending requests · observed native events</h3>
            {detail.pendingRequests.length === 0 ? (
              <p className="text-sm">No pending requests in the loaded projection.</p>
            ) : (
              detail.pendingRequests.map((request) => (
                <p className="text-sm" key={request.id}>
                  {request.kind} · pending · response: {request.responseCapability.type}
                </p>
              ))
            )}
            {detail.pendingRequests.length > 0 && (
              <Button variant="outline" onClick={() => onOpenThread(selection.node.ref)}>
                Review requests in thread
              </Button>
            )}
          </section>
          <div className={state?.layout === "split" ? "grid gap-4 lg:grid-cols-2" : "space-y-4"}>
            <details open={!collapsed("plan")} className="rounded-lg border p-4">
              <summary className="font-medium">
                Plan and current step · {state ? "agent-authored" : "observed native"}
              </summary>
              {state ? (
                <>
                  <p>
                    Current:{" "}
                    {state.steps.find((step) => step.id === state.currentStepId)?.label ??
                      "Unknown"}
                  </p>
                  <p>
                    Completed:{" "}
                    {state.steps
                      .filter((step) => step.status === "completed")
                      .map((step) => step.label)
                      .join(" · ") || "None declared"}
                  </p>
                  <p>
                    Next:{" "}
                    {state.steps
                      .filter((step) => step.status === "pending")
                      .map((step) => step.label)
                      .join(" · ") || "None declared"}
                  </p>
                  <ul>
                    {state.steps.map((step) => (
                      <li key={step.id}>
                        {step.status}: {step.label}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <p>Current: {detail.currentStep?.text ?? "Unknown / not recorded"}</p>
                  <p>
                    Completed: {detail.completedSteps.length} · Next:{" "}
                    {detail.nextSteps[0]?.text ?? "Unknown / not recorded"}
                  </p>
                  <ul>
                    {detail.steps.map((step, index) => (
                      <li key={index}>
                        {step.status}: {step.text}
                      </li>
                    ))}
                  </ul>
                  {detail.plans
                    .filter((plan) => plan.kind === "proposed_plan")
                    .map((plan) => (
                      <details key={plan.id}>
                        <summary>Observed proposed plan</summary>
                        <pre className="whitespace-pre-wrap break-words text-sm">
                          {plan.detailInTurnItem
                            ? "Plan body is in the canonical thread activity."
                            : plan.kind === "proposed_plan"
                              ? plan.markdown
                              : null}
                        </pre>
                      </details>
                    ))}
                </>
              )}
              {showText && state?.summary && <p>{state.summary}</p>}
            </details>
            <details open={!collapsed("todos")} className="rounded-lg border p-4">
              <summary className="font-medium">Todos</summary>
              {state ? (
                <ul>
                  {state.todos.map((todo) => (
                    <li key={todo.id}>
                      {todo.status}: {todo.label}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm">Shown in the observed plan when available.</p>
              )}
            </details>
            <section className="rounded-lg border p-4" aria-label="Checkpoint">
              <h3 className="font-medium">Requested pausepoint</h3>
              {state?.requestedCheckpoint ? (
                <>
                  <p>
                    {state.requestedCheckpoint.label} · When: {state.requestedCheckpoint.when}
                  </p>
                  <p>
                    {authored?.checkpointReached
                      ? "Reached · canonical event evidence"
                      : "Requested · not proven reached"}
                  </p>
                  <p className="text-sm">
                    This does not grant approval or prove the runtime paused.
                  </p>
                </>
              ) : (
                <p className="text-sm">
                  No canonical agent-authored checkpoint available. No pause inferred.
                </p>
              )}
            </section>
            <details open={state ? !collapsed("tools") : false} className="rounded-lg border p-4">
              <summary className="font-medium">Commands and tools · observed native</summary>
              <p className="text-sm">
                {detail.omittedTools} older loaded entries omitted. Open one entry to inspect its
                authorized arguments and result.
              </p>
              <ul>
                {detail.tools.map((row) => (
                  <li key={row.sourceItemId}>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setToolId(toolId === row.sourceItemId ? null : row.sourceItemId)
                      }
                    >
                      {row.item.type === "dynamic_tool" ? row.item.toolName : "Command"} ·{" "}
                      {row.item.status}
                    </Button>
                    {(row.item.type === "dynamic_tool" || row.item.type === "command_execution") &&
                      row.item.outputOmitted && (
                        <span className="text-xs">
                          Output omitted; explicit inspection may read this entry.
                        </span>
                      )}
                  </li>
                ))}
              </ul>
              {chosenTool && renderTool(chosenTool, selection.node.ref)}
            </details>
            <section className="rounded-lg border p-4">
              <h3 className="font-medium">Compaction boundaries · observed native</h3>
              <p className="text-sm">
                {detail.compactions.length} loaded · {detail.omittedCompactions} omitted from view.
                Earlier history may be incomplete.
              </p>
              {detail.compactions.map((row) => (
                <div key={row.sourceItemId}>
                  <p className="text-xs">Boundary {row.sourceItemId}</p>
                  {showText && (
                    <pre className="whitespace-pre-wrap break-words text-sm">
                      {nativeItemText(row) ?? "Summary unavailable"}
                    </pre>
                  )}
                </div>
              ))}
            </section>
            <section className="rounded-lg border p-4">
              <h3 className="font-medium">Native agents in selected loaded thread</h3>
              {detail.subagents.map((agent) => (
                <p key={agent.id} className="text-sm">
                  {agent.status} ·{" "}
                  {agent.childThreadId === null ? "No navigable child thread" : agent.childThreadId}
                </p>
              ))}
              <p className="text-sm">
                {detail.subagents.length} recorded here. Environment-wide native roster unavailable;
                this is not a complete fleet.
              </p>
            </section>
          </div>
          {showText && (
            <section aria-label="Conversation text" className="rounded-lg border p-4">
              <h3 className="font-medium">Conversation · loaded current run only</h3>
              <p className="text-sm">
                {detail.omittedChat} older loaded messages omitted. Text is limited to 8,000
                characters per item.
              </p>
              {detail.chat.map((row) => (
                <pre
                  key={row.sourceItemId}
                  className="mt-3 whitespace-pre-wrap break-words text-sm"
                >
                  {nativeItemText(row)}
                </pre>
              ))}
            </section>
          )}
          <p className="text-sm text-muted-foreground">
            History:{" "}
            {detail.history.hasMoreHistory
              ? "Earlier entries not loaded; open canonical thread to expand history."
              : "Loaded snapshot boundary; no claim about unrecorded activity."}
          </p>
        </>
      )}
    </article>
  );
}
