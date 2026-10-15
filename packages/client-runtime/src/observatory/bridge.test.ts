import { describe, expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClient } from "effect/rpc";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
  type PreparedConnection,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { ShellSnapshotLoader } from "../state/shellSnapshotHttp.ts";
import { ThreadSnapshotLoader } from "../state/threadSnapshotHttp.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  AuthOrchestrationReadScope,
  WsRpcGroup,
  EnvironmentId,
  type AuthSessionState,
} from "@t3tools/contracts";
import { PrimaryConnectionTarget } from "../connection/model.ts";
import type { EnvironmentCatalogState } from "../state/connections.ts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import { v2Projection, v2ShellSnapshot, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import { EMPTY_THREAD_HISTORY_META } from "../state/threadHistoryMerge.ts";
import type { EnvironmentThreadState } from "../state/threads.ts";
import type { EnvironmentShellState } from "../state/shell.ts";
import {
  createLiveObservatory,
  createObservatoryProjectionBridge,
  type ObservatoryConnection,
} from "./bridge.ts";
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

// Only canonical dependency boundaries are doubled. Production access/projection adapters stay real.
vi.mock("../state/session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessionResults }),
}));
vi.mock("../state/shell.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/shell.ts")>()),
  createEnvironmentShellAtoms: streamShellFactory,
}));
vi.mock("../state/threads.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/threads.ts")>()),
  createEnvironmentThreadStateAtoms: streamDetailFactory,
}));
const sessionResults = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
interface StreamScope {
  readonly shell: SubscriptionRef.SubscriptionRef<EnvironmentShellState>;
  readonly detail: SubscriptionRef.SubscriptionRef<EnvironmentThreadState>;
  readonly releaseShell: Deferred.Deferred<void>;
  readonly releaseDetail: Deferred.Deferred<void>;
  readonly failShell: Deferred.Deferred<void>;
  readonly failDetail: Deferred.Deferred<void>;
  readonly shellClosed: Deferred.Deferred<void>;
  readonly detailClosed: Deferred.Deferred<void>;
  readShell?: (
    registry: AtomRegistry.AtomRegistry,
  ) => AsyncResult.AsyncResult<EnvironmentShellState, unknown>;
  readDetail?: (
    registry: AtomRegistry.AtomRegistry,
  ) => AsyncResult.AsyncResult<EnvironmentThreadState, unknown>;
}
let streamScopes: {
  readonly values: readonly StreamScope[];
  opened: number;
  current: StreamScope | null;
} | null = null;
function streamShellFactory<R, E>(runtime: Atom.AtomRuntime<R, E>) {
  const fixture = streamScopes;
  const scope = fixture === null ? undefined : fixture.values[fixture.opened];
  if (!fixture || !scope) throw new Error("Unexpected shell scope in controlled stream fixture");
  fixture.opened++;
  fixture.current = scope;
  const atom = runtime.atom(
    Stream.unwrap(
      Deferred.await(scope.releaseShell).pipe(
        Effect.as(
          Stream.merge(
            SubscriptionRef.changes(scope.shell),
            Stream.fromEffect(
              Deferred.await(scope.failShell).pipe(
                Effect.andThen(Effect.fail("controlled shell failure")),
              ),
            ),
          ),
        ),
      ),
    ).pipe(Stream.ensuring(Deferred.succeed(scope.shellClosed, undefined))),
  );
  scope.readShell = (registry) => registry.get(atom);
  return { stateAtom: (_id: EnvironmentId) => atom };
}
function streamDetailFactory<R, E>(runtime: Atom.AtomRuntime<R, E>) {
  const scope = streamScopes?.current;
  if (!scope) throw new Error("Missing paired detail scope in controlled stream fixture");
  const atom = runtime.atom(
    Stream.unwrap(
      Deferred.await(scope.releaseDetail).pipe(
        Effect.as(
          Stream.merge(
            SubscriptionRef.changes(scope.detail),
            Stream.fromEffect(
              Deferred.await(scope.failDetail).pipe(
                Effect.andThen(Effect.fail("controlled detail failure")),
              ),
            ),
          ),
        ),
      ),
    ).pipe(Stream.ensuring(Deferred.succeed(scope.detailClosed, undefined))),
  );
  scope.readDetail = (registry) => registry.get(atom);
  return { stateAtom: (_id: EnvironmentId, _thread: typeof v2ThreadId) => atom };
}
const makeStreamScope = (title: string): Effect.Effect<StreamScope> =>
  Effect.gen(function* () {
    return {
      shell: yield* SubscriptionRef.make<EnvironmentShellState>({
        status: "live",
        snapshot: Option.some({
          ...v2ShellSnapshot,
          threads: v2ShellSnapshot.threads.map((thread) => ({ ...thread, title })),
        }),
        error: Option.none(),
      }),
      detail: yield* SubscriptionRef.make<EnvironmentThreadState>({
        status: "live",
        data: Option.some({ ...v2Projection, thread: { ...v2Projection.thread, title } }),
        error: Option.none(),
        history: EMPTY_THREAD_HISTORY_META,
      }),
      releaseShell: yield* Deferred.make<void>(),
      releaseDetail: yield* Deferred.make<void>(),
      failShell: yield* Deferred.make<void>(),
      failDetail: yield* Deferred.make<void>(),
      shellClosed: yield* Deferred.make<void>(),
      detailClosed: yield* Deferred.make<void>(),
    } satisfies StreamScope;
  });

