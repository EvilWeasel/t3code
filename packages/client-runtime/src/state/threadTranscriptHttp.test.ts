import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as Authorization from "../authorization/service.ts";
import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as Supervisor from "../connection/supervisor.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import type * as RpcSession from "../rpc/session.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import * as RpcHttp from "../rpc/http.ts";
import { createOrchestrationEnvironmentAtoms } from "./orchestration.ts";
import { fetchEnvironmentThreadTranscript } from "./threadTranscriptHttp.ts";

const environmentId = EnvironmentId.make("environment:transcript-client");
const threadId = ThreadId.make("thread:space /?日本語");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Destination",
  httpBaseUrl: "https://destination.example.test/base",
  wsBaseUrl: "wss://destination.example.test",
});
const prepared: PreparedConnection = {
  environmentId,
  label: target.label,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: target.wsBaseUrl,
  httpAuthorization: null,
  target,
};
const wire = {
  threadId,
  title: "Transcript fixture",
  updatedAt: "2026-10-16T00:00:00.000Z",
  items: [],
};
const path = `/api/orchestration/threads/${encodeURIComponent(threadId)}/transcript`;

const makeCommandHarness = (fetchFn: typeof fetch) =>
  Effect.gen(function* () {
    const current = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
    const supervisor = Supervisor.EnvironmentSupervisor.of({
      target,
      prepared: current,
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session: yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(Option.none()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const destinations: EnvironmentId[] = [];
    const registryLayer = Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
      run: (destination, effect) => {
        destinations.push(destination);
        return Effect.provideService(effect, Supervisor.EnvironmentSupervisor, supervisor);
      },
    });
    const runtime = Atom.runtime(
      Layer.mergeAll(registryLayer, RpcHttp.layerRemoteHttpClient(fetchFn)),
    );
    const atoms = createOrchestrationEnvironmentAtoms(runtime);
    const registry = AtomRegistry.make();
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    const read = () =>
      Effect.promise(() =>
        atoms.threadTranscript.run(registry, { environmentId, input: { threadId } }),
      );
    return { current, destinations, read };
  });

it.effect(
  "command reads the current prepared destination and refuses unavailable state without HTTP",
  () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const fetchFn = ((request, init) => {
        calls.push([request, init ?? {}]);
        return Promise.resolve(Response.json(wire));
      }) satisfies typeof fetch;
      const harness = yield* makeCommandHarness(fetchFn);
      const unavailable = yield* harness.read();
      expect(unavailable._tag).toBe("Failure");
      if (unavailable._tag !== "Failure") throw new Error("Expected unavailable command");
      expect(Cause.squash(unavailable.cause)).toBeInstanceOf(EnvironmentRpcUnavailableError);
      expect(calls).toEqual([]);
      yield* SubscriptionRef.set(harness.current, Option.some(prepared));
      const first = yield* harness.read();
      expect(first._tag).toBe("Success");
      if (first._tag !== "Success") throw new Error("Expected transcript command success");
      expect(first.value.title).toBe(wire.title);
      expect(DateTime.isUtc(first.value.updatedAt)).toBe(true);
      expect(DateTime.formatIso(first.value.updatedAt)).toBe(wire.updatedAt);
      const call = calls[0];
      if (call === undefined) throw new Error("Expected destination HTTP request");
      expect(String(call[0])).toBe(`https://destination.example.test${path}`);
      expect(call[1].method).toBe("GET");
      expect(call[1].credentials).toBe("include");
      expect(new Headers(call[1].headers).get(ORCHESTRATION_PROTOCOL_HEADER)).toBe(
        ORCHESTRATION_PROTOCOL_VERSION_TEXT,
      );
      yield* SubscriptionRef.set(
        harness.current,
        Option.some({
          ...prepared,
          httpBaseUrl: "https://replacement.example.test",
          httpAuthorization: { _tag: "Bearer", token: "synthetic-current-token" },
        }),
      );
      const second = yield* harness.read();
      expect(second._tag).toBe("Success");
      const replacement = calls[1];
      if (replacement === undefined) throw new Error("Expected current replacement request");
      expect(String(replacement[0])).toBe(`https://replacement.example.test${path}`);
      expect(new Headers(replacement[1].headers).get("authorization")).toBe(
        "Bearer synthetic-current-token",
      );
      expect(replacement[1].credentials).not.toBe("include");
      yield* SubscriptionRef.set(
        harness.current,
        Option.some({ ...prepared, environmentId: EnvironmentId.make("foreign-environment") }),
      );
      expect((yield* harness.read())._tag).toBe("Failure");
      expect(calls).toHaveLength(2);
      yield* SubscriptionRef.set(
        harness.current,
        Option.some({
          ...prepared,
          target: new RelayConnectionTarget({
            environmentId: EnvironmentId.make("foreign-target"),
            label: "Foreign",
          }),
        }),
      );
      expect((yield* harness.read())._tag).toBe("Failure");
      expect(calls).toHaveLength(2);
      yield* SubscriptionRef.set(harness.current, Option.none());
      expect((yield* harness.read())._tag).toBe("Failure");
      expect(calls).toHaveLength(2);
      expect(harness.destinations).toEqual(Array.from({ length: 6 }, () => environmentId));
    }).pipe(Effect.scoped),
);

