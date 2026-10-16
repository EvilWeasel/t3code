import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  OrchestrationV2ThreadTranscript,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as OrchestrationHttp from "./http.ts";

class TranscriptHttpTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const environmentId = EnvironmentId.make("environment:transcript-http:destination");
const threadId = ThreadId.make("thread:transcript-http:fixture");
const now = DateTime.makeUnsafe("2026-10-16T00:00:00.000Z");
const transcript = Schema.decodeUnknownSync(OrchestrationV2ThreadTranscript)({
  threadId,
  title: "Canonical destination transcript",
  updatedAt: now,
  items: [],
});
const decodeTranscript = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadTranscript)),
);
const decodeAuthError = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(EnvironmentAuthInvalidError)),
);
const decodeScopeError = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(EnvironmentScopeRequiredError)),
);
const decodeTranscriptFailure = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.toCodecJson(
      Schema.Union([
        EnvironmentRequestInvalidError,
        EnvironmentResourceNotFoundError,
        EnvironmentInternalError,
      ]),
    ),
  ),
);
type FixtureFailure = "too-large" | "missing" | "internal" | null;
const privateFailure = "SYNTHETIC_PRIVATE_STORAGE_DETAIL:/isolated/fixture-only";

// The real registered middleware, EnvironmentAuth and SessionStore run against ONE
// memory database and scoped temporary config/secret directory. No user credential
// or production environment is read. Only the downstream service is controlled.
const makeHttpFixture = (failure: FixtureFailure = null) =>
  Effect.gen(function* () {
    const requestClock = yield* Clock.Clock;
    const database = SqlitePersistence.layerMemory;
    const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-transcript-http-test-" });
    const identity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    });
    const secretStore = ServerSecretStore.layer.pipe(Layer.provide(config));
    const auth = EnvironmentAuth.layer.pipe(
      Layer.provideMerge(database),
      Layer.provide(secretStore),
      Layer.provide(identity),
      Layer.provide(config),
    );
    const calls: Array<{ threadId: ThreadId; environmentId: EnvironmentId }> = [];
    const getThreadTranscript: ThreadManagement.ThreadManagementServiceShape["getThreadTranscript"] =
      (requestedThreadId) =>
        Effect.gen(function* () {
          const destination = yield* ServerEnvironment.ServerEnvironmentIdentity;
          calls.push({
            threadId: requestedThreadId,
            environmentId: yield* destination.getEnvironmentId,
          });
          if (failure === "too-large")
            return yield* new ThreadManagement.ThreadTranscriptTooLargeError({
              threadId: requestedThreadId,
            });
          if (failure === "missing")
            return yield* new Orchestrator.OrchestratorProjectionError({
              threadId: requestedThreadId,
              cause: new ProjectionStore.ProjectionStoreThreadNotFoundError({
                threadId: requestedThreadId,
              }),
            });
          if (failure === "internal")
            return yield* new Orchestrator.OrchestratorProjectionError({
              threadId: requestedThreadId,
              cause: new Error(privateFailure),
            });
          return transcript;
        });
    const platform = HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    );
    const services = yield* Layer.build(
      Layer.mergeAll(
        auth,
        identity,
        database,
        Layer.mock(ThreadManagement.ThreadManagementService)({ getThreadTranscript }),
        Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
      ).pipe(Layer.provideMerge(platform)),
    );
    const authService = Context.get(services, EnvironmentAuth.EnvironmentAuth);
    const routes = HttpApiBuilder.layer(TranscriptHttpTestApi).pipe(
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
      Layer.provide(Layer.succeedContext(services)),
    );
    const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
    const read = (token?: string) =>
      Effect.promise(() =>
        web.handler(
          new Request(
            `http://127.0.0.1/api/orchestration/threads/${encodeURIComponent(threadId)}/transcript`,
            {
              headers: {
                [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
                "x-environment-id": "model-forged-environment",
                ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
              },
            },
          ),
          Context.make(Clock.Clock, requestClock),
        ),
      );
    return { auth: authService, calls, read };
  });

