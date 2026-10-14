import { EnvironmentId } from "@t3tools/contracts";
import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import {
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ManagedRelay from "./managedRelay.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as Connectivity from "../connection/connectivity.ts";
import { mapManagedRelayError } from "../connection/errors.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "../connection/model.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";

export type RelayEnvironmentAvailability = "checking" | "online" | "offline" | "error";

export interface RelayDiscoveredEnvironment {
  readonly environment: RelayClientEnvironmentRecord;
  readonly availability: RelayEnvironmentAvailability;
  readonly status: Option.Option<RelayEnvironmentStatusResponse>;
  readonly error: Option.Option<ConnectionAttemptError>;
}

export interface RelayEnvironmentDiscoveryState {
  readonly environments: ReadonlyMap<string, RelayDiscoveredEnvironment>;
  readonly refreshing: boolean;
  readonly offline: boolean;
  readonly error: Option.Option<ConnectionAttemptError>;
}

const authenticatedSnapshotBrand: unique symbol = Symbol("authenticatedRelayEnvironmentSnapshot");

/** A linked-environment list tied to the authenticated Connect session that fetched it. */
export interface AuthenticatedRelayEnvironmentSnapshot {
  readonly [authenticatedSnapshotBrand]: true;
  readonly identity: ClientCapabilities.CloudSessionIdentity;
  readonly generation: number;
  readonly environments: ReadonlyMap<EnvironmentId, RelayClientEnvironmentRecord>;
  /** This closure is created by discovery and fences consumers against stale account state. */
  readonly isCurrent: () => Effect.Effect<boolean>;
}

export class RelayEnvironmentDiscovery extends Context.Service<
  RelayEnvironmentDiscovery,
  {
    readonly state: SubscriptionRef.SubscriptionRef<RelayEnvironmentDiscoveryState>;
    readonly authenticatedSnapshot?: SubscriptionRef.SubscriptionRef<
      Option.Option<AuthenticatedRelayEnvironmentSnapshot>
    >;
    readonly refresh: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/relay/discovery/RelayEnvironmentDiscovery") {}

export const EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE: RelayEnvironmentDiscoveryState = {
  environments: new Map(),
  refreshing: false,
  offline: false,
  error: Option.none(),
};

function validateStatus(
  environment: RelayClientEnvironmentRecord,
  status: RelayEnvironmentStatusResponse,
): Effect.Effect<RelayEnvironmentStatusResponse, ConnectionAttemptError> {
  if (status.environmentId !== environment.environmentId) {
    return Effect.fail(
      new ConnectionBlockedError({
        reason: "configuration",
        detail: "Relay returned status for a different environment.",
      }),
    );
  }
  if (
    status.endpoint.httpBaseUrl !== environment.endpoint.httpBaseUrl ||
    status.endpoint.wsBaseUrl !== environment.endpoint.wsBaseUrl ||
    status.endpoint.providerKind !== environment.endpoint.providerKind
  ) {
    return Effect.fail(
      new ConnectionBlockedError({
        reason: "configuration",
        detail: "Relay returned status for a different environment endpoint.",
      }),
    );
  }
  if (
    status.descriptor !== undefined &&
    status.descriptor.environmentId !== environment.environmentId
  ) {
    return Effect.fail(
      new ConnectionBlockedError({
        reason: "configuration",
        detail: "Relay returned a descriptor for a different environment.",
      }),
    );
  }
  return Effect.succeed(status);
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("RelayEnvironmentDiscovery.make")(function* () {
  const relay = yield* ManagedRelay.ManagedRelayClient;
  const session = yield* ClientCapabilities.CloudSession;
  const connectivity = yield* Connectivity.Connectivity;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const state = yield* SubscriptionRef.make(EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE);
  const authenticatedSnapshot = yield* SubscriptionRef.make<
    Option.Option<AuthenticatedRelayEnvironmentSnapshot>
  >(Option.none());
  const refreshLock = yield* Semaphore.make(1);
  const hasRefreshed = yield* Ref.make(false);
  const accountGeneration = yield* Ref.make(0);
  const snapshotGeneration = yield* Ref.make(0);
  const activeAccountId = yield* Ref.make<Option.Option<string>>(Option.none());
  const refreshGeneration = yield* Ref.make(0);
  const offlineReportFingerprints = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

  const isSnapshotCurrent = Effect.fn("RelayEnvironmentDiscovery.isSnapshotCurrent")(function* (
    identity: ClientCapabilities.CloudSessionIdentity,
    generation: number,
  ) {
    if ((yield* Ref.get(snapshotGeneration)) !== generation) return false;
    const currentIdentity = yield* session.identity;
    if (Option.isNone(currentIdentity) || currentIdentity.value.accountId !== identity.accountId) {
      return false;
    }
    return true;
  });

  const clearOfflineReport = Effect.fn("RelayEnvironmentDiscovery.clearOfflineReport")(function* (
    environmentId: string,
  ) {
    yield* Ref.update(offlineReportFingerprints, (current) => {
      if (!current.has(environmentId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(environmentId);
      return next;
    });
  });

  const updateEnvironment = Effect.fn("RelayEnvironmentDiscovery.updateEnvironment")(function* (
    generation: number,
    environmentId: string,
    update: (current: RelayDiscoveredEnvironment) => RelayDiscoveredEnvironment,
  ) {
    if ((yield* Ref.get(accountGeneration)) !== generation) {
      return;
    }
    yield* SubscriptionRef.update(state, (current) => {
      const entry = current.environments.get(environmentId);
      if (entry === undefined) {
        return current;
      }
      const environments = new Map(current.environments);
      environments.set(environmentId, update(entry));
      return { ...current, environments };
    });
  });

  const refreshStatus = Effect.fn("RelayEnvironmentDiscovery.refreshStatus")(function* (
    generation: number,
    clerkToken: string,
    environment: RelayClientEnvironmentRecord,
  ) {
    const result = yield* relay
      .getEnvironmentStatus({
        clerkToken,
        scopes: [RelayEnvironmentStatusScope, RelayEnvironmentConnectScope],
        environmentId: environment.environmentId,
      })
      .pipe(
        Effect.mapError(mapManagedRelayError),
        Effect.flatMap((status) => validateStatus(environment, status)),
        Effect.result,
      );

    if (result._tag === "Success") {
      if (result.success.status === "offline") {
        const fingerprint = `${result.success.endpoint.httpBaseUrl}\n${result.success.error ?? ""}`;
        const shouldReport = yield* Ref.modify(offlineReportFingerprints, (current) => {
          if (current.get(environment.environmentId) === fingerprint) {
            return [false, current];
          }
          return [true, new Map(current).set(environment.environmentId, fingerprint)];
        });
        if (shouldReport) {
          yield* Effect.logWarning("Relay environment health check reported offline", {
            environmentId: result.success.environmentId,
            endpoint: result.success.endpoint.httpBaseUrl,
            message: result.success.error,
            traceId: result.success.traceId,
          });
        }
      } else {
        yield* clearOfflineReport(environment.environmentId);
      }
      yield* updateEnvironment(generation, environment.environmentId, (current) => ({
        ...current,
        availability: result.success.status,
        status: Option.some(result.success),
        error: Option.none(),
      }));
      return;
    }

    yield* clearOfflineReport(environment.environmentId);
    yield* updateEnvironment(generation, environment.environmentId, (current) => ({
      ...current,
      availability: "error",
      error: Option.some(result.failure),
    }));
  });

  const refresh = refreshLock.withPermits(1)(
    Effect.gen(function* () {
      yield* Ref.set(hasRefreshed, true);
      if ((yield* connectivity.status) === "offline") {
        yield* SubscriptionRef.update(state, (current) => ({
          ...current,
          refreshing: false,
          offline: true,
        }));
        return;
      }

      let generation = yield* Ref.get(accountGeneration);
      yield* Ref.set(refreshGeneration, generation);
      yield* SubscriptionRef.set(state, {
        environments: new Map(),
        refreshing: true,
        offline: false,
        error: Option.none(),
      });

      // Signed out is the idle state, not a failure: the proactive refresh on
      // credentials-changed also runs on sign-out and must settle back to a
      // clean empty list. Only the session-level "no credentials" error is
      // benign — relay-side auth failures (expired/invalid tokens) happen
      // after this point and must surface as errors.
      const tokenResult = yield* Effect.result(session.clerkToken);
      if (tokenResult._tag === "Failure") {
        const failure = tokenResult.failure;
        if (failure._tag === "ConnectionBlockedError" && failure.reason === "authentication") {
          if ((yield* Ref.get(accountGeneration)) !== generation) {
            return;
          }
          yield* SubscriptionRef.set(authenticatedSnapshot, Option.none());
          yield* Ref.set(activeAccountId, Option.none());
          yield* SubscriptionRef.update(state, (current) => ({
            ...current,
            refreshing: false,
          }));
          return;
        }
        return yield* failure;
      }
      const clerkToken = tokenResult.success;
      if ((yield* Ref.get(accountGeneration)) !== generation) {
        return;
      }
      const sessionIdentity = yield* session.identity;
      if (Option.isNone(sessionIdentity)) {
        yield* SubscriptionRef.set(authenticatedSnapshot, Option.none());
        return yield* new ConnectionBlockedError({
          reason: "authentication",
          detail: "The T3 Connect session is unavailable.",
        });
      }
      const accountId = Option.some(sessionIdentity.value.accountId);
      const previousAccountId = yield* Ref.get(activeAccountId);
      if (
        Option.isSome(previousAccountId) &&
        (!Option.isSome(accountId) || previousAccountId.value !== accountId.value)
      ) {
        generation = yield* Ref.updateAndGet(accountGeneration, (current) => current + 1);
        yield* Ref.set(refreshGeneration, generation);
        yield* SubscriptionRef.set(authenticatedSnapshot, Option.none());
      }
      yield* Ref.set(activeAccountId, accountId);

      const environments = yield* relay
        .listEnvironments({ clerkToken })
        .pipe(Effect.mapError(mapManagedRelayError));
      const identityAfterListing = yield* session.identity;
      if (
        Option.isNone(identityAfterListing) ||
        identityAfterListing.value.accountId !== sessionIdentity.value.accountId
      ) {
        yield* Ref.update(accountGeneration, (current) => current + 1);
        yield* Ref.update(snapshotGeneration, (current) => current + 1);
        yield* SubscriptionRef.set(authenticatedSnapshot, Option.none());
        return;
      }
      if ((yield* Ref.get(accountGeneration)) !== generation) {
        return;
      }
      const linkedListGeneration = yield* Ref.updateAndGet(
        snapshotGeneration,
        (current) => current + 1,
      );
      const linkedEnvironments = new Map<EnvironmentId, RelayClientEnvironmentRecord>();
      for (const environment of environments) {
        linkedEnvironments.set(environment.environmentId, environment);
      }
      const snapshot = {
        [authenticatedSnapshotBrand]: true as const,
        identity: sessionIdentity.value,
        generation: linkedListGeneration,
        environments: linkedEnvironments,
      };
      yield* SubscriptionRef.set(
        authenticatedSnapshot,
        Option.some({
          ...snapshot,
          isCurrent: () => isSnapshotCurrent(snapshot.identity, snapshot.generation),
        }),
      );
      const next = new Map<string, RelayDiscoveredEnvironment>();
      for (const environment of environments) {
        next.set(environment.environmentId, {
          environment,
          availability: "checking",
          status: Option.none(),
          error: Option.none(),
        });
      }
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        environments: next,
      }));

      yield* Effect.forEach(
        environments,
        (environment) => refreshStatus(generation, clerkToken, environment),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
      if ((yield* Ref.get(accountGeneration)) !== generation) {
        return;
      }
      yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        refreshing: false,
      }));
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const generation = yield* Ref.get(refreshGeneration);
          if ((yield* Ref.get(accountGeneration)) !== generation) {
            return;
          }
          yield* SubscriptionRef.update(state, (current) => ({
            ...current,
            refreshing: false,
            error: Option.some(error),
          }));
        }),
      ),
    ),
  );

  yield* connectivity.changes.pipe(
    Stream.changes,
    Stream.runForEach((networkStatus) =>
      networkStatus === "offline"
        ? SubscriptionRef.update(state, (current) => ({
            ...current,
            refreshing: false,
            offline: true,
          }))
        : Ref.get(hasRefreshed).pipe(
            Effect.flatMap((shouldRefresh) => (shouldRefresh ? refresh : Effect.void)),
          ),
    ),
    Effect.forkScoped,
  );
  yield* wakeups.changes.pipe(
    Stream.runForEach((reason) =>
      reason === "credentials-changed"
        ? Effect.gen(function* () {
            yield* Ref.update(accountGeneration, (current) => current + 1);
            yield* Ref.update(snapshotGeneration, (current) => current + 1);
            const identity = yield* session.identity;
            const snapshot = yield* SubscriptionRef.get(authenticatedSnapshot);
            const identityChanged =
              Option.isNone(identity) ||
              (Option.isSome(snapshot) &&
                Option.isSome(identity) &&
                snapshot.value.identity.accountId !== identity.value.accountId);
            if (identityChanged) {
              yield* SubscriptionRef.set(authenticatedSnapshot, Option.none());
            }
            yield* Ref.set(
              activeAccountId,
              Option.map(identity, (current) => current.accountId),
            );
            yield* Ref.set(offlineReportFingerprints, new Map());
            yield* SubscriptionRef.set(state, EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE);
            // Refresh proactively — this wakeup fires when a session activates
            // (sign-in or cold start), and the list should be populated before
            // any screen asks for it. A signed-out refresh settles back to the
            // clean empty state.
            yield* refresh.pipe(Effect.forkScoped);
          })
        : Effect.void,
    ),
    Effect.forkScoped,
  );

  return RelayEnvironmentDiscovery.of({ state, authenticatedSnapshot, refresh });
});

export const layer = Layer.effect(RelayEnvironmentDiscovery, make());
