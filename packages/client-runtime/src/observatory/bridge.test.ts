import { describe, expect, it } from "vite-plus/test";
import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  type AuthSessionState,
} from "@t3tools/contracts";
import { PrimaryConnectionTarget } from "../connection/model.ts";
import type { EnvironmentCatalogState } from "../state/connections.ts";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import { v2Projection, v2ShellSnapshot, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import { EMPTY_THREAD_HISTORY_META } from "../state/threadHistoryMerge.ts";
import type { EnvironmentThreadState } from "../state/threads.ts";
import type { EnvironmentShellState } from "../state/shell.ts";
import { createObservatoryProjectionBridge, type ObservatoryConnection } from "./bridge.ts";
const environmentId = EnvironmentId.make("one");
const allowed: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [AuthOrchestrationReadScope],
  permissions: [AuthOrchestrationReadScope],
};

describe("observatory live access boundary", () => {
  it("hides prior success on same-destination grant loss before mounting details; restore and reconnect start fresh scopes", () => {
    const registry = AtomRegistry.make();
    const catalog = Atom.make<EnvironmentCatalogState>({
      isReady: true,
      entries: new Map([
        [
          environmentId,
          {
            enabled: true,
            profile: Option.none(),
            target: new PrimaryConnectionTarget({
              environmentId,
              label: "One",
              httpBaseUrl: "http://owned.invalid",
              wsBaseUrl: "ws://owned.invalid",
            }),
          },
        ],
      ]),
    });
    const connection = Atom.make<ObservatoryConnection | null>({
      generation: 1,
      status: "connected",
      session: {},
    });
    const grant = Atom.make<AuthSessionState | null>(allowed);
    const scopes: {
      shell: Atom.Writable<EnvironmentShellState | null>;
      detail: Atom.Writable<EnvironmentThreadState | null>;
    }[] = [];
    const view = createObservatoryProjectionBridge({
      catalogAtom: catalog,
      connectionAtom: () => connection,
      sessionAtom: () => grant,
      createScope: () => {
        const scope = {
          shell: Atom.make<EnvironmentShellState | null>(null),
          detail: Atom.make<EnvironmentThreadState | null>(null),
        };
        scopes.push(scope);
        return { shell: () => scope.shell, detail: () => scope.detail };
      },
    });
    const unmount = registry.mount(view.snapshotAtom);
    try {
      expect(scopes).toHaveLength(1);
      const first = scopes[0]!;
      registry.set(first.shell, {
        status: "live",
        snapshot: Option.some(v2ShellSnapshot),
        error: Option.none(),
      });
      registry.set(view.selectedAtom, { environmentId, threadId: v2ThreadId });
      registry.set(first.detail, {
        status: "live",
        data: Option.some(v2Projection),
        error: Option.none(),
        history: EMPTY_THREAD_HISTORY_META,
      });
      expect(registry.get(view.snapshotAtom).selection?.detail).not.toBeNull();
      registry.set(grant, { ...allowed, scopes: [], permissions: [] });
      expect(registry.get(view.snapshotAtom).selection).toBeNull();
      expect(registry.get(view.snapshotAtom).nodes).toEqual([]);
      expect(scopes).toHaveLength(1);
      // A late projection from the old scope cannot re-expose data.
      registry.set(first.shell, {
        status: "live",
        snapshot: Option.some(v2ShellSnapshot),
        error: Option.none(),
      });
      expect(registry.get(view.snapshotAtom).nodes).toEqual([]);
      registry.set(grant, null);
      expect(scopes).toHaveLength(1);
      registry.set(grant, allowed);
      expect(registry.get(view.snapshotAtom).nodes).toEqual([]);
      expect(scopes).toHaveLength(2);
      registry.set(connection, { generation: 2, status: "synchronizing", session: null });
      expect(registry.get(view.snapshotAtom).nodes).toEqual([]);
      registry.set(connection, { generation: 2, status: "connected", session: {} });
      expect(registry.get(view.snapshotAtom).nodes).toEqual([]);
      expect(scopes).toHaveLength(3);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});
