import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as VoiceService from "./VoiceTranscriptionService.ts";
import { makeVoiceSettings } from "./VoiceSettings.ts";

const recoveryNetwork = vi.hoisted(() => ({ calls: 0 }));
vi.mock("effect/http/FetchHttpClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect/http/FetchHttpClient")>();
  const Http = await import("effect/http/HttpClient");
  const Fx = await import("effect/Effect");
  const Layers = await import("effect/Layer");
  return {
    ...actual,
    layer: Layers.succeed(
      Http.HttpClient,
      Http.make(() =>
        Fx.sync(() => {
          recoveryNetwork.calls += 1;
        }).pipe(Fx.andThen(Fx.die("Unexpected provider HTTP call"))),
      ),
    ),
  };
});
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentAuthenticatedPrincipal,
  CodexSettings,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as PlatformError from "effect/PlatformError";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as CodexProvider from "../provider/CodexProvider.ts";

import {
  MAX_VOICE_AUDIO_BYTES,
  prepareCodexTranscriptionHome,
  VoiceTranscriptionError,
  createNoRedirectFetch,
  readTrustedAccountContext,
  safeProviderError,
  selectCodexTranscriptionInstance,
  liveCodexTranscriptionConfigs,
  transcribeCodexAccount,
  transcribeOpenAiApi,
  validateVoiceAudio,
} from "./VoiceTranscriptionService.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { requireEnvironmentScope } from "../auth/http.ts";

const routeContext = {
  account: { type: "chatgpt", id: "account-1" },
  workspaceRouting: {
    chatgptAccountId: "account-1",
    backendOrigin: "https://chatgpt.com/",
    accountRoutingOverride: "us",
  },
};

it("uses the registry's implicit default Codex when persisted providerInstances is empty", () => {
  const hydrated = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);
  const codexId = Schema.decodeSync(ProviderInstanceId)("codex");
  assert.strictEqual(hydrated[codexId]?.driver, "codex");
  const live = [{ instanceId: codexId, driverKind: hydrated[codexId]!.driver, enabled: true }];
  const selected = selectCodexTranscriptionInstance(
    liveCodexTranscriptionConfigs({}, live),
    undefined,
    undefined,
  );
  assert.strictEqual(selected?.[0], "codex");
  assert.strictEqual(
    Schema.decodeUnknownSync(CodexSettings)(selected?.[1].config ?? {}).binaryPath,
    "codex",
  );
  assert.isUndefined(
    selectCodexTranscriptionInstance(
      liveCodexTranscriptionConfigs({}, [{ ...live[0]!, enabled: false }]),
      undefined,
      undefined,
    ),
  );
});

const jwt = (userId: string, accountId = "account-1") => {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
        user_id: userId,
      },
    }),
  ).toString("base64url");
  return `e30.${payload}.signature`;
};

function mockCodex(input: {
  readonly users?: ReadonlyArray<string>;
  readonly accountIds?: ReadonlyArray<string>;
  readonly refreshArguments?: Array<boolean>;
}) {
  let authIndex = 0;
  const users = input.users ?? ["user-1"];
  const codex = {
    request: (_method: string, args: { readonly refreshToken?: boolean }) =>
      Effect.sync(() => {
        input.refreshArguments?.push(args.refreshToken ?? false);
        const index = Math.min(authIndex++, users.length - 1);
        return {
          authMethod: "chatgpt",
          authToken: jwt(users[index]!, input.accountIds?.[index]),
          requiresOpenaiAuth: false,
        };
      }),
    raw: {
      request: () => Effect.succeed(routeContext),
    },
  } as unknown as import("effect-codex-app-server/client").CodexAppServerClient["Service"];
  return codex;
}

it.effect("reads ChatGPT auth status and namespaced account claims from the trusted broker", () =>
  Effect.gen(function* () {
    const context = yield* readTrustedAccountContext(mockCodex({}), false);
    assert.strictEqual(context.userId, "user-1");
    assert.strictEqual(context.routing.chatgptAccountId, "account-1");
  }),
);

