import type { EnvironmentId } from "@t3tools/contracts";
import type * as Option from "effect/Option";
import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

export interface FleetConnectionRequest {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
}

export const requestFleetConnections = (input: FleetConnectionRequest) =>
  executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "auth",
    method: "GET",
    timeoutMs: 15_000,
    url: (urls) => urls.fleetConnections(),
    request: ({ client, headers }) => client.fleetConnections({ headers }),
  });

export const requestFleetPairingCredential = (
  input: FleetConnectionRequest & { readonly environmentId: EnvironmentId },
) =>
  executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "auth",
    method: "POST",
    timeoutMs: 15_000,
    url: (urls) => urls.fleetPairingCredential({ environmentId: input.environmentId }),
    request: ({ client, headers }) =>
      client.fleetPairingCredential({ params: { environmentId: input.environmentId }, headers }),
  });
