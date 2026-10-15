import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import { v2Projection, v2ThreadShell, v2Now } from "../state/orchestrationV2TestFixtures.ts";
import { EMPTY_THREAD_HISTORY_META } from "../state/threadHistoryMerge.ts";
import { createObservatoryViewAtoms } from "./state.ts";
import { EMPTY_OBSERVATORY_QUERY, observatoryKey, type ObservatoryEnvironment } from "./native.ts";

const first = EnvironmentId.make("a");
const second = EnvironmentId.make("b");
function environment(environmentId: EnvironmentId, count: number): ObservatoryEnvironment {
  return {
    environmentId,
    label: environmentId === first ? "Primary" : "Remote",
    generation: 1,
    status: "live",
    shell: {
      status: "live",
      error: Option.none(),
      snapshot: Option.some({
        schemaVersion: 1,
        snapshotSequence: 1,
        projects: [],
        archivedThreads: [],
        threads: Array.from({ length: count }, (_, index) => ({
          ...v2ThreadShell,
          id: ThreadId.make(`thread-${String(index).padStart(4, "0")}`),
          title: `${environmentId === first ? "Primary" : "Remote"} ${index}`,
        })),
      }),
    },
  };
}
const lastRef = { environmentId: second, threadId: ThreadId.make("thread-0038") };