it.effect("does not accept an account id outside the trusted JWT namespace match", () =>
  Effect.gen(function* () {
    const result = yield* readTrustedAccountContext(
      mockCodex({ accountIds: ["wrong-account"] }),
      false,
    ).pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("sanitizes trusted broker failures before they can escape", () =>
  Effect.gen(function* () {
    const secret = "fakebrokersecret-for-voice-test";
    class BrokerFailure extends Data.TaggedError("BrokerFailure")<{ readonly message: string }> {}
    const codex = {
      request: () =>
        Effect.fail(new BrokerFailure({ message: `broker returned Bearer ${secret}` })),
      raw: { request: () => Effect.succeed(routeContext) },
    } as unknown as import("effect-codex-app-server/client").CodexAppServerClient["Service"];
    const result = yield* readTrustedAccountContext(codex, false).pipe(
      Effect.withTracerEnabled(false),
      Effect.result,
    );
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert(!JSON.stringify(result.failure).includes(secret));
      assert(!Object.keys(result.failure).includes("cause"));
    }
  }),
);

it.effect(
  "posts only the multipart file to the fixed account endpoint and accepts empty text",
  () =>
    Effect.gen(function* () {
      const codex = mockCodex({});
      let captured: HttpClientRequest.HttpClientRequest | undefined;
      const httpClient = {
        execute: (request: HttpClientRequest.HttpClientRequest) => {
          captured = request;
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ text: "" })));
        },
      } as unknown as HttpClient.HttpClient;
      const text = yield* transcribeCodexAccount(codex, httpClient, {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "audio/webm",
        fileName: "clip.webm",
      });
      assert.strictEqual(text, "");
      assert.strictEqual(captured?.url, "https://chatgpt.com/backend-api/transcribe");
      assert.strictEqual(captured?.headers["chatgpt-account-id"], "account-1");
      const form = (captured?.body as { readonly formData?: FormData } | undefined)?.formData;
      assert(form?.get("file") instanceof Blob);
      assert.strictEqual(form?.has("model"), false);
      assert.strictEqual(form?.has("prompt"), false);
    }),
);

it.effect("posts file and configured model through the explicit API-key adapter", () =>
  Effect.gen(function* () {
    let captured: HttpClientRequest.HttpClientRequest | undefined;
    const httpClient = {
      execute: (request: HttpClientRequest.HttpClientRequest) => {
        captured = request;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ text: "api transcript" })),
        );
      },
    } as unknown as HttpClient.HttpClient;
    const transcript = yield* transcribeOpenAiApi(
      httpClient,
      {
        bytes: new Uint8Array([4, 5]),
        contentType: "audio/ogg",
        fileName: "note.ogg",
      },
      "sk-dedicated-fake",
      "gpt-transcribe",
    );
    assert.strictEqual(transcript, "api transcript");
    assert.strictEqual(captured?.url, "https://api.openai.com/v1/audio/transcriptions");
    assert.strictEqual(captured?.headers.authorization, "Bearer sk-dedicated-fake");
    const form = (captured?.body as { readonly formData?: FormData } | undefined)?.formData;
    assert(form?.get("file") instanceof Blob);
    assert.strictEqual(form?.get("model"), "gpt-transcribe");
    assert.strictEqual(form?.has("prompt"), false);
  }),
);

it.effect("refreshes once after 401 and refuses a changed principal", () =>
  Effect.gen(function* () {
    const codex = mockCodex({ users: ["user-1", "user-2"] });
    let requests = 0;
    const httpClient = {
      execute: (request: HttpClientRequest.HttpClientRequest) => {
        requests++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            requests === 1
              ? new Response("unauthorized", { status: 401 })
              : Response.json({ text: "should not be accepted" }),
          ),
        );
      },
    } as unknown as HttpClient.HttpClient;
    const result = yield* transcribeCodexAccount(codex, httpClient, {
      bytes: new Uint8Array([1]),
      contentType: "audio/webm",
      fileName: "a.webm",
    }).pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(requests, 1);
  }),
);

it.effect(
  "retries once after 401 when the refreshed token still belongs to the same principal",
  () =>
    Effect.gen(function* () {
      const refreshArguments: boolean[] = [];
      const codex = mockCodex({ users: ["user-1", "user-1", "user-1"], refreshArguments });
      let requests = 0;
      const httpClient = {
        execute: (request: HttpClientRequest.HttpClientRequest) => {
          requests++;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              requests === 1
                ? new Response("unauthorized", { status: 401 })
                : Response.json({ text: "recovered" }),
            ),
          );
        },
      } as unknown as HttpClient.HttpClient;
      const result = yield* transcribeCodexAccount(codex, httpClient, {
        bytes: new Uint8Array([1]),
        contentType: "audio/webm",
        fileName: "a.webm",
      });
      assert.strictEqual(result, "recovered");
      assert.strictEqual(requests, 2);
      assert.deepStrictEqual(refreshArguments, [false, true, false]);
    }),
);