effectIt.effect(
  "production adapter consumes ongoing current streams and refuses stale scopes and Failure.previousSuccess",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const controlled = yield* Effect.all({
          first: makeStreamScope("First live"),
          restored: makeStreamScope("Grant restored"),
          authRestored: makeStreamScope("Auth restored"),
          reconnected: makeStreamScope("Reconnected"),
        });
        streamScopes = {
          values: [
            controlled.first,
            controlled.restored,
            controlled.authRestored,
            controlled.reconnected,
          ],
          opened: 0,
          current: null,
        };
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            streamScopes = null;
          }),
        );
        const target = new PrimaryConnectionTarget({
          environmentId,
          label: "One",
          httpBaseUrl: "http://owned.invalid",
          wsBaseUrl: "ws://owned.invalid",
        });
        const entries = new Map<EnvironmentId, ConnectionCatalogEntry>([
          [environmentId, { target, enabled: true, profile: Option.none() }],
        ]);
        const protocol = yield* RpcClient.makeNoSerialization(WsRpcGroup, {
          onFromClient: () => Effect.die("Unexpected RPC call in adapter-only stream fixture"),
        });
        const firstSession: RpcSession = {
          client: protocol.client,
          initialConfig: Effect.die("Unexpected config read"),
          subscribeServerConfig: () => Stream.die("Unexpected config subscription"),
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        const connection = yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connecting",
          generation: 1,
        });
        const session = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
        const supervisor = EnvironmentSupervisor.of({
          target,
          state: connection,
          session,
          prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const followStream: EnvironmentRegistry["Service"]["followStream"] = (_id, source) =>
          Stream.provideService(source, EnvironmentSupervisor, supervisor);
        const runtime = Atom.runtime(
          Layer.mergeAll(
            Layer.mock(EnvironmentRegistry)({
              entries:
                yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
                  entries,
                ),
              networkStatus: yield* SubscriptionRef.make("online" as const),
              followStream,
            }),
            Layer.mock(EnvironmentCacheStore)({}),
            Layer.mock(ShellSnapshotLoader)({}),
            Layer.mock(ThreadSnapshotLoader)({}),
          ),
        );
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        registry.set(sessionResults(environmentId), AsyncResult.success(allowed));
        const view = createLiveObservatory(
          runtime,
          Atom.make<EnvironmentCatalogState>({ isReady: true, entries }),
        );
        const unmount = registry.mount(view.snapshotAtom);
        yield* Effect.addFinalizer(() => Effect.sync(unmount));
        const waitFor = (predicate: (value: Atom.Type<typeof view.snapshotAtom>) => boolean) =>
          Effect.callback<void>((resume) => {
            const stop = registry.subscribe(
              view.snapshotAtom,
              (value) => {
                if (predicate(value)) resume(Effect.void);
              },
              { immediate: true },
            );
            return Effect.sync(stop);
          });
        const select = () =>
          registry.set(view.selectedAtom, { environmentId, threadId: v2ThreadId });
        yield* waitFor((value) => value.sources[0]?.status === "synchronizing");
        expect(streamScopes?.opened).toBe(0);
        yield* SubscriptionRef.set(session, Option.some(firstSession));
        yield* SubscriptionRef.update(connection, (state) => ({ ...state, phase: "connected" }));
        yield* waitFor(
          (value) => value.sources[0]?.status === "synchronizing" && streamScopes?.opened === 1,
        );
        expect(registry.get(view.snapshotAtom).nodes).toEqual([]);
        const first = controlled.first;
        yield* Deferred.succeed(first.releaseShell, undefined);
        yield* waitFor((value) => value.nodes[0]?.title === "First live");
        const initialShell = first.readShell?.(registry);
        expect(initialShell?._tag).toBe("Success");
        expect(initialShell?.waiting).toBe(true);
        select();
        expect(registry.get(view.snapshotAtom).selection?.detail).toBeNull();
        yield* Deferred.succeed(first.releaseDetail, undefined);
        yield* waitFor(
          (value) => value.selection?.detail?.projection.thread.title === "First live",
        );
        expect(first.readDetail?.(registry).waiting).toBe(true);
        yield* SubscriptionRef.update(first.shell, (state) => ({
          ...state,
          snapshot: Option.map(state.snapshot, (snapshot) => ({
            ...snapshot,
            threads: snapshot.threads.map((thread) => ({ ...thread, title: "Current emission" })),
          })),
        }));
        yield* SubscriptionRef.update(first.detail, (state) => ({
          ...state,
          data: Option.map(state.data, (data) => ({
            ...data,
            thread: { ...data.thread, title: "Current detail" },
          })),
        }));
        yield* waitFor(
          (value) =>
            value.nodes[0]?.title === "Current emission" &&
            value.selection?.detail?.projection.thread.title === "Current detail",
        );
        yield* SubscriptionRef.update(first.detail, (state) => ({
          ...state,
          status: "synchronizing",
        }));
        yield* waitFor((value) => value.selection !== null && value.selection.detail === null);
        yield* SubscriptionRef.update(first.detail, (state) => ({ ...state, status: "live" }));
        yield* waitFor(
          (value) => value.selection?.detail?.projection.thread.title === "Current detail",
        );
        yield* Deferred.succeed(first.failDetail, undefined);
        yield* Deferred.await(first.detailClosed);
        yield* waitFor((value) => value.selection !== null && value.selection.detail === null);
        const failedDetail = first.readDetail?.(registry);
        expect(failedDetail?._tag).toBe("Failure");
        expect(
          failedDetail?._tag === "Failure" && Option.isSome(failedDetail.previousSuccess),
        ).toBe(true);
        registry.set(
          sessionResults(environmentId),
          AsyncResult.success({ ...allowed, scopes: [], permissions: [] }),
        );
        yield* waitFor(
          (value) =>
            value.nodes.length === 0 &&
            value.selection === null &&
            value.sources[0]?.status === "denied",
        );
        yield* Deferred.await(first.shellClosed);
        yield* SubscriptionRef.update(first.shell, (state) => ({
          ...state,
          snapshot: Option.map(state.snapshot, (snapshot) => ({
            ...snapshot,
            threads: snapshot.threads.map((thread) => ({ ...thread, title: "Late old scope" })),
          })),
        }));
        registry.set(sessionResults(environmentId), AsyncResult.success(allowed));
        const restored = controlled.restored;
        yield* Deferred.succeed(restored.releaseShell, undefined);
        yield* waitFor((value) => value.nodes[0]?.title === "Grant restored");
        expect(registry.get(view.snapshotAtom).selection).toBeNull();
        select();
        yield* Deferred.succeed(restored.releaseDetail, undefined);
        yield* waitFor(
          (value) => value.selection?.detail?.projection.thread.title === "Grant restored",
        );
        registry.set(
          sessionResults(environmentId),
          AsyncResult.failureWithPrevious(Cause.fail("controlled auth failure"), {
            previous: Option.some(AsyncResult.success(allowed)),
          }),
        );
        yield* waitFor(
          (value) =>
            value.nodes.length === 0 &&
            value.selection === null &&
            value.sources[0]?.status === "denied",
        );
        yield* Deferred.await(restored.shellClosed);
        registry.set(sessionResults(environmentId), AsyncResult.success(allowed));
        const authRestored = controlled.authRestored;
        yield* Deferred.succeed(authRestored.releaseShell, undefined);
        yield* waitFor((value) => value.nodes[0]?.title === "Auth restored");
        yield* SubscriptionRef.update(connection, (state) => ({
          ...state,
          phase: "connecting",
          generation: 2,
        }));
        yield* waitFor(
          (value) => value.nodes.length === 0 && value.sources[0]?.status === "synchronizing",
        );
        yield* Deferred.await(authRestored.shellClosed);
        yield* SubscriptionRef.set(session, Option.some({ ...firstSession }));
        yield* SubscriptionRef.update(connection, (state) => ({ ...state, phase: "connected" }));
        const reconnected = controlled.reconnected;
        yield* Deferred.succeed(reconnected.releaseShell, undefined);
        yield* waitFor(
          (value) =>
            value.nodes[0]?.title === "Reconnected" &&
            value.sources[0]?.environmentId === environmentId,
        );
        expect(registry.get(view.snapshotAtom).selection).toBeNull();
        select();
        yield* Deferred.succeed(reconnected.releaseDetail, undefined);
        yield* waitFor(
          (value) => value.selection?.detail?.projection.thread.title === "Reconnected",
        );
        expect(registry.get(view.snapshotAtom).selection?.source.generation).toBe(2);
        yield* SubscriptionRef.update(first.detail, (state) => ({
          ...state,
          data: Option.map(state.data, (data) => ({
            ...data,
            thread: { ...data.thread, title: "Late generation one" },
          })),
        }));
        expect(registry.get(view.snapshotAtom).selection?.detail?.projection.thread.title).toBe(
          "Reconnected",
        );
        yield* Deferred.succeed(reconnected.failShell, undefined);
        yield* Deferred.await(reconnected.shellClosed);
        yield* waitFor((value) => value.nodes.length === 0 && value.selection === null);
        const failedShell = reconnected.readShell?.(registry);
        expect(failedShell?._tag).toBe("Failure");
        expect(failedShell?._tag === "Failure" && Option.isSome(failedShell.previousSuccess)).toBe(
          true,
        );
      }),
    ),
);
