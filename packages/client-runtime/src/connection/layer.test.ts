import { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as EnvironmentRegistry from "./registry.ts";
import { watchDiscoveredEnvironments } from "./layer.ts";
import * as RelayEnvironmentDiscovery from "../relay/discovery.ts";

describe("connection layer enrollment watcher", () => {
  it.effect(
    "reconciles only authenticated discovery snapshots and removes relay routes on sign-out",
    () =>
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("dd33bc2a-a8bd-43f5-a885-581f57c62d5c");
        const snapshot = {
          identity: { accountId: "authenticated-owner" },
          generation: 7,
          environments: new Map<EnvironmentId, RelayClientEnvironmentRecord>([
            [
              environmentId,
              {
                environmentId,
                label: "Heph",
                endpoint: {
                  httpBaseUrl: "https://relay.example.test",
                  wsBaseUrl: "wss://relay.example.test",
                  providerKind: "manual" as const,
                },
                linkedAt: "2026-10-14T00:00:00.000Z",
              },
            ],
          ]),
          isCurrent: () => Effect.succeed(true),
        } as RelayEnvironmentDiscovery.AuthenticatedRelayEnvironmentSnapshot;
        const authenticatedSnapshot = yield* SubscriptionRef.make<
          Option.Option<RelayEnvironmentDiscovery.AuthenticatedRelayEnvironmentSnapshot>
        >(Option.some(snapshot));
        const state = yield* SubscriptionRef.make(
          RelayEnvironmentDiscovery.EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
        );
        const reconciled = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
        const removals = yield* Ref.make(0);
        const firstReconcile = yield* Deferred.make<void>();
        const removed = yield* Deferred.make<void>();
        const registry = EnvironmentRegistry.EnvironmentRegistry.of({
          reconcileDiscovered: (current) =>
            Ref.update(reconciled, (calls) => [...calls, [...current.environments.keys()]]).pipe(
              Effect.andThen(Deferred.succeed(firstReconcile, undefined)),
            ),
          removeRelayEnvironments: Ref.update(removals, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(removed, undefined)),
          ),
        } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
        const discovery = RelayEnvironmentDiscovery.RelayEnvironmentDiscovery.of({
          state,
          authenticatedSnapshot,
          refresh: Effect.void,
        });

        yield* watchDiscoveredEnvironments().pipe(
          Effect.provide(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry)),
          Effect.provide(
            Layer.succeed(RelayEnvironmentDiscovery.RelayEnvironmentDiscovery, discovery),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(firstReconcile);
        expect(yield* Ref.get(reconciled)).toEqual([[environmentId]]);

        yield* SubscriptionRef.set(authenticatedSnapshot, Option.none());
        yield* Deferred.await(removed);
        expect(yield* Ref.get(removals)).toBe(1);
      }).pipe(Effect.scoped),
  );
});