it.effect(
  "registered transcript auth denies absent, wrong-scope and revoked credentials BEFORE the service",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeHttpFixture();
      const absent = yield* fixture.read();
      expect(absent.status).toBe(401);
      expect(yield* decodeAuthError(yield* Effect.promise(() => absent.text()))).toMatchObject({
        code: "auth_invalid",
      });
      expect(fixture.calls).toEqual([]);
      const restricted = yield* fixture.auth.issueSession({
        scopes: [],
        label: "isolated-transcript-no-scope",
      });
      const denied = yield* fixture.read(restricted.token);
      expect(denied.status).toBe(403);
      expect(yield* decodeScopeError(yield* Effect.promise(() => denied.text()))).toMatchObject({
        code: "insufficient_scope",
        requiredScope: AuthOrchestrationReadScope,
      });
      expect(fixture.calls).toEqual([]);
      const allowed = yield* fixture.auth.issueSession({
        scopes: [AuthOrchestrationReadScope],
        label: "isolated-transcript-reader",
      });
      expect((yield* fixture.read(allowed.token)).status).toBe(200);
      expect(fixture.calls).toEqual([{ threadId, environmentId }]);
      yield* fixture.auth.revokeSession(allowed.sessionId);
      const revoked = yield* fixture.read(allowed.token);
      expect(revoked.status).toBe(401);
      expect(fixture.calls).toEqual([{ threadId, environmentId }]);
    }).pipe(Effect.scoped),
);

it.effect(
  "registered transcript GET uses captured destination identity and the canonical UTC wire codec",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeHttpFixture();
      const session = yield* fixture.auth.issueSession({
        scopes: [AuthOrchestrationReadScope],
        label: "isolated-transcript-reader",
      });
      const response = yield* fixture.read(session.token);
      expect(response.status).toBe(200);
      const body = yield* Effect.promise(() => response.text());
      const decoded = yield* decodeTranscript(body);
      expect(decoded).toEqual(transcript);
      expect(DateTime.isUtc(decoded.updatedAt)).toBe(true);
      expect(DateTime.formatIso(decoded.updatedAt)).toBe("2026-10-16T00:00:00.000Z");
      expect(fixture.calls).toEqual([{ threadId, environmentId }]);
      expect(body).not.toContain("model-forged-environment");
      expect(body).not.toContain("providerSessions");
      expect(body).not.toContain("authorization");
    }).pipe(Effect.scoped),
);

it.effect.each([
  {
    failure: "too-large" as const,
    status: 400,
    code: "invalid_request",
    reason: "thread_transcript_too_large",
  },
  { failure: "missing" as const, status: 404, code: "not_found", reason: "thread_not_found" },
  {
    failure: "internal" as const,
    status: 500,
    code: "internal_error",
    reason: "orchestration_thread_snapshot_failed",
  },
])("registered transcript errors are typed and bounded ($failure)", (expected) =>
  Effect.gen(function* () {
    const fixture = yield* makeHttpFixture(expected.failure);
    const session = yield* fixture.auth.issueSession({
      scopes: [AuthOrchestrationReadScope],
      label: "isolated-transcript-error-reader",
    });
    const response = yield* fixture.read(session.token);
    expect(response.status).toBe(expected.status);
    const body = yield* Effect.promise(() => response.text());
    expect(yield* decodeTranscriptFailure(body)).toMatchObject({
      code: expected.code,
      reason: expected.reason,
    });
    expect(fixture.calls).toEqual([{ threadId, environmentId }]);
    expect(body).not.toContain(privateFailure);
    expect(body).not.toContain("ProjectionStoreThreadNotFoundError");
    expect(body).not.toContain('"cause"');
    expect(body).not.toContain(session.token);
    expect(body.length).toBeLessThan(1_024);
  }).pipe(Effect.scoped),
);