it.effect("passes an explicit environment to Codex spawn without extending ambient API keys", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const suffix = yield* crypto.randomUUIDv4;
    const root = `/tmp/t3-voice-transcription-${suffix}`;
    const sharedHome = `${root}/shared`;
    const shadowHome = `${root}/shadow`;
    const settings = yield* Schema.decodeUnknownEffect(CodexSettings)({
      binaryPath: "/usr/bin/env",
      homePath: sharedHome,
      shadowHomePath: shadowHome,
    });
    const effectiveHomePath = yield* prepareCodexTranscriptionHome(settings);
    assert.strictEqual(effectiveHomePath, shadowHome);
    let spawnCommand: unknown;
    const failedSpawn = PlatformError.badArgument({
      module: "ChildProcessSpawner",
      method: "spawn",
      description: "captured spawn command",
    });
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnCommand = command;
      }).pipe(Effect.andThen(Effect.fail(failedSpawn))),
    );
    const exit = yield* CodexProvider.withCodexAppServerClient({
      binaryPath: settings.binaryPath ?? "/usr/bin/env",
      homePath: effectiveHomePath,
      cwd: process.cwd(),
      environment: { PATH: process.env.PATH },
      extendEnv: false,
    }).pipe(
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.exit,
    );
    assert.strictEqual(exit._tag, "Failure");
    const captured = spawnCommand as
      | {
          readonly options?: { readonly env?: NodeJS.ProcessEnv; readonly extendEnv?: boolean };
        }
      | undefined;
    assert.strictEqual(captured?.options?.extendEnv, false);
    assert.strictEqual(captured?.options?.env?.OPENAI_API_KEY, undefined);
    assert.strictEqual(captured?.options?.env?.T3CODE_TRANSCRIPTION_API_KEY, undefined);
    assert.strictEqual(captured?.options?.env?.CODEX_HOME, shadowHome);
    yield* fileSystem.remove(root, { recursive: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports upstream 403 without retaining the raw response or request", () =>
  Effect.gen(function* () {
    const secret = "sk-fake-voice-secret";
    const refreshArguments: boolean[] = [];
    const codex = mockCodex({ refreshArguments });
    let requests = 0;
    const httpClient = {
      execute: (request: HttpClientRequest.HttpClientRequest) => {
        requests++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(`forbidden Bearer ${secret}`, { status: 403 }),
          ),
        );
      },
    } as unknown as HttpClient.HttpClient;
    const result = yield* transcribeCodexAccount(codex, httpClient, {
      bytes: new Uint8Array([1]),
      contentType: "audio/webm",
      fileName: "a.webm",
    }).pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert(result.failure instanceof VoiceTranscriptionError);
      assert.strictEqual(result.failure.status, 403);
      assert.strictEqual(result.failure.reason, "upstream_forbidden");
      assert.include(result.failure.detail, "does not confirm transcription access");
      assert(!JSON.stringify(result.failure).includes(secret));
    }
    assert.strictEqual(requests, 1);
    assert.deepStrictEqual(refreshArguments, [false]);
  }),
);

it.effect("cancels a stalled account request when the service timeout expires", () =>
  Effect.gen(function* () {
    let canceled = false;
    const codex = mockCodex({});
    const httpClient = {
      execute: () =>
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (canceled = true)))),
    } as unknown as HttpClient.HttpClient;
    const fiber = yield* transcribeCodexAccount(codex, httpClient, {
      bytes: new Uint8Array([1]),
      contentType: "audio/webm",
      fileName: "stall.webm",
    }).pipe(Effect.timeout("1 second"), Effect.mapError(safeProviderError), Effect.forkScoped);
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(fiber).pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.strictEqual(result.failure.reason, "timeout");
    assert.strictEqual(canceled, true);
  }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
);

