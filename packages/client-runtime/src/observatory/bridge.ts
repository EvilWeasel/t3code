import {
  AuthOrchestrationReadScope,
  sessionGrantsScope,
  type AuthSessionState,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { EnvironmentCatalogState } from "../state/connections.ts";
import { followStreamInEnvironment } from "../state/runtime.ts";
import { createEnvironmentSessionAtoms } from "../state/session.ts";
import { createEnvironmentShellAtoms, type EnvironmentShellState } from "../state/shell.ts";
import type { ShellSnapshotLoader } from "../state/shellSnapshotHttp.ts";
import type { ThreadSnapshotLoader } from "../state/threadSnapshotHttp.ts";
import {
  createEnvironmentThreadStateAtoms,
  type EnvironmentThreadState,
} from "../state/threads.ts";
import type { ObservatoryEnvironment } from "./native.ts";
import { createObservatoryViewAtoms } from "./state.ts";

interface ProjectionScope {
  readonly shell: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState | null>;
  readonly detail: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThreadState | null>;
}
/** Captured supervisor facts; the production adapter below supplies the actual session identity. */
export interface ObservatoryConnection {
  readonly generation: number;
  readonly status: "connected" | "synchronizing" | "offline";
  readonly session: object | null;
}

/** The read boundary hides previous projections before mounting any newly authorized scope. */
export function createObservatoryProjectionBridge(input: {
  readonly catalogAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly connectionAtom: (id: EnvironmentId) => Atom.Atom<ObservatoryConnection | null>;
  readonly sessionAtom: (id: EnvironmentId) => Atom.Atom<AuthSessionState | null>;
  readonly createScope: () => ProjectionScope;
}) {
  const scopes = new WeakMap<
    AtomRegistry.AtomRegistry,
    Map<EnvironmentId, { session: object; generation: number; scope: ProjectionScope }>
  >();
  const hostAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const entry = get(input.catalogAtom).entries.get(environmentId);
      const base = {
        environmentId,
        label: entry?.target.label ?? environmentId,
        generation: 0,
        shell: null,
      };
      let contexts = scopes.get(get.registry);
      if (!contexts) {
        contexts = new Map();
        scopes.set(get.registry, contexts);
      }
      const unavailable = (status: ObservatoryEnvironment["status"], generation = 0) => {
        contexts.delete(environmentId);
        return { source: { ...base, status, generation }, scope: null };
      };
      if (!entry?.enabled) return unavailable("offline");
      const connection = get(input.connectionAtom(environmentId));
      if (connection === null) return unavailable("unknown");
      if (connection.status !== "connected" || connection.session === null)
        return unavailable(
          connection.status === "synchronizing" ? "synchronizing" : "offline",
          connection.generation,
        );
      const grant = get(input.sessionAtom(environmentId));
      if (grant === null || !sessionGrantsScope(grant, AuthOrchestrationReadScope))
        return unavailable("denied", connection.generation);
      let context = contexts.get(environmentId);
      if (
        !context ||
        context.session !== connection.session ||
        context.generation !== connection.generation
      ) {
        context = {
          session: connection.session,
          generation: connection.generation,
          scope: input.createScope(),
        };
        contexts.set(environmentId, context);
      }
      return {
        source: {
          ...base,
          generation: connection.generation,
          status: "live" as const,
          shell: get(context.scope.shell(environmentId)),
        },
        scope: context.scope,
      };
    }),
  );
  const details = Atom.family((environmentId: EnvironmentId) =>
    Atom.family((threadId: ScopedThreadRef["threadId"]) =>
      Atom.make((get) => {
        const host = get(hostAtom(environmentId));
        return host.scope === null ? null : get(host.scope.detail({ environmentId, threadId }));
      }),
    ),
  );
  return createObservatoryViewAtoms({
    catalogReadyAtom: Atom.make((get) => get(input.catalogAtom).isReady),
    sourcesAtom: Atom.make((get) =>
      [...get(input.catalogAtom).entries.keys()].map((id) => get(hostAtom(id)).source),
    ),
    selectedAtom: Atom.make<ScopedThreadRef | null>(null),
    detailAtom: (ref) => details(ref.environmentId)(ref.threadId),
  });
}

/** Canonical streams only. Reconnect and restored grants use fresh projection factories. */
export function createLiveObservatory<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ShellSnapshotLoader | ThreadSnapshotLoader | R,
    E
  >,
  catalogAtom: Atom.Atom<EnvironmentCatalogState>,
) {
  const sessions = createEnvironmentSessionAtoms(runtime);
  const rawConnection = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              Stream.zipLatest(
                SubscriptionRef.changes(supervisor.state),
                SubscriptionRef.changes(supervisor.session),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  // Ongoing Atom streams emit Success(waiting:true); readiness is carried by the inner states.
  const connections = Atom.family((id: EnvironmentId) =>
    Atom.make((get): ObservatoryConnection | null => {
      const result = get(rawConnection(id));
      if (!AsyncResult.isSuccess(result)) return null;
      const [state, session] = result.value;
      return {
        generation: state.generation,
        status:
          state.phase === "connected"
            ? "connected"
            : state.phase === "connecting"
              ? "synchronizing"
              : "offline",
        session: Option.getOrNull(session),
      };
    }),
  );
  const grants = Atom.family((id: EnvironmentId) =>
    Atom.make((get) => {
      const result = get(sessions.sessionStateAtom(id));
      // Existing command permissions allow cached success during auth refresh, but never Failure.previousSuccess.
      return result._tag === "Failure" ? null : Option.getOrNull(AsyncResult.value(result));
    }),
  );
  return createObservatoryProjectionBridge({
    catalogAtom,
    connectionAtom: connections,
    sessionAtom: grants,
    createScope: () => {
      const shells = createEnvironmentShellAtoms(runtime);
      const details = createEnvironmentThreadStateAtoms(runtime);
      const shellAtoms = Atom.family((id: EnvironmentId) =>
        Atom.make((get) => {
          const result = get(shells.stateAtom(id));
          return AsyncResult.isSuccess(result) ? result.value : null;
        }),
      );
      const detailAtoms = Atom.family((id: EnvironmentId) =>
        Atom.family((thread: ScopedThreadRef["threadId"]) =>
          Atom.make((get) => {
            const result = get(details.stateAtom(id, thread));
            return AsyncResult.isSuccess(result) ? result.value : null;
          }),
        ),
      );
      return { shell: shellAtoms, detail: (ref) => detailAtoms(ref.environmentId)(ref.threadId) };
    },
  });
}
