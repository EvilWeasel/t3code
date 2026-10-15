import { RegistryContext } from "@effect/atom-react";
import {
  createObservatoryViewAtoms,
  type ObservatoryAuthoredSource,
  type ObservatoryEnvironment,
} from "@t3tools/client-runtime/observatory";
import {
  EnvironmentId,
  RunId,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadProjection,
  TurnItemId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AgentObservatoryPage } from "./AgentObservatoryPage";

vi.mock("@t3tools/client-runtime/observatory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/observatory")>();
  return {
    ...actual,
    createLiveObservatory: () => ({
      get snapshotAtom() {
        return view.snapshotAtom;
      },
      get selectedAtom() {
        return view.selectedAtom;
      },
      get queryAtom() {
        return view.queryAtom;
      },
    }),
  };
});
vi.mock("../connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: null } }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: null }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => openThread }));
vi.mock("../components/chat/V2ItemInspector", () => ({ V2ItemInspector: () => inspect() }));
const now = DateTime.makeUnsafe("2026-10-16T00:00:00.000Z");
const environmentId = EnvironmentId.make("one");
const runId = RunId.make("run");
const shell = Schema.decodeUnknownSync(OrchestrationV2ThreadShell)({
  id: "thread",
  projectId: "project",
  title: "Observe provider",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "test" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "thread", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: runId,
  activeRunId: runId,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});
const itemBase = {
  threadId: shell.id,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
};
const row = (id: string, item: object) => ({
  position: 1,
  visibility: "local",
  sourceThreadId: shell.id,
  sourceItemId: TurnItemId.make(id),
  item: { ...itemBase, id, ...item },
});
const projection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjection)({
  thread: shell,
  runs: [
    {
      id: runId,
      threadId: shell.id,
      ordinal: 1,
      providerInstanceId: "codex",
      modelSelection: shell.modelSelection,
      providerThreadId: "native-thread",
      userMessageId: "message",
      rootNodeId: "root",
      activeAttemptId: "attempt",
      status: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  ],
  attempts: [
    {
      id: "attempt",
      runId,
      attemptOrdinal: 1,
      rootNodeId: "root",
      providerInstanceId: "codex",
      providerThreadId: "native-thread",
      providerTurnId: "turn",
      reason: "initial",
      status: "running",
      startedAt: now,
      completedAt: null,
    },
  ],
  providerTurns: [
    {
      id: "turn",
      providerThreadId: "native-thread",
      nodeId: "root",
      runAttemptId: "attempt",
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
    },
  ],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  runtimeRequests: [
    {
      id: "request",
      nodeId: "node",
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "command",
      status: "pending",
      responseCapability: { type: "live", providerSessionId: "session" },
      createdAt: now,
      resolvedAt: null,
    },
  ],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [
    row("tool", { type: "command_execution", input: "synthetic command", outputOmitted: true }),
    row("text", {
      type: "assistant_message",
      text: "Synthetic observed message",
      messageId: "message",
      streaming: false,
    }),
    row("compact", { type: "compaction", driver: null, summary: "Synthetic boundary" }),
  ],
  updatedAt: now,
});
const source: ObservatoryEnvironment = {
  environmentId,
  label: "One",
  status: "live",
  generation: 1,
  shell: {
    status: "live",
    snapshot: Option.some({
      schemaVersion: 1,
      snapshotSequence: 1,
      projects: [],
      threads: [shell],
      archivedThreads: [],
    }),
    error: Option.none(),
  },
};
const details = {
  status: "live" as const,
  data: Option.some(projection),
  error: Option.none<string>(),
  history: {
    historyCursor: "earlier",
    hasMoreHistory: true,
    loading: false,
    error: null,
    expanded: false,
    latestLocalTurnOrdinal: null,
  },
};
let root: Root;
let container: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
const openThread = vi.fn();
const inspect = vi.fn(() => <p>Authorized single-entry inspector</p>);
const sources = Atom.make<readonly ObservatoryEnvironment[]>([source]);
const selected = Atom.make<ScopedThreadRef | null>(null);
const authored = Atom.make<ObservatoryAuthoredSource | null>(null);
const view = createObservatoryViewAtoms({
  catalogReadyAtom: Atom.make(true),
  sourcesAtom: sources,
  selectedAtom: selected,
  detailAtom: () => Atom.make(details),
  authoredAtom: () => authored,
});
function button(label: string) {
  const target = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  if (!target) throw new Error(`Missing test button: ${label}`);
  return target;
}
const remoteEnvironment = EnvironmentId.make("two");
function largeSources(): readonly ObservatoryEnvironment[] {
  return [
    {
      ...source,
      shell: {
        ...source.shell!,
        snapshot: Option.some({
          schemaVersion: 1,
          snapshotSequence: 3,
          projects: [],
          archivedThreads: [],
          threads: Array.from({ length: 500 }, (_, index) => {
            const id = ThreadId.make(`shell-${String(index).padStart(4, "0")}`);
            return {
              ...shell,
              id,
              title: `Local ${index}`,
              lineage: { ...shell.lineage, rootThreadId: id },
            };
          }),
        }),
      },
    },
    {
      ...source,
      environmentId: remoteEnvironment,
      label: "Remote host",
      shell: {
        ...source.shell!,
        snapshot: Option.some({
          schemaVersion: 1,
          snapshotSequence: 3,
          projects: [],
          archivedThreads: [],
          threads: Array.from({ length: 39 }, (_, index) => {
            const id = ThreadId.make(`shell-${String(index).padStart(4, "0")}`);
            return {
              ...shell,
              id,
              title: `Remote ${index}`,
              lineage: { ...shell.lineage, rootThreadId: id },
            };
          }),
        }),
      },
    },
  ];
}
function searchThreads(text: string) {
  const input = container.querySelector('input[aria-label="Search known threads"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing search field");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(async () => {
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  openThread.mockClear();
  inspect.mockClear();
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <AgentObservatoryPage />
      </RegistryContext.Provider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  container.remove();
});
describe("mounted observatory projection dashboard", () => {
  it("shares live graph/list selection, reduces text, lazily inspects a tool, and links canonical request resolution", async () => {
    expect(container.querySelector('[aria-label="Agent graph"]')?.textContent).toContain(
      "Observe provider",
    );
    await act(async () => button("Show list").click());
    expect(container.querySelector('[aria-label="Agent list"]')?.textContent).toContain(
      "Observe provider",
    );
    await act(async () => button("Observe provider").click());
    expect(container.querySelector('[aria-label="Selected agent dashboard"]')).not.toBeNull();
    expect(container.textContent).toContain("No pause inferred");
    expect(container.textContent).toContain("command · pending");
    expect(container.textContent).toContain("Earlier entries not loaded");
    expect(container.textContent).toContain("Boundary compact");
    expect(container.textContent).not.toContain("Synthetic observed message");
    expect(inspect).not.toHaveBeenCalled();
    await act(async () => button("Show text").click());
    expect(container.textContent).toContain("Synthetic observed message");
    await act(async () => button("Hide text").click());
    expect(container.textContent).not.toContain("Synthetic observed message");
    await act(async () => button("Command · completed").click());
    expect(inspect).toHaveBeenCalledTimes(1);
    await act(async () => button("Review requests in thread").click());
    expect(openThread).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: shell.id },
    });
    await act(async () => registry.set(sources, [{ ...source, status: "denied" }]));
    expect(container.querySelector('[aria-label="Selected agent dashboard"]')).toBeNull();
    expect(container.textContent).not.toContain("Synthetic observed message");
    expect(container.textContent).toContain("One: denied");
  });
  it("uses new native titles in both views and does not turn offline history into a live dashboard", async () => {
    await act(async () =>
      registry.set(sources, [
        {
          ...source,
          shell: {
            ...source.shell!,
            snapshot: Option.some({
              schemaVersion: 1,
              snapshotSequence: 2,
              projects: [],
              threads: [{ ...shell, title: "Latest revision" }],
              archivedThreads: [],
            }),
          },
        },
      ]),
    );
    expect(container.textContent).toContain("Latest revision");
    await act(async () => button("Show list").click());
    expect(container.querySelector('[aria-label="Agent list"]')?.textContent).toContain(
      "Latest revision",
    );
    await act(async () => registry.set(sources, [{ ...source, generation: 2, status: "offline" }]));
    expect(container.textContent).not.toContain("Latest revision");
    expect(container.textContent).toContain("One: offline");
    expect(container.textContent).toContain("not enumerated");
  });
  it("changes the selected declarative dashboard on a canonical revision and only marks reached with exact event proof", async () => {
    await act(async () => button("Observe provider").click());
    const owner = {
      environmentId,
      threadId: shell.id,
      runId,
      attemptId: "attempt",
      rootNodeId: "root",
      providerInstanceId: "codex",
      providerThreadId: "native-thread",
      providerTurnId: "turn",
    };
    const read = (revision: number, title: string) => ({
      environmentId,
      threadId: shell.id,
      status: "online",
      throughSequence: 50,
      snapshot: {
        owner,
        revision,
        eventId: `event:${revision}`,
        sequence: 20 + revision,
        recordedAt: now,
        provenance: "agent-authored",
        nativeFrontier: { source: "observed-native", sequence: 10, rawEventId: null },
        state: {
          title,
          currentStepId: "inspect",
          steps: [{ id: "inspect", label: "Inspect input", status: "active" }],
          todos: [],
          requestedCheckpoint: { id: "review", label: "Wait for review", when: "Before mutation" },
          layout: "split",
          panels: [{ kind: "plan", collapsed: false }],
        },
      },
    });
    await act(async () =>
      registry.set(authored, {
        generation: 1,
        read: read(1, "Declared first plan"),
        checkpointReached: null,
      }),
    );
    expect(container.textContent).toContain("Declared first plan");
    expect(container.textContent).toContain("Requested · not proven reached");
    await act(async () =>
      registry.set(authored, {
        generation: 1,
        read: read(2, "Declared new plan"),
        checkpointReached: {
          source: "canonical-event",
          owner,
          revision: 2,
          requestedCheckpointId: "review",
          eventId: "event:reached",
          sequence: 40,
        },
      }),
    );
    expect(container.textContent).not.toContain("Declared first plan");
    expect(container.textContent).toContain("Declared new plan");
    expect(container.textContent).toContain("Reached · canonical event evidence");
    expect(container.textContent).toContain("does not grant approval or prove the runtime paused");
    expect(openThread).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    await act(async () =>
      registry.set(authored, {
        generation: 0,
        read: read(3, "Stale host"),
        checkpointReached: null,
      }),
    );
    expect(container.textContent).not.toContain("Stale host");
    expect(container.textContent).not.toContain("Reached · canonical event evidence");
  });
  it("draws actual loaded lineage edges and keeps selection consistent with the list", async () => {
    const child = {
      ...shell,
      id: ThreadId.make("child"),
      title: "Actual child",
      lineage: {
        rootThreadId: shell.id,
        parentThreadId: shell.id,
        relationshipToParent: "subagent" as const,
      },
    };
    await act(async () =>
      registry.set(sources, [
        {
          ...source,
          shell: {
            ...source.shell!,
            snapshot: Option.some({
              schemaVersion: 1,
              snapshotSequence: 2,
              projects: [],
              threads: [shell, child],
              archivedThreads: [],
            }),
          },
        },
      ]),
    );
    expect(
      container.querySelectorAll('path[aria-label="Observed parent-child relationship"]'),
    ).toHaveLength(1);
    expect(container.textContent).toContain("1 observed parent-child edges");
    expect(container.textContent).toContain("Actual child");
    await act(async () => button("Show list").click());
    expect(container.querySelector('[aria-label="Agent list"]')?.textContent).toContain(
      "Actual child",
    );
    expect(container.textContent).toContain("Parent: Observe provider");
  });
  it("makes the 539th cross-host shell selectable through bounded shared graph/list pages", async () => {
    await act(async () => registry.set(sources, largeSources()));
    expect(container.textContent).toContain("Threads 1–50 of 539 matching");
    expect(container.querySelectorAll("foreignObject")).toHaveLength(50);
    expect(inspect).not.toHaveBeenCalled();
    await act(async () => button("Next page").click());
    expect(container.textContent).toContain("Threads 51–100 of 539 matching");
    await act(async () => button("Show list").click());
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(50);
    expect(container.textContent).toContain("Threads 51–100 of 539 matching");
    await act(async () => button("Last page").click());
    expect(container.textContent).toContain("Threads 501–539 of 539 matching");
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(39);
    await act(async () => button("Show graph").click());
    expect(container.querySelectorAll("foreignObject")).toHaveLength(39);
    await act(async () => button("Remote 38").click());
    expect(
      container.querySelector('[aria-label="Selected agent dashboard"]')?.textContent,
    ).toContain("Remote 38");
    expect(container.querySelector('[aria-label="Thread filters and pages"]')).toBeNull();
    await act(async () => button("Open canonical thread").click());
    expect(openThread).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: remoteEnvironment, threadId: ThreadId.make("shell-0038") },
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("filters and searches shells without retargeting selected identity after reorder or grant loss", async () => {
    const large = largeSources();
    await act(async () => registry.set(sources, large));
    const trigger = container.querySelector('button[aria-label="Filter environment"]');
    if (!(trigger instanceof HTMLButtonElement)) throw new Error("Missing environment filter");
    await act(async () => trigger.click());
    const option = [...document.querySelectorAll('[role="option"]')].find((option) =>
      option.textContent?.includes("Remote host"),
    );
    if (!(option instanceof HTMLElement)) throw new Error("Missing environment option");
    await act(async () => option.click());
    expect(container.textContent).toContain("of 39 matching");
    await act(async () => searchThreads("Remote 38"));
    expect(container.textContent).toContain("Threads 1–1 of 1 matching");
    expect(container.querySelectorAll("foreignObject")).toHaveLength(1);
    const reordered = [...large].reverse().map((source) => ({
      ...source,
      shell:
        source.shell === null
          ? null
          : {
              ...source.shell,
              snapshot: Option.map(source.shell.snapshot, (snapshot) => ({
                ...snapshot,
                threads: [...snapshot.threads].reverse(),
              })),
            },
    }));
    await act(async () => registry.set(sources, reordered));
    expect(container.querySelectorAll("foreignObject")).toHaveLength(1);
    await act(async () => button("Remote 38").click());
    expect(registry.get(view.selectedAtom)).toEqual({
      environmentId: remoteEnvironment,
      threadId: ThreadId.make("shell-0038"),
    });
    await act(async () => registry.set(sources, large));
    expect(
      container.querySelector('[aria-label="Selected agent dashboard"]')?.textContent,
    ).toContain("Remote 38");
    await act(async () =>
      registry.set(
        sources,
        large.map((source) =>
          source.environmentId === remoteEnvironment ? { ...source, status: "denied" } : source,
        ),
      ),
    );
    expect(container.querySelector('[aria-label="Selected agent dashboard"]')).toBeNull();
    expect(registry.get(view.selectedAtom)).toBeNull();
    await act(async () => registry.set(sources, large));
    expect(container.querySelector('[aria-label="Selected agent dashboard"]')).toBeNull();
    await act(async () => button("Clear filters").click());
    expect(container.textContent).toContain("Threads 1–50 of 539 matching");
    expect(inspect).not.toHaveBeenCalled();
  });
  it("labels a known parent on another page without drawing an invented on-page edge", async () => {
    const seed = largeSources()[0]!;
    const paged: ObservatoryEnvironment = {
      ...seed,
      shell: {
        ...seed.shell!,
        snapshot: Option.map(seed.shell!.snapshot, (snapshot) => ({
          ...snapshot,
          threads: snapshot.threads
            .slice(0, 51)
            .map((thread, index) =>
              index === 50
                ? {
                    ...thread,
                    lineage: { ...thread.lineage, parentThreadId: snapshot.threads[0]!.id },
                  }
                : thread,
            ),
        })),
      },
    };
    await act(async () => registry.set(sources, [paged]));
    await act(async () => button("Last page").click());
    expect(container.textContent).toContain("Threads 51–51 of 51 matching");
    expect(container.textContent).toContain("Parent outside this page");
    expect(
      container.querySelectorAll('path[aria-label="Observed parent-child relationship"]'),
    ).toHaveLength(0);
    await act(async () => button("Show list").click());
    expect(container.textContent).toContain("Parent: outside this page");
  });
});
