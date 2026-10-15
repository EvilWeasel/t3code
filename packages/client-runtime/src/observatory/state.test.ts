import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  RunId,
  TurnItemId,
  OrchestrationV2ThreadProjection,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  v2Projection,
  v2ShellSnapshot,
  v2ThreadShell,
  v2Now,
} from "../state/orchestrationV2TestFixtures.ts";
import { EMPTY_THREAD_HISTORY_META } from "../state/threadHistoryMerge.ts";
import type { EnvironmentThreadState } from "../state/threads.ts";
import {
  projectObservatoryDetails,
  projectObservatoryNative,
  type ObservatoryEnvironment,
} from "./native.ts";
import { createObservatoryViewAtoms, type ObservatoryAuthoredSource } from "./state.ts";

const env = EnvironmentId.make("one");
const ref = { environmentId: env, threadId: v2ThreadShell.id };
const source: ObservatoryEnvironment = {
  environmentId: env,
  label: "One",
  generation: 1,
  status: "live",
  shell: { status: "live", snapshot: Option.some(v2ShellSnapshot), error: Option.none() },
};
const detail: EnvironmentThreadState = {
  status: "live",
  data: Option.some(v2Projection),
  error: Option.none(),
  history: EMPTY_THREAD_HISTORY_META,
};
function command(n: number): OrchestrationV2ProjectedTurnItem {
  const id = TurnItemId.make(`command:${n}`);
  return {
    position: n,
    sourceThreadId: ref.threadId,
    sourceItemId: id,
    visibility: "local",
    item: {
      id,
      threadId: ref.threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: n,
      status: "completed",
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "command_execution",
      input: "owned synthetic command",
      outputOmitted: true,
    },
  };
}
describe("observatory canonical projection view", () => {
  it("updates the shared graph/list nodes and drops selected detail on revoke, disconnect, and missing run", () => {
    const registry = AtomRegistry.make();
    const sources = Atom.make<readonly ObservatoryEnvironment[]>([source]);
    const selected = Atom.make<typeof ref | null>(ref);
    const details = Atom.make<EnvironmentThreadState | null>(detail);
    const view = createObservatoryViewAtoms({
      catalogReadyAtom: Atom.make(true),
      sourcesAtom: sources,
      selectedAtom: selected,
      detailAtom: () => details,
    });
    const unmount = registry.mount(view.snapshotAtom);
    try {
      expect(registry.get(view.snapshotAtom).selection?.detail).not.toBeNull();
      registry.set(sources, [
        {
          ...source,
          shell: {
            ...source.shell!,
            snapshot: Option.some({
              ...v2ShellSnapshot,
              threads: [{ ...v2ThreadShell, title: "Latest native title" }],
            }),
          },
        },
      ]);
      expect(registry.get(view.snapshotAtom).nodes[0]?.title).toBe("Latest native title");
      registry.set(sources, [{ ...source, status: "denied" }]);
      expect(registry.get(view.snapshotAtom).nodes).toEqual([]);
      expect(registry.get(view.snapshotAtom).selection).toBeNull();
      registry.set(sources, [{ ...source, status: "offline" }]);
      expect(registry.get(view.snapshotAtom).nodes).toEqual([]);
      registry.set(sources, [
        {
          ...source,
          generation: 2,
          shell: {
            ...source.shell!,
            snapshot: Option.some({
              ...v2ShellSnapshot,
              threads: [{ ...v2ThreadShell, activeRunId: RunId.make("new-run") }],
            }),
          },
        },
      ]);
      expect(registry.get(view.snapshotAtom).selection?.detail).toBeNull();
      registry.set(details, { ...detail, status: "synchronizing" });
      expect(registry.get(view.snapshotAtom).selection?.detail).toBeNull();
    } finally {
      unmount();
      registry.dispose();
    }
  });
  it("does not expose cache/error projections, cross-environment detail or omitted tool output as complete", () => {
    const node = projectObservatoryNative([source]).nodes[0]!;
    expect(projectObservatoryDetails(node, source, { ...detail, status: "cached" })).toBeNull();
    expect(
      projectObservatoryDetails(node, source, { ...detail, error: Option.some("redacted") }),
    ).toBeNull();
    expect(
      projectObservatoryDetails(
        node,
        { ...source, environmentId: EnvironmentId.make("other") },
        detail,
      ),
    ).toBeNull();
    const projection = {
      ...v2Projection,
      visibleTurnItems: Array.from({ length: 30 }, (_, i) => command(i)),
    };
    const result = projectObservatoryDetails(node, source, {
      ...detail,
      data: Option.some(projection),
    });
    expect(result?.tools).toHaveLength(24);
    expect(result?.omittedTools).toBe(6);
    expect(
      result?.tools.every((row) => row.item.type === "command_execution" && row.item.outputOmitted),
    ).toBe(true);
    expect(
      projectObservatoryNative([{ ...source, shell: { ...source.shell!, status: "cached" } }])
        .nodes,
    ).toEqual([]);
  });
  it("revises the shared node and selected dashboard atomically from canonical owner-correlated reads", () => {
    const registry = AtomRegistry.make();
    const runId = RunId.make("run");
    const owner = {
      environmentId: env,
      threadId: ref.threadId,
      runId,
      attemptId: "attempt",
      rootNodeId: "root",
      providerInstanceId: "codex",
      providerThreadId: "native-thread",
      providerTurnId: "turn",
    };
    const projection = Schema.decodeUnknownSync(OrchestrationV2ThreadProjection)({
      ...v2Projection,
      runs: [
        {
          id: runId,
          threadId: ref.threadId,
          ordinal: 1,
          providerInstanceId: "codex",
          modelSelection: v2ThreadShell.modelSelection,
          providerThreadId: "native-thread",
          userMessageId: "message",
          rootNodeId: "root",
          activeAttemptId: "attempt",
          status: "running",
          requestedAt: v2Now,
          startedAt: v2Now,
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
          startedAt: v2Now,
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
          startedAt: v2Now,
          completedAt: null,
        },
      ],
    });
    const input = (revision: number, title: string): ObservatoryAuthoredSource => ({
      generation: 1,
      checkpointReached: null,
      read: {
        environmentId: env,
        threadId: ref.threadId,
        status: "online",
        throughSequence: 30,
        snapshot: {
          owner,
          revision,
          eventId: `event:${revision}`,
          sequence: revision + 10,
          recordedAt: v2Now,
          provenance: "agent-authored",
          nativeFrontier: { source: "observed-native", sequence: 10, rawEventId: null },
          state: {
            title,
            steps: [],
            todos: [],
            currentStepId: null,
            requestedCheckpoint: null,
            layout: "split",
            panels: [],
          },
        },
      },
    });
    const reads = Atom.make<ObservatoryAuthoredSource | null>(input(1, "First declared plan"));
    const sources = Atom.make<readonly ObservatoryEnvironment[]>([
      {
        ...source,
        shell: {
          ...source.shell!,
          snapshot: Option.some({
            ...v2ShellSnapshot,
            threads: [{ ...v2ThreadShell, activeRunId: runId }],
          }),
        },
      },
    ]);
    const view = createObservatoryViewAtoms({
      catalogReadyAtom: Atom.make(true),
      sourcesAtom: sources,
      selectedAtom: Atom.make<typeof ref | null>(ref),
      detailAtom: () => Atom.make({ ...detail, data: Option.some(projection) }),
      authoredAtom: () => reads,
    });
    const unmount = registry.mount(view.snapshotAtom);
    try {
      expect(registry.get(view.snapshotAtom).nodes[0]?.title).toBe("First declared plan");
      registry.set(reads, input(2, "Updated declared plan"));
      const updated = registry.get(view.snapshotAtom);
      expect(updated.nodes[0]?.title).toBe("Updated declared plan");
      expect(
        updated.selection?.visual.status === "ready" &&
          updated.selection.visual.snapshot.state.title,
      ).toBe("Updated declared plan");
      registry.set(reads, input(1, "First declared plan"));
      expect(registry.get(view.snapshotAtom).selection?.visual.status).toBe("stale");
      registry.set(reads, { ...input(3, "Old generation"), generation: 0 });
      expect(registry.get(view.snapshotAtom).nodes[0]?.title).toBe(v2ThreadShell.title);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

effectIt.effect(
  "consumes live projection stream revisions and reconnect gaps without polling",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stream = yield* SubscriptionRef.make<readonly ObservatoryEnvironment[]>([source]);
        const runtime = Atom.runtime(Layer.empty);
        const raw = runtime.atom(SubscriptionRef.changes(stream));
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const sources = Atom.make((get) => {
          const value = get(raw);
          return AsyncResult.isSuccess(value) && !value.waiting ? value.value : [];
        });
        const view = createObservatoryViewAtoms({
          catalogReadyAtom: Atom.make(true),
          sourcesAtom: sources,
          selectedAtom: Atom.make<typeof ref | null>(ref),
          detailAtom: () => Atom.make(detail),
        });
        const waitFor = (predicate: (value: Atom.Type<typeof view.snapshotAtom>) => boolean) =>
          Effect.callback<void>((resume) => {
            const cancel = registry.subscribe(
              view.snapshotAtom,
              (value) => {
                if (predicate(value)) resume(Effect.void);
              },
              { immediate: true },
            );
            return Effect.sync(cancel);
          });
        yield* waitFor((value) => value.nodes.length === 1);
        yield* SubscriptionRef.set(stream, [{ ...source, status: "synchronizing", generation: 2 }]);
        yield* waitFor((value) => value.nodes.length === 0 && value.selection === null);
        yield* SubscriptionRef.set(stream, [
          {
            ...source,
            generation: 2,
            shell: {
              ...source.shell!,
              snapshot: Option.some({
                ...v2ShellSnapshot,
                threads: [{ ...v2ThreadShell, title: "Reconnected revision" }],
              }),
            },
          },
        ]);
        yield* waitFor((value) => value.nodes[0]?.title === "Reconnected revision");
        yield* SubscriptionRef.set(stream, [{ ...source, generation: 2, status: "denied" }]);
        yield* waitFor(
          (value) => value.nodes.length === 0 && value.sources[0]?.status === "denied",
        );
      }),
    ),
);
