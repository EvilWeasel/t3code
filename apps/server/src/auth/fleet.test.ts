import { EnvironmentId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Fleet from "./fleet.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const id = EnvironmentId.make("env-fleet-test");
const entry = {
  environmentId: id,
  label: "Test peer",
  httpBaseUrl: "https://peer.example.test/",
  authoritySecretName: "fleet-authority-test",
  authorityExpiresAt: "2099-01-01T00:00:00Z",
  enabled: true,
  allowedScopes: ["orchestration:read", "orchestration:operate", "environment:maintain"],
};
const scopes = new Set<AuthEnvironmentScope>([
  "orchestration:read",
  "orchestration:operate",
  "environment:maintain",
  "access:write",
]);
const layer = (entries: unknown[]) =>
  Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (key) =>
      Effect.succeed(
        Option.some(
          new TextEncoder().encode(
            key === Fleet.FLEET_CONNECTIONS_SECRET
              ? JSON.stringify({ schemaVersion: 1, connections: entries })
              : "synthetic-private-authority",
          ),
        ),
      ),
    set: () => Effect.void,
    create: () => Effect.void,
    remove: () => Effect.void,
    getOrCreateRandom: () => Effect.die("unexpected random request"),
  });

it.effect(
  "lists enabled metadata without returning private authority and refuses unknown or disabled peers",
  () =>
    Effect.gen(function* () {
      const entries = yield* Fleet.readFleetConnections;
      expect(entries.map(Fleet.publicConnection)).toEqual([
        {
          environmentId: id,
          label: "Test peer",
          httpBaseUrl: "https://peer.example.test/",
          wsBaseUrl: "wss://peer.example.test/",
        },
      ]);
      const blocked = yield* Effect.flip(
        Fleet.issueFleetPairing(EnvironmentId.make("disabled"), scopes),
      );
      expect(blocked.reason).toBe("not-configured");
    }).pipe(
      Effect.provide(layer([entry, { ...entry, environmentId: "disabled", enabled: false }])),
    ),
);

it.effect(
  "pins the descriptor before delegating only the caller and configured standard scope intersection",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, ...(init ? { init } : {}) });
        return new Response(
          JSON.stringify(
            url.endsWith("/environment")
              ? { environmentId: id }
              : {
                  id: "synthetic-once",
                  credential: "synthetic-one-time-grant",
                  expiresAt: new Date(DateTime.toEpochMillis(now) + 300_000).toISOString(),
                },
          ),
          { status: 200 },
        );
      }) as typeof fetch;
      const result = yield* Fleet.issueFleetPairing(id, scopes, fetchFn);
      expect(result.credential).toBe("synthetic-one-time-grant");
      expect(JSON.stringify(result)).not.toContain("synthetic-private-authority");
      expect(calls.map((call) => call.url)).toEqual([
        "https://peer.example.test/.well-known/t3/environment",
        "https://peer.example.test/api/auth/pairing-token",
      ]);
      expect(JSON.parse(String(calls[1]?.init?.body)).scopes).toEqual([
        "orchestration:read",
        "orchestration:operate",
        "environment:maintain",
      ]);
      expect(calls.every((call) => call.init?.redirect === "error")).toBe(true);
    }).pipe(Effect.provide(layer([entry]))),
);

it.effect("never sends authority when the configured origin reports another environment", () =>
  Effect.gen(function* () {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ environmentId: "wrong" }));
    }) as typeof fetch;
    const result = yield* Effect.flip(Fleet.issueFleetPairing(id, scopes, fetchFn));
    expect(result.reason).toBe("identity-mismatch");
    expect(calls).toBe(1);
  }).pipe(Effect.provide(layer([entry]))),
);

it.effect("rejects insecure or duplicate configuration without echoing private input", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(Fleet.readFleetConnections);
    expect(error.reason).toBe("unavailable");
    expect(String(error)).not.toContain("synthetic-private-authority");
  }).pipe(Effect.provide(layer([{ ...entry, httpBaseUrl: "http://peer.example.test/" }]))),
);

it.effect("reports an expired authority without contacting the peer", () =>
  Effect.gen(function* () {
    const fetchFn = (() => {
      throw new Error("must not contact expired peer");
    }) as typeof fetch;
    const result = yield* Effect.flip(Fleet.issueFleetPairing(id, scopes, fetchFn));
    expect(result.reason).toBe("authority-expired");
  }).pipe(Effect.provide(layer([{ ...entry, authorityExpiresAt: "1970-01-01T00:00:00Z" }]))),
);