it.effect(
  "DPoP resolves exact environment authorization and signs the contract-encoded GET URL",
  () =>
    Effect.gen(function* () {
      const requests: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const authorizationInputs: Array<{
        readonly expectedEnvironmentId: EnvironmentId;
        readonly rejectedAccessToken?: string;
      }> = [];
      const proofs: ManagedRelay.ManagedRelayDpopProofInput[] = [];
      const remote = Authorization.RemoteEnvironmentAuthorization.of({
        authorizeBearer: () => Effect.die("unused authorizeBearer"),
        authorizeDpop: () => Effect.die("unused authorizeDpop"),
        authorizeDpopHttp: (input) => {
          authorizationInputs.push(input);
          return Effect.succeed({
            environmentId,
            label: "Destination",
            httpBaseUrl: "https://current-relay.example.test",
            httpAuthorization: {
              _tag: "Dpop",
              accessToken: "synthetic-fresh-token",
              expiresAtEpochMs: 4102444800000,
            },
          });
        },
      });
      const signer = ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("synthetic-thumbprint"),
        createProof: (input) => {
          proofs.push(input);
          return Effect.succeed("synthetic-proof");
        },
      });
      const fetchFn = ((request, init) => {
        requests.push([request, init ?? {}]);
        return Promise.resolve(Response.json(wire));
      }) satisfies typeof fetch;
      const result = yield* fetchEnvironmentThreadTranscript({
        prepared: {
          ...prepared,
          target: new RelayConnectionTarget({ environmentId, label: "Destination" }),
          httpAuthorization: {
            _tag: "Dpop",
            accessToken: "synthetic-old-token",
            expiresAtEpochMs: 0,
          },
        },
        threadId,
        signer: Option.some(signer),
        remoteAuthorization: Option.some(remote),
      }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)));
      expect(result.threadId).toBe(threadId);
      expect(authorizationInputs).toEqual([{ expectedEnvironmentId: environmentId }]);
      expect(proofs).toEqual([
        {
          method: "GET",
          url: `https://current-relay.example.test${path}`,
          accessToken: "synthetic-fresh-token",
        },
      ]);
      const request = requests[0];
      if (request === undefined) throw new Error("Expected signed request");
      expect(requests).toHaveLength(1);
      expect(String(request[0])).toBe(proofs[0]?.url);
      expect(request[1].method).toBe("GET");
      const headers = new Headers(request[1].headers);
      expect(headers.get("authorization")).toBe("DPoP synthetic-fresh-token");
      expect(headers.get("dpop")).toBe("synthetic-proof");
      expect(headers.get(ORCHESTRATION_PROTOCOL_HEADER)).toBe(ORCHESTRATION_PROTOCOL_VERSION_TEXT);
      expect(request[1].credentials).not.toBe("include");
    }),
);

it.effect.each([
  {
    status: 400,
    body: {
      _tag: "EnvironmentRequestInvalidError",
      code: "invalid_request",
      reason: "thread_transcript_too_large",
      traceId: "synthetic-trace",
    },
  },
  {
    status: 404,
    body: {
      _tag: "EnvironmentResourceNotFoundError",
      code: "not_found",
      reason: "thread_not_found",
      traceId: "synthetic-trace",
    },
  },
  {
    status: 500,
    body: {
      _tag: "EnvironmentInternalError",
      code: "internal_error",
      reason: "orchestration_thread_snapshot_failed",
      traceId: "synthetic-trace",
    },
  },
])(
  "preserves the typed $status transcript error without exposing authorization",
  ({ status, body }) =>
    Effect.gen(function* () {
      let requests = 0;
      const fetchFn = (() => {
        requests += 1;
        return Promise.resolve(Response.json(body, { status }));
      }) satisfies typeof fetch;
      const error = yield* fetchEnvironmentThreadTranscript({
        prepared: {
          ...prepared,
          httpAuthorization: { _tag: "Bearer", token: "synthetic-private-token" },
        },
        threadId,
        signer: Option.none(),
      }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)), Effect.flip);
      expect(error).toMatchObject(body);
      expect(error.message).not.toContain("synthetic-private-token");
      expect(requests).toBe(1);
    }),
);

it.effect("rejects malformed transcript wire data through the canonical typed client", () =>
  Effect.gen(function* () {
    const fetchFn = (() =>
      Promise.resolve(
        Response.json({ ...wire, updatedAt: "not-a-UTC-date" }),
      )) satisfies typeof fetch;
    const error = yield* fetchEnvironmentThreadTranscript({
      prepared,
      threadId,
      signer: Option.none(),
    }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)), Effect.flip);
    expect(error).toBeInstanceOf(RpcHttp.RemoteEnvironmentAuthInvalidJsonError);
  }),
);
