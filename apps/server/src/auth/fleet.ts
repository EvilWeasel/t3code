import {
  AuthPairingCredentialResult,
  AuthCreatePairingCredentialInput,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  type EnvironmentId,
  type FleetConnection,
  FleetPairingCredential,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServerSecretStore from "./ServerSecretStore.ts";

export const FLEET_CONNECTIONS_SECRET = "fleet-connections-v1";
const PrivateConnection = Schema.Struct({
  environmentId: Schema.String,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  authoritySecretName: Schema.String,
  authorityExpiresAt: Schema.DateTimeUtc,
  enabled: Schema.Boolean,
  allowedScopes: Schema.Array(Schema.String),
});
const PrivateCatalog = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  connections: Schema.Array(PrivateConnection),
});

export class FleetConnectionError extends Schema.TaggedError<FleetConnectionError>()(
  "FleetConnectionError",
  {
    reason: Schema.Literals([
      "not-configured",
      "unavailable",
      "authority-expired",
      "authority-rejected",
      "identity-mismatch",
    ]),
  },
) {}

const unavailable = () => new FleetConnectionError({ reason: "unavailable" });

export function publicConnection(entry: typeof PrivateConnection.Type): FleetConnection {
  const url = new URL(entry.httpBaseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !entry.environmentId.trim() ||
    !entry.label.trim()
  )
    throw unavailable();
  const ws = new URL(url);
  ws.protocol = "wss:";
  return {
    environmentId: entry.environmentId as EnvironmentId,
    label: entry.label,
    httpBaseUrl: url.toString(),
    wsBaseUrl: ws.toString(),
  };
}

export const readFleetConnections = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const value = yield* store.get(FLEET_CONNECTIONS_SECRET).pipe(Effect.mapError(unavailable));
  if (Option.isNone(value)) return [];
  const catalog = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(PrivateCatalog)),
  )(new TextDecoder().decode(value.value)).pipe(Effect.mapError(unavailable));
  return yield* Effect.try({
    try: () => {
      const ids = new Set<string>();
      for (const entry of catalog.connections) {
        publicConnection(entry);
        if (
          ids.has(entry.environmentId) ||
          !/^fleet-authority-[a-z0-9-]+$/.test(entry.authoritySecretName)
        ) {
          throw unavailable();
        }
        ids.add(entry.environmentId);
      }
      return catalog.connections.filter((entry) => entry.enabled);
    },
    catch: unavailable,
  });
});

export function delegatedFleetScopes(
  caller: ReadonlySet<AuthEnvironmentScope>,
  allowed: readonly string[],
) {
  return AuthStandardClientScopes.filter((scope) => caller.has(scope) && allowed.includes(scope));
}

/** The configured authority stays on this server. Only a fresh one-use grant leaves it. */
export const issueFleetPairing = Effect.fn("auth.issueFleetPairing")(function* (
  environmentId: EnvironmentId,
  callerScopes: ReadonlySet<AuthEnvironmentScope>,
  fetchFn: typeof fetch = fetch,
) {
  const entries = yield* readFleetConnections;
  const entry = entries.find((item) => item.environmentId === environmentId);
  if (!entry) return yield* new FleetConnectionError({ reason: "not-configured" });
  const connection = publicConnection(entry);
  const issuedAt = yield* DateTime.now;
  if (DateTime.toEpochMillis(entry.authorityExpiresAt) <= DateTime.toEpochMillis(issuedAt)) {
    return yield* new FleetConnectionError({ reason: "authority-expired" });
  }
  const scopes = delegatedFleetScopes(callerScopes, entry.allowedScopes);
  if (!scopes.includes("orchestration:read") || !scopes.includes("orchestration:operate")) {
    return yield* new FleetConnectionError({ reason: "not-configured" });
  }
  const store = yield* ServerSecretStore.ServerSecretStore;
  const authority = yield* store.get(entry.authoritySecretName).pipe(Effect.mapError(unavailable));
  if (Option.isNone(authority)) return yield* unavailable();
  const authorityToken = new TextDecoder().decode(authority.value).trim();
  if (!authorityToken) return yield* unavailable();
  const descriptorResponse = yield* Effect.tryPromise({
    try: () =>
      fetchFn(new URL("/.well-known/t3/environment", connection.httpBaseUrl), {
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      }),
    catch: unavailable,
  });
  if (!descriptorResponse.ok) return yield* unavailable();
  const descriptorText = yield* Effect.tryPromise({
    try: () => descriptorResponse.text(),
    catch: unavailable,
  });
  const descriptor = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Struct({ environmentId: Schema.String })),
  )(descriptorText).pipe(Effect.mapError(unavailable));
  if (descriptor.environmentId !== environmentId) {
    return yield* new FleetConnectionError({ reason: "identity-mismatch" });
  }
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(AuthCreatePairingCredentialInput))({
    label: "Morrowbyte fleet browser",
    scopes,
  }).pipe(Effect.mapError(unavailable));
  const response = yield* Effect.tryPromise({
    try: () =>
      fetchFn(new URL("/api/auth/pairing-token", connection.httpBaseUrl), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${authorityToken}`, "Content-Type": "application/json" },
        body,
      }),
    // Request errors can contain authority headers; never carry them into public/logged errors.
    catch: unavailable,
  });
  if (response.status === 401 || response.status === 403) {
    return yield* new FleetConnectionError({ reason: "authority-rejected" });
  }
  if (!response.ok) return yield* unavailable();
  const grantText = yield* Effect.tryPromise({ try: () => response.text(), catch: unavailable });
  const grant = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(AuthPairingCredentialResult)),
  )(grantText).pipe(Effect.mapError(unavailable));
  const now = yield* DateTime.now;
  const remaining = DateTime.toEpochMillis(grant.expiresAt) - DateTime.toEpochMillis(now);
  if (remaining <= 0 || remaining > 5 * 60_000 + 5000) return yield* unavailable();
  return {
    ...connection,
    credential: grant.credential,
    expiresAt: grant.expiresAt,
  } satisfies FleetPairingCredential;
});
