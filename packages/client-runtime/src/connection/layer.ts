import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";

import * as ConnectionResolver from "./resolver.ts";
import * as ConnectionDriver from "./driver.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionOnboarding from "./onboarding.ts";
import { connectionRoutes, hasRelayRoute } from "./routes.ts";
import * as PlatformConnectionSource from "../platform/source.ts";
import * as RelayEnvironmentDiscovery from "../relay/discovery.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as RpcSession from "../rpc/session.ts";

export const watchDiscoveredCompatibility = Effect.fn("connection.watchDiscoveredCompatibility")(
  function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
    const seenChecks = new Map<string, RelayEnvironmentStatusResponse>();
    yield* Stream.merge(
      SubscriptionRef.changes(discovery.state),
      SubscriptionRef.changes(registry.entries),
    ).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(discovery.state);
          if (!current.refreshing) {
            for (const environmentId of seenChecks.keys()) {
              if (!current.environments.has(environmentId)) seenChecks.delete(environmentId);
            }
          }
          const registered = yield* SubscriptionRef.get(registry.entries);
          for (const entry of current.environments.values()) {
            const status = Option.getOrNull(entry.status);
            const descriptor = status?.descriptor;
            if (status === null || descriptor === undefined) continue;
            const environmentId = entry.environment.environmentId;
            // Discovery describes the server behind the relay route. A direct
            // connection (the desktop's own server, a saved URL, SSH) can reach
            // a different server with the same environment id, such as a
            // preview app that shares the home directory. Its socket handshake
            // already checks the protocol.
            const saved = registered.get(environmentId);
            if (
              saved === undefined ||
              connectionRoutes(saved).length !== 1 ||
              !hasRelayRoute(saved)
            )
              continue;
            const previous = seenChecks.get(environmentId);
            const fresh =
              previous?.checkedAt !== status.checkedAt ||
              (previous.descriptor?.orchestrationProtocolVersion ?? 1) !==
                (descriptor.orchestrationProtocolVersion ?? 1) ||
              previous.descriptor?.serverVersion !== descriptor.serverVersion;
            const error = orchestrationProtocolCompatibilityError(descriptor);
            // A replayed health result must not clear a newer socket rejection.
            if (error !== null || fresh) yield* registry.setCompatibility(environmentId, error);
            seenChecks.set(environmentId, status);
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not apply discovered environment compatibility.", { error }),
          ),
        ),
      ),
    );
  },
);

export const watchDiscoveredEnvironments = Effect.fn("connection.watchDiscoveredEnvironments")(
  function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
    const snapshots = discovery.authenticatedSnapshot;
    if (snapshots === undefined) return;
    yield* SubscriptionRef.changes(snapshots).pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const snapshot = yield* SubscriptionRef.get(snapshots);
          if (Option.isNone(snapshot)) {
            yield* registry.removeRelayEnvironments();
          } else if (registry.reconcileDiscovered !== undefined) {
            yield* registry.reconcileDiscovered(snapshot.value);
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not reconcile linked relay environments.", { error }),
          ),
        ),
      ),
    );
  },
);

export function layerWithOptions(options: RpcSession.RpcSessionOptions) {
  const layerDriver = ConnectionDriver.layer.pipe(
    Layer.provide(Layer.mergeAll(ConnectionResolver.layer, RpcSession.layer(options))),
  );
  const layerRegistry = EnvironmentRegistry.layer.pipe(Layer.provide(layerDriver));
  const layerOnboarding = ConnectionOnboarding.layer.pipe(Layer.provide(layerRegistry));
  const layerConnectionServices = Layer.mergeAll(
    layerRegistry,
    RelayEnvironmentDiscovery.layer,
    layerOnboarding,
    // Exposed for updating hosts too old to connect through the driver.
    ConnectionResolver.layer,
  );
  const layerConnectionStartup = Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const platformSource = yield* PlatformConnectionSource.PlatformConnectionSource;
      yield* watchDiscoveredCompatibility().pipe(Effect.forkScoped);
      yield* registry.start;
      yield* watchDiscoveredEnvironments().pipe(Effect.forkScoped);
      // Populate linked environments on cold start without waiting for a UI
      // surface to request discovery. The watcher is already subscribed.
      const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery;
      yield* discovery.refresh;
      if (discovery.authenticatedSnapshot !== undefined) {
        const snapshot = yield* SubscriptionRef.get(discovery.authenticatedSnapshot);
        if (Option.isSome(snapshot) && registry.reconcileDiscovered !== undefined) {
          yield* registry.reconcileDiscovered(snapshot.value);
        } else if (Option.isNone(snapshot)) {
          const state = yield* SubscriptionRef.get(discovery.state);
          if (!state.refreshing && !state.offline && Option.isNone(state.error)) {
            yield* registry.removeRelayEnvironments();
          }
        }
      }
      yield* platformSource.registrations.pipe(
        Stream.runForEach(registry.reconcilePlatform),
        Effect.forkScoped,
      );
    }).pipe(Effect.withSpan("clientRuntime.connection.application.start")),
  );
  return layerConnectionStartup.pipe(
    Layer.provideMerge(layerConnectionServices),
    Layer.provideMerge(RemoteEnvironmentAuthorization.layer),
  );
}

export const layer = layerWithOptions({});