it("redacts secrets and outbound request details from errors", () => {
  const secret = "sk-fake-voice-secret";
  const safe = safeProviderError(new Error(`Authorization: Bearer ${secret}`));
  assert(!safe.message.includes(secret));
  assert(!JSON.stringify(safe).includes(secret));
  assert(!Object.keys(safe).includes("cause"));
  assert.strictEqual(MAX_VOICE_AUDIO_BYTES, 25 * 1024 * 1024);
  assert.strictEqual(safeProviderError({ _tag: "TimeoutException" }).reason, "timeout");
});

it("selects only enabled Codex instances with explicit override precedence", () => {
  const entries = {
    codex: { driver: "codex", enabled: true },
    codex_work: { driver: "codex", enabled: true },
    disabled: { driver: "codex", enabled: false },
    claude: { driver: "claude", enabled: true },
  };
  assert.strictEqual(selectCodexTranscriptionInstance(entries, "claude", undefined)?.[0], "codex");
  assert.strictEqual(
    selectCodexTranscriptionInstance(entries, "codex_work", undefined)?.[0],
    "codex_work",
  );
  assert.strictEqual(selectCodexTranscriptionInstance(entries, undefined, "missing"), undefined);
  assert.strictEqual(
    selectCodexTranscriptionInstance(
      {
        codex_z: { driver: "codex", enabled: true },
        codex_a: { driver: "codex", enabled: true },
      },
      undefined,
      undefined,
    )?.[0],
    "codex_a",
  );
});

it.effect("rejects audio above the service byte bound", () =>
  Effect.gen(function* () {
    const result = yield* validateVoiceAudio({
      bytes: new Uint8Array(MAX_VOICE_AUDIO_BYTES + 1),
      contentType: "audio/webm",
      fileName: "oversize.webm",
    }).pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("denies the route operation without the transcription scope", () =>
  Effect.gen(function* () {
    const result = yield* requireEnvironmentScope(AuthOrchestrationOperateScope).pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("voice-test-session"),
        subject: "voice-test",
        method: "bearer-access-token",
        scopes: new Set([AuthOrchestrationReadScope]),
      }),
      Effect.result,
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("forces redirect rejection for provider HTTP requests", () =>
  Effect.gen(function* () {
    let redirect: RequestInit["redirect"] | undefined;
    const fetch = createNoRedirectFetch(((
      input: Parameters<typeof globalThis.fetch>[0],
      init?: RequestInit,
    ) => {
      redirect = init?.redirect;
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof globalThis.fetch);
    yield* Effect.promise(() => fetch("https://example.test", { redirect: "follow" }));
    assert.strictEqual(redirect, "error");
  }),
);

function recoveryServiceLayer(calls: { spawns: number }) {
  const unexpected = Effect.die("Unexpected provider runtime access");
  return VoiceService.layer.pipe(
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: () => Effect.succeed(undefined),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: unexpected,
      }),
    ),
    Layer.provide(
      Layer.succeed(CodexInstallation.CodexInstallation, {
        managedDirectory: "/fixture-unused-managed-runtime",
        resolve: () => unexpected,
        acquire: () => unexpected,
        start: unexpected,
        cancel: () => unexpected,
        state: unexpected,
        changes: Stream.empty,
        remove: () => unexpected,
      }),
    ),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: unexpected,
      }),
    ),
    Layer.provide(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            calls.spawns += 1;
          }).pipe(Effect.andThen(unexpected)),
        ),
      ),
    ),
    Layer.provideMerge(
      ServerSecretStore.layer.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "voice-service-recovery-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
}

