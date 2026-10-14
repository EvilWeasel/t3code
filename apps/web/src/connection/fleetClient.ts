import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import { AtomRegistry } from "effect/reactivity";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization/service";
import * as ManagedRelay from "@t3tools/client-runtime/relay/managed-relay";
import {
  requestFleetConnections,
  requestFleetPairingCredential,
} from "@t3tools/client-runtime/state/fleet-connections";
import { connectionAtomRuntime } from "./runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "../state/session";
class FleetUnavailable extends Data.TaggedError("FleetUnavailable")<{ readonly message: string }> {}
export async function readFleetConnections(environmentId: EnvironmentId) {
  const request = connectionAtomRuntime.fn<void>()((_input, get) =>
    Effect.gen(function* () {
      const prepared = get(environmentSession.preparedConnectionValueAtom(environmentId));
      if (Option.isNone(prepared))
        return yield* Effect.fail(new FleetUnavailable({ message: "Environment disconnected." }));
      const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
      const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
      return yield* requestFleetConnections({
        prepared: prepared.value,
        signer,
        remoteAuthorization,
      }).pipe(
        Effect.catch((error) =>
          error._tag === "EnvironmentResourceNotFoundError" ||
          (error._tag === "RemoteEnvironmentAuthUndeclaredStatusError" && error.status === 404)
            ? Effect.succeed({ connections: [] })
            : Effect.fail(error),
        ),
      );
    }).pipe(Effect.withTracerEnabled(false)),
  );
  appAtomRegistry.set(request, undefined);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, request, { suspendOnWaiting: true }),
  );
}
export async function createFleetPairing(environmentId: EnvironmentId, peerId: EnvironmentId) {
  const request = connectionAtomRuntime.fn<void>()((_input, get) =>
    Effect.gen(function* () {
      const prepared = get(environmentSession.preparedConnectionValueAtom(environmentId));
      if (Option.isNone(prepared))
        return yield* Effect.fail(new FleetUnavailable({ message: "Environment disconnected." }));
      const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
      const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
      return yield* requestFleetPairingCredential({
        prepared: prepared.value,
        signer,
        remoteAuthorization,
        environmentId: peerId,
      });
    }).pipe(Effect.withTracerEnabled(false)),
  );
  appAtomRegistry.set(request, undefined);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, request, { suspendOnWaiting: true }),
  );
}