describe("shell-only observatory pages", () => {
  it("reaches the 539th thread on another host, traverses every page, and mounts only selected detail", () => {
    const registry = AtomRegistry.make();
    const sources = Atom.make<readonly ObservatoryEnvironment[]>([
      environment(first, 500),
      environment(second, 39),
    ]);
    const detailMounts: string[] = [];
    const detailFamily = Atom.family((environmentId: EnvironmentId) =>
      Atom.family((threadId: ThreadId) =>
        Atom.make(() => {
          detailMounts.push(observatoryKey({ environmentId, threadId }));
          return {
            status: "live" as const,
            data: Option.some({
              ...v2Projection,
              thread: { ...v2Projection.thread, id: threadId },
            }),
            error: Option.none<string>(),
            history: EMPTY_THREAD_HISTORY_META,
          };
        }),
      ),
    );
    const view = createObservatoryViewAtoms({
      catalogReadyAtom: Atom.make(true),
      sourcesAtom: sources,
      selectedAtom: Atom.make<typeof lastRef | null>(null),
      detailAtom: (ref) => detailFamily(ref.environmentId)(ref.threadId),
    });
    const unmount = registry.mount(view.snapshotAtom);
    try {
      expect(registry.get(view.snapshotAtom).page.totalKnownThreads).toBe(539);
      expect(detailMounts).toEqual([]);
      const seen = new Set<string>();
      for (let page = 0; page < 11; page++) {
        const current = registry.get(view.snapshotAtom);
        expect(current.nodes.length).toBeLessThanOrEqual(50);
        for (const node of current.nodes) seen.add(node.key);
        if (current.page.hasNext)
          registry.set(view.queryAtom, { ...current.page.query, anchorKey: current.page.nextKey });
      }
      expect(seen.size).toBe(539);
      const lastPage = registry.get(view.snapshotAtom);
      expect(lastPage.nodes.at(-1)?.ref).toEqual(lastRef);
      expect(
        lastPage.sources.find((source) => source.environmentId === first)?.omittedThreads,
      ).toBe(500);
      expect(
        lastPage.sources.find((source) => source.environmentId === second)?.visibleThreads,
      ).toBe(39);
      expect(detailMounts).toEqual([]);
      registry.set(view.selectedAtom, lastRef);
      expect(registry.get(view.snapshotAtom).selection?.node.ref).toEqual(lastRef);
      expect(registry.get(view.snapshotAtom).selection?.detail?.projection.thread.id).toBe(
        lastRef.threadId,
      );
      expect(detailMounts).toEqual([observatoryKey(lastRef)]);
      registry.set(view.queryAtom, { environmentId: first, search: "Primary 0", anchorKey: null });
      expect(registry.get(view.snapshotAtom).selection?.node.ref).toEqual(lastRef);
      expect(detailMounts).toEqual([observatoryKey(lastRef)]);
      registry.set(view.selectedAtom, null);
      expect(registry.get(view.snapshotAtom).selection).toBeNull();
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("keeps page anchors and scoped selection exact through reorder/new arrivals, filters, and grant restoration", () => {
    const registry = AtomRegistry.make();
    const a = environment(first, 500);
    const b = environment(second, 39);
    const sources = Atom.make<readonly ObservatoryEnvironment[]>([a, b]);
    const view = createObservatoryViewAtoms({
      catalogReadyAtom: Atom.make(true),
      sourcesAtom: sources,
      selectedAtom: Atom.make<typeof lastRef | null>(null),
      detailAtom: () => Atom.make(null),
    });
    const unmount = registry.mount(view.snapshotAtom);
    try {
      const firstPage = registry.get(view.snapshotAtom);
      registry.set(view.queryAtom, {
        ...EMPTY_OBSERVATORY_QUERY,
        anchorKey: firstPage.page.nextKey,
      });
      const anchor = registry.get(view.snapshotAtom).nodes[0]!.key;
      registry.set(sources, [
        b,
        {
          ...a,
          shell: {
            ...a.shell!,
            snapshot: Option.map(a.shell!.snapshot, (snapshot) => ({
              ...snapshot,
              threads: [...snapshot.threads].reverse(),
            })),
          },
        },
      ]);
      expect(registry.get(view.snapshotAtom).nodes[0]?.key).toBe(anchor);
      registry.set(sources, [
        b,
        {
          ...a,
          shell: {
            ...a.shell!,
            snapshot: Option.map(a.shell!.snapshot, (snapshot) => ({
              ...snapshot,
              threads: [
                { ...v2ThreadShell, id: ThreadId.make("aaa-arrived"), title: "New arrival" },
                ...snapshot.threads,
              ],
            })),
          },
        },
      ]);
      expect(registry.get(view.snapshotAtom).nodes[0]?.key).toBe(anchor);
      expect(registry.get(view.snapshotAtom).page.totalKnownThreads).toBe(540);
      registry.set(view.queryAtom, { environmentId: second, search: "Remote 38", anchorKey: null });
      expect(registry.get(view.snapshotAtom).nodes.map((node) => node.ref)).toEqual([lastRef]);
      registry.set(view.selectedAtom, lastRef);
      expect(registry.get(view.selectedAtom)).toEqual(lastRef);
      registry.set(sources, [a, { ...b, status: "denied" }]);
      expect(registry.get(view.snapshotAtom).selection).toBeNull();
      expect(registry.get(view.selectedAtom)).toBeNull();
      registry.set(sources, [a, { ...b, generation: 2 }]);
      expect(registry.get(view.snapshotAtom).selection).toBeNull();
      registry.set(view.selectedAtom, lastRef);
      expect(registry.get(view.snapshotAtom).selection?.node.ref).toEqual(lastRef);
      expect(registry.get(view.snapshotAtom).selection?.source.generation).toBe(2);
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("labels a known parent outside the page and never fabricates a visible edge", () => {
    const registry = AtomRegistry.make();
    const a = environment(first, 51);
    const sources = Atom.make<readonly ObservatoryEnvironment[]>([
      {
        ...a,
        shell: {
          ...a.shell!,
          snapshot: Option.map(a.shell!.snapshot, (snapshot) => ({
            ...snapshot,
            threads: snapshot.threads.map((thread, index) =>
              index === 50
                ? {
                    ...thread,
                    lineage: { ...thread.lineage, parentThreadId: snapshot.threads[0]!.id },
                  }
                : thread,
            ),
          })),
        },
      },
    ]);
    const view = createObservatoryViewAtoms({
      catalogReadyAtom: Atom.make(true),
      sourcesAtom: sources,
      selectedAtom: Atom.make<typeof lastRef | null>(null),
      detailAtom: () => Atom.make(null),
    });
    const unmount = registry.mount(view.snapshotAtom);
    try {
      const initial = registry.get(view.snapshotAtom);
      registry.set(view.queryAtom, { ...initial.page.query, anchorKey: initial.page.lastKey });
      expect(registry.get(view.snapshotAtom).nodes).toHaveLength(1);
      expect(registry.get(view.snapshotAtom).nodes[0]?.parentLocation).toBe("outside-page");
    } finally {
      unmount();
      registry.dispose();
    }
  });
  it("keeps known archived shells reachable, deduplicates identities, and clears a removed selection", () => {
    const registry = AtomRegistry.make();
    const a = environment(first, 1);
    const archive = {
      ...v2ThreadShell,
      id: ThreadId.make("archived"),
      title: "Archived task",
      archivedAt: v2Now,
    };
    const source: ObservatoryEnvironment = {
      ...a,
      shell: {
        ...a.shell!,
        snapshot: Option.map(a.shell!.snapshot, (snapshot) => ({
          ...snapshot,
          archivedThreads: [archive, snapshot.threads[0]!],
        })),
      },
    };
    const sources = Atom.make<readonly ObservatoryEnvironment[]>([source]);
    const view = createObservatoryViewAtoms({
      catalogReadyAtom: Atom.make(true),
      sourcesAtom: sources,
      selectedAtom: Atom.make<typeof lastRef | null>(null),
      detailAtom: () => Atom.make(null),
    });
    const unmount = registry.mount(view.snapshotAtom);
    try {
      expect(registry.get(view.snapshotAtom).page.totalKnownThreads).toBe(2);
      registry.set(view.queryAtom, { ...EMPTY_OBSERVATORY_QUERY, search: "archived" });
      expect(registry.get(view.snapshotAtom).nodes.map((node) => node.ref.threadId)).toEqual([
        archive.id,
      ]);
      registry.set(view.selectedAtom, { environmentId: first, threadId: archive.id });
      expect(registry.get(view.selectedAtom)?.threadId).toBe(archive.id);
      registry.set(sources, [a]);
      expect(registry.get(view.selectedAtom)).toBeNull();
      registry.set(sources, [source]);
      expect(registry.get(view.snapshotAtom).selection).toBeNull();
    } finally {
      unmount();
      registry.dispose();
    }
  });
});