it.effect(
  "returns actionable settings for missing, tampered and legacy keys while transcription stays fail closed",
  () => {
    const calls = { spawns: 0 };
    return Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env.T3CODE_TRANSCRIPTION_API_KEY;
          process.env.T3CODE_TRANSCRIPTION_API_KEY =
            "fixture-environment-fallback-must-not-be-used";
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.T3CODE_TRANSCRIPTION_API_KEY;
            else process.env.T3CODE_TRANSCRIPTION_API_KEY = previous;
          }),
      );
      const service = yield* VoiceService.VoiceTranscriptionService;
      const preferences = yield* makeVoiceSettings;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const settings = {
        provider: "openai-api" as const,
        instanceId: "retained-instance",
        model: "retained-model",
      };
      const networkBefore = recoveryNetwork.calls;
      for (const corruption of ["missing-wrapping-key", "tampered", "legacy"] as const) {
        yield* preferences.write({ ...settings, apiKey: "fixture-private-api-key" });
        const saved = yield* secrets.get("voice-transcription-api-key");
        assert(Option.isSome(saved));
        if (Option.isNone(saved)) return;
        if (corruption === "missing-wrapping-key")
          yield* secrets.remove("voice-transcription-wrapping-key");
        else {
          const invalid =
            corruption === "legacy"
              ? new TextEncoder().encode("fixture-opaque-legacy-key")
              : Uint8Array.from(saved.value);
          if (corruption === "tampered") invalid[invalid.length - 1]! ^= 1;
          yield* secrets.set("voice-transcription-api-key", invalid);
        }
        const original = yield* secrets.get("voice-transcription-api-key");
        const wrapping = yield* secrets.get("voice-transcription-wrapping-key");
        const metadata = yield* service.getSettings;
        assert.equal(metadata.provider, settings.provider);
        assert.equal(metadata.instanceId, settings.instanceId);
        assert.equal(metadata.model, settings.model);
        assert.isFalse(metadata.available);
        assert.isFalse(metadata.apiKeyConfigured);
        assert.equal(metadata.apiKeySource, "saved");
        assert.isTrue(metadata.supportsEncryptedApiKeyStorage);
        assert.include(metadata.message ?? "", "Save the key again on this environment");
        assert.isFalse(JSON.stringify(metadata).includes("fixture-private-api-key"));
        const denied = yield* service
          .transcribe({
            bytes: new Uint8Array([1]),
            contentType: "audio/wav",
            fileName: "fixture.wav",
          })
          .pipe(Effect.result);
        assert.equal(denied._tag, "Failure");
        if (denied._tag === "Failure") {
          assert.equal(denied.failure.reason, "provider_unavailable");
          assert.equal(denied.failure.detail, "Transcription settings could not be read.");
        }
        assert.deepEqual(yield* secrets.get("voice-transcription-api-key"), original);
        assert.deepEqual(yield* secrets.get("voice-transcription-wrapping-key"), wrapping);
      }
      assert.equal(recoveryNetwork.calls, networkBefore);
      assert.equal(calls.spawns, 0);
      yield* preferences.write({ ...settings, apiKey: "fixture-explicitly-replaced-key" });
      const restored = yield* service.getSettings;
      assert.isTrue(restored.available);
      assert.isTrue(restored.apiKeyConfigured);
      assert.equal(restored.apiKeySource, "saved");
      assert.notInclude(restored.message ?? "", "cannot be read");
    }).pipe(Effect.provide(recoveryServiceLayer(calls)), Effect.scoped);
  },
);

it.effect("does not present unrelated preference read failures as credential recovery", () => {
  const calls = { spawns: 0 };
  return Effect.gen(function* () {
    const service = yield* VoiceService.VoiceTranscriptionService;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filename = path.join(config.stateDir, "voice-transcription.json");
    const networkBefore = recoveryNetwork.calls;
    const privateSource = "fixture-private-config-content";
    yield* fs.writeFileString(filename, `{invalid-json:${privateSource}`);
    const invalidJson = yield* service.getSettings.pipe(Effect.result);
    assert.equal(invalidJson._tag, "Failure");
    if (invalidJson._tag === "Failure") {
      assert.instanceOf(invalidJson.failure, VoiceTranscriptionError);
      assert.equal(invalidJson.failure.reason, "provider_unavailable");
      assert.equal(invalidJson.failure.detail, "Transcription settings could not be read.");
      assert.notInclude(JSON.stringify(invalidJson.failure), privateSource);
      assert.notInclude(JSON.stringify(invalidJson.failure), filename);
    }
    yield* fs.remove(filename);
    yield* fs.makeDirectory(filename);
    const invalidFile = yield* service.getSettings.pipe(Effect.result);
    assert.equal(invalidFile._tag, "Failure");
    if (invalidFile._tag === "Failure") {
      assert.instanceOf(invalidFile.failure, VoiceTranscriptionError);
      assert.equal(invalidFile.failure.reason, "provider_unavailable");
      assert.equal(invalidFile.failure.detail, "Transcription settings could not be read.");
      assert.notInclude(JSON.stringify(invalidFile.failure), filename);
    }
    assert.equal(calls.spawns, 0);
    assert.equal(recoveryNetwork.calls, networkBefore);
  }).pipe(Effect.provide(recoveryServiceLayer(calls)), Effect.scoped);
});
