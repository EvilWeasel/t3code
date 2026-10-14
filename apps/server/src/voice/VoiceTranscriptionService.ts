import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { decodeJwt } from "jose";
import {
  CodexSettings,
  VoiceTranscriptionSettings,
  VoiceTranscriptionSettingsInput,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexProvider from "../provider/CodexProvider.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { makeCodexManagedRuntime } from "../provider/CodexManagedRuntime.ts";
import { makeVoiceSettings } from "./VoiceSettings.ts";
import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "../provider/Drivers/CodexHomeLayout.ts";

export class VoiceTranscriptionError extends Data.TaggedError("VoiceTranscriptionError")<{
  readonly reason:
    | "audio_too_large"
    | "auth_required"
    | "invalid_routing"
    | "provider_unavailable"
    | "upstream_unauthorized"
    | "upstream_forbidden"
    | "upstream_failure"
    | "invalid_response"
    | "timeout";
  readonly detail: string;
  readonly status?: number;
}> {}

export const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;
export const VOICE_TRANSCRIPTION_TIMEOUT = "60 seconds" as const;

export const validateVoiceAudio = (audio: VoiceAudio) =>
  audio.bytes.byteLength <= MAX_VOICE_AUDIO_BYTES
    ? Effect.void
    : Effect.fail(
        new VoiceTranscriptionError({
          reason: "audio_too_large",
          detail: "Audio upload exceeds the 25 MiB limit.",
        }),
      );

// The upstream account endpoint may redirect through a login page; following
// that redirect would send a bearer credential to a different origin.
// @effect-diagnostics globalFetch:off
export const createNoRedirectFetch =
  (fetch: typeof globalThis.fetch): typeof globalThis.fetch =>
  (input, init) =>
    fetch(input, { ...init, redirect: "error" });
const fetchWithoutRedirects = createNoRedirectFetch(globalThis.fetch);

export function safeProviderError(cause: unknown): VoiceTranscriptionError {
  const status = HttpClientError.isHttpClientError(cause) ? cause.response?.status : undefined;
  const isTimeout =
    cause instanceof Error && (cause.name === "TimeoutException" || cause.name === "TimeoutError")
      ? true
      : typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        (cause._tag === "TimeoutException" || cause._tag === "TimeoutError");
  const reason = isTimeout
    ? "timeout"
    : status === 401
      ? "upstream_unauthorized"
      : status === 403
        ? "upstream_forbidden"
        : status !== undefined && status >= 500
          ? "provider_unavailable"
          : "upstream_failure";
  return new VoiceTranscriptionError({
    reason,
    detail:
      reason === "timeout"
        ? "Transcription provider request timed out."
        : status === undefined
          ? "Transcription provider request failed."
          : `Transcription provider returned HTTP ${status}.`,
    ...(status === undefined ? {} : { status }),
  });
}

const Routing = Schema.Struct({
  chatgptAccountId: Schema.String,
  backendOrigin: Schema.String,
  accountRoutingOverride: Schema.Literals(["NO_CONSTRAINT", "us", "us_cr"]),
});
const RawAccountRead = Schema.Struct({
  account: Schema.NullOr(
    Schema.Struct({
      type: Schema.Literal("chatgpt"),
      id: Schema.optionalKey(Schema.String),
    }),
  ),
  workspaceRouting: Routing,
});

type RoutingContext = typeof Routing.Type;
export const readTrustedAccountContext = Effect.fn("voice.readTrustedAccountContext")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  refreshToken: boolean,
) {
  const auth = yield* client.request("getAuthStatus", { includeToken: true, refreshToken }).pipe(
    Effect.mapError(
      () =>
        new VoiceTranscriptionError({
          reason: "auth_required",
          detail: "Codex account authorization could not be read.",
        }),
    ),
  );
  if (!auth.authToken || auth.authMethod !== "chatgpt") {
    return yield* Effect.fail(
      new VoiceTranscriptionError({
        reason: "auth_required",
        detail: "Codex is not signed in with a ChatGPT account.",
      }),
    );
  }
  const account = yield* client.raw.request("account/read", {}).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(RawAccountRead)),
    Effect.mapError(
      () =>
        new VoiceTranscriptionError({
          reason: "invalid_routing",
          detail: "Codex did not provide trusted workspace routing.",
        }),
    ),
  );
  if (!account.account || account.account.type !== "chatgpt") {
    return yield* Effect.fail(
      new VoiceTranscriptionError({
        reason: "auth_required",
        detail: "Codex is not signed in with a ChatGPT account.",
      }),
    );
  }
  if (
    account.account.id !== undefined &&
    account.account.id !== account.workspaceRouting.chatgptAccountId
  ) {
    return yield* Effect.fail(
      new VoiceTranscriptionError({
        reason: "invalid_routing",
        detail: "Codex account does not match workspace routing.",
      }),
    );
  }
  const claims = yield* Effect.try({
    try: () => decodeJwt(auth.authToken!),
    catch: () =>
      new VoiceTranscriptionError({
        reason: "auth_required",
        detail: "Codex account identity could not be verified.",
      }),
  });
  const authClaims = claims["https://api.openai.com/auth"];
  if (!authClaims || typeof authClaims !== "object") {
    return yield* Effect.fail(
      new VoiceTranscriptionError({
        reason: "auth_required",
        detail: "Codex account identity could not be verified.",
      }),
    );
  }
  const claimsRecord = authClaims as Record<string, unknown>;
  const claimAccountId = claimsRecord.chatgpt_account_id ?? claimsRecord.account_id;
  const claimUserId = claimsRecord.user_id ?? claimsRecord.chatgpt_user_id;
  if (
    typeof claimAccountId !== "string" ||
    claimAccountId !== account.workspaceRouting.chatgptAccountId ||
    typeof claimUserId !== "string"
  ) {
    return yield* Effect.fail(
      new VoiceTranscriptionError({
        reason: "invalid_routing",
        detail: "Codex account identity does not match workspace routing.",
      }),
    );
  }
  return { token: auth.authToken, routing: account.workspaceRouting, userId: claimUserId };
});

export const prepareCodexTranscriptionHome = Effect.fn("voice.prepareCodexTranscriptionHome")(
  function* (config: typeof CodexSettings.Type) {
    const layout = yield* resolveCodexHomeLayout(config);
    yield* materializeCodexShadowHome(layout).pipe(
      Effect.mapError(
        () =>
          new VoiceTranscriptionError({
            reason: "provider_unavailable",
            detail: "The selected Codex home could not be prepared.",
          }),
      ),
    );
    return layout.effectiveHomePath;
  },
);

export const transcribeCodexAccount = Effect.fn("voice.transcribeCodexAccount")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  httpClient: HttpClient.HttpClient,
  audio: VoiceAudio,
) {
  const initial = yield* readTrustedAccountContext(client, false);
  const perform = (context: {
    readonly token: string;
    readonly routing: RoutingContext;
    readonly userId: string;
  }) => {
    let origin: URL;
    try {
      origin = new URL(context.routing.backendOrigin);
    } catch {
      return Effect.fail(
        new VoiceTranscriptionError({
          reason: "invalid_routing",
          detail: "Codex workspace routing origin is invalid.",
        }),
      );
    }
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    ) {
      return Effect.fail(
        new VoiceTranscriptionError({
          reason: "invalid_routing",
          detail: "Codex workspace routing origin is invalid.",
        }),
      );
    }
    origin.pathname = "/backend-api/transcribe";
    const body = new FormData();
    body.set("file", new Blob([audio.bytes], { type: audio.contentType }), audio.fileName);
    const request = HttpClientRequest.post(origin.toString()).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${context.token}`),
      HttpClientRequest.setHeader("chatgpt-account-id", context.routing.chatgptAccountId),
      HttpClientRequest.setHeader("user-agent", "T3 Code"),
      HttpClientRequest.bodyFormData(body),
    );
    const routed =
      context.routing.accountRoutingOverride === "NO_CONSTRAINT"
        ? request
        : HttpClientRequest.setHeader(
            "x-openai-account-routing-override",
            context.routing.accountRoutingOverride,
          )(request);
    return httpClient.execute(routed).pipe(
      Effect.mapError(safeProviderError),
      Effect.flatMap((response) =>
        response.status === 401
          ? Effect.fail(
              new VoiceTranscriptionError({
                reason: "upstream_unauthorized",
                detail: "Codex account authorization was rejected.",
                status: 401,
              }),
            )
          : HttpClientResponse.filterStatusOk(response).pipe(Effect.mapError(safeProviderError)),
      ),
      Effect.flatMap((response) => response.json.pipe(Effect.mapError(safeProviderError))),
      Effect.flatMap((value) =>
        value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string"
          ? Effect.succeed((value as { text: string }).text)
          : Effect.fail(
              new VoiceTranscriptionError({
                reason: "invalid_response",
                detail: "Codex returned an invalid transcription response.",
              }),
            ),
      ),
    );
  };
  const firstResult = yield* perform(initial).pipe(Effect.result);
  if (firstResult._tag === "Success") {
    const current = yield* readTrustedAccountContext(client, false);
    if (!samePrincipal(current, initial)) {
      return yield* Effect.fail(
        new VoiceTranscriptionError({
          reason: "invalid_routing",
          detail: "Codex workspace routing changed during transcription.",
        }),
      );
    }
    return firstResult.success;
  }
  if (firstResult.failure.status === 403) {
    return yield* Effect.fail(
      new VoiceTranscriptionError({
        reason: "upstream_forbidden",
        detail:
          "Codex account transcription was denied (HTTP 403). Signing in does not confirm transcription access.",
        status: 403,
      }),
    );
  }
  if (firstResult.failure.status !== 401) return yield* Effect.fail(firstResult.failure);
  const refreshed = yield* readTrustedAccountContext(client, true);
  if (!samePrincipal(refreshed, initial)) {
    return yield* Effect.fail(
      new VoiceTranscriptionError({
        reason: "auth_required",
        detail: "Codex account changed during authorization refresh.",
      }),
    );
  }
  const retry = yield* perform(refreshed);
  const current = yield* readTrustedAccountContext(client, false);
  if (!samePrincipal(current, refreshed)) {
    return yield* Effect.fail(
      new VoiceTranscriptionError({
        reason: "invalid_routing",
        detail: "Codex workspace routing changed during transcription.",
      }),
    );
  }
  return retry;
});

export const transcribeOpenAiApi = Effect.fn("voice.transcribeOpenAiApi")(function* (
  client: HttpClient.HttpClient,
  audio: VoiceAudio,
  apiKey: string,
  model: string,
) {
  const body = new FormData();
  body.set("file", new Blob([audio.bytes], { type: audio.contentType }), audio.fileName);
  body.set("model", model);
  const request = HttpClientRequest.post("https://api.openai.com/v1/audio/transcriptions").pipe(
    HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`),
    HttpClientRequest.bodyFormData(body),
  );
  return yield* client.execute(request).pipe(
    Effect.mapError(safeProviderError),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json.pipe(Effect.mapError(safeProviderError))),
    Effect.flatMap((value) =>
      value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string"
        ? Effect.succeed((value as { text: string }).text)
        : Effect.fail(
            new VoiceTranscriptionError({
              reason: "invalid_response",
              detail: "Transcription provider returned an invalid response.",
            }),
          ),
    ),
    Effect.timeout(VOICE_TRANSCRIPTION_TIMEOUT),
    Effect.mapError((error) =>
      error instanceof VoiceTranscriptionError ? error : safeProviderError(error),
    ),
  );
});

const sameRouting = (left: RoutingContext, right: RoutingContext) =>
  left.chatgptAccountId === right.chatgptAccountId &&
  left.backendOrigin === right.backendOrigin &&
  left.accountRoutingOverride === right.accountRoutingOverride;

const samePrincipal = (
  left: { readonly routing: RoutingContext; readonly userId: string },
  right: { readonly routing: RoutingContext; readonly userId: string },
) => sameRouting(left.routing, right.routing) && left.userId === right.userId;

export interface VoiceAudio {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly fileName: string;
}

export function liveCodexTranscriptionConfigs(
  configured: Readonly<Record<string, ProviderInstanceConfig>>,
  live: ReadonlyArray<{
    readonly instanceId: string;
    readonly driverKind: string;
    readonly enabled: boolean;
  }>,
): Record<string, ProviderInstanceConfig> {
  const instances: Record<string, ProviderInstanceConfig> = {};
  for (const instance of live) {
    if (instance.driverKind !== "codex" || !instance.enabled) continue;
    instances[instance.instanceId] = configured[instance.instanceId] ?? {
      driver: "codex" as ProviderInstanceConfig["driver"],
    };
  }
  return instances;
}

export function selectCodexTranscriptionInstance<
  T extends { readonly driver: string; readonly enabled?: boolean },
>(
  instances: Readonly<Record<string, T>>,
  defaultInstanceId: string | undefined,
  requestedInstanceId: string | undefined,
) {
  const codexInstances = Object.entries(instances)
    .filter(([, entry]) => entry.driver === "codex" && entry.enabled !== false)
    .sort(([left], [right]) => left.localeCompare(right));
  const enabledIds = new Set(codexInstances.map(([id]) => id));
  const selectedId = requestedInstanceId
    ? requestedInstanceId
    : defaultInstanceId && enabledIds.has(defaultInstanceId)
      ? defaultInstanceId
      : enabledIds.has("codex")
        ? "codex"
        : codexInstances[0]?.[0];
  return selectedId ? codexInstances.find(([id]) => id === selectedId) : undefined;
}

export class VoiceTranscriptionService extends Context.Service<
  VoiceTranscriptionService,
  {
    readonly getSettings: Effect.Effect<
      typeof VoiceTranscriptionSettings.Type,
      VoiceTranscriptionError
    >;
    readonly updateSettings: (
      input: typeof VoiceTranscriptionSettingsInput.Type,
    ) => Effect.Effect<typeof VoiceTranscriptionSettings.Type, VoiceTranscriptionError>;
    readonly transcribe: (
      audio: VoiceAudio,
    ) => Effect.Effect<string, VoiceTranscriptionError, FileSystem.FileSystem | Path.Path>;
  }
>()("t3/voice/VoiceTranscriptionService") {}

export const layer = Layer.effect(
  VoiceTranscriptionService,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const preferences = yield* makeVoiceSettings;
    const runtimeContext =
      yield* Effect.context<Effect.Services<ReturnType<typeof makeCodexManagedRuntime>>>();
    const readPreferences = preferences.read.pipe(
      Effect.mapError(
        () =>
          new VoiceTranscriptionError({
            reason: "provider_unavailable",
            detail: "Transcription settings could not be read.",
          }),
      ),
    );
    const getSettings = Effect.gen(function* () {
      const config = yield* readPreferences;
      const live = yield* registry.listInstances;
      const settings = yield* settingsService.getSettings;
      const candidates = live.filter((entry) => entry.driverKind === "codex" && entry.enabled);
      const instances = yield* Effect.forEach(candidates, (entry) =>
        entry.snapshot.getSnapshot.pipe(
          Effect.map((snapshot) => ({
            id: entry.instanceId,
            label: entry.displayName || entry.instanceId,
            authenticated: snapshot.auth.status === "authenticated",
          })),
        ),
      );
      const selected = config.instanceId
        ? instances.find((entry) => entry.id === config.instanceId)
        : (instances.find((entry) => entry.id === settings.defaultModelSelection?.instanceId) ??
          instances.find((entry) => entry.id === "codex") ??
          instances[0]);
      const available =
        config.provider === "openai-api"
          ? Boolean(config.apiKey)
          : Boolean(selected?.authenticated);
      return {
        provider: config.provider,
        instanceId: config.instanceId,
        model: config.model,
        apiKeyConfigured: Boolean(config.apiKey),
        apiKeySource: config.apiKeySource,
        available,
        instances,
        message:
          config.provider === "openai-api"
            ? config.apiKey
              ? "OpenAI API key configured on this environment."
              : "Add an OpenAI API key on this environment."
            : selected?.authenticated
              ? "Codex is signed in. Account transcription access is checked when you transcribe."
              : "Sign in to an enabled Codex provider on this environment.",
      };
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof VoiceTranscriptionError
          ? cause
          : new VoiceTranscriptionError({
              reason: "provider_unavailable",
              detail: "Transcription provider settings are unavailable.",
            }),
      ),
    );
    return VoiceTranscriptionService.of({
      getSettings,
      updateSettings: (input) =>
        preferences.write(input).pipe(
          Effect.mapError(
            () =>
              new VoiceTranscriptionError({
                reason: "provider_unavailable",
                detail: "Transcription settings could not be saved.",
              }),
          ),
          Effect.andThen(getSettings),
        ),
      transcribe: (audio) => {
        if (audio.bytes.byteLength > MAX_VOICE_AUDIO_BYTES) {
          return Effect.fail(
            new VoiceTranscriptionError({
              reason: "audio_too_large",
              detail: "Audio upload exceeds the 25 MiB limit.",
            }),
          );
        }
        return Effect.gen(function* () {
          const preferences = yield* readPreferences;
          const provider = preferences.provider;
          if (provider === "codex-account") {
            return yield* Effect.gen(function* () {
              const settings = yield* settingsService.getSettings;
              const requestedId = preferences.instanceId ?? undefined;
              const defaultId = settings.defaultModelSelection?.instanceId;
              const live = yield* registry.listInstances;
              // The live registry includes implicit built-ins omitted from the
              // sparse persisted settings map. Respect its enabled state.
              const instances = liveCodexTranscriptionConfigs(settings.providerInstances, live);
              const selected = selectCodexTranscriptionInstance(instances, defaultId, requestedId);
              if (!selected) {
                return yield* Effect.fail(
                  new VoiceTranscriptionError({
                    reason: "provider_unavailable",
                    detail: requestedId
                      ? "The requested Codex provider instance is unavailable or disabled."
                      : "No enabled Codex provider instance is configured.",
                  }),
                );
              }
              const [, envelope] = selected;
              const config = yield* Schema.decodeUnknownEffect(CodexSettings)(
                envelope.config ?? {},
              ).pipe(
                Effect.mapError(
                  () =>
                    new VoiceTranscriptionError({
                      reason: "provider_unavailable",
                      detail: "The selected Codex configuration is invalid.",
                    }),
                ),
              );
              if (!config.binaryPath) {
                return yield* Effect.fail(
                  new VoiceTranscriptionError({
                    reason: "provider_unavailable",
                    detail: "The selected Codex instance has no executable.",
                  }),
                );
              }
              const environment = yield* mergeProviderInstanceEnvironment(envelope.environment);
              if (config.setupMode === "managed") {
                const runtime = yield* makeCodexManagedRuntime({
                  instanceId: selected[0] as import("@t3tools/contracts").ProviderInstanceId,
                  enabled: true,
                  environment,
                  config,
                }).pipe(Effect.provideContext(runtimeContext));
                // Use T3's existing credential lease/refresh path. A ChatGPT
                // token remains subscription auth; never fall back to an API key.
                return yield* runtime.auth.controller.withAccess!(
                  runtime.resolve.pipe(
                    Effect.flatMap((effective) =>
                      transcribeOpenAiApi(
                        client,
                        audio,
                        effective.environment.ACCESS_TOKEN!,
                        preferences.model,
                      ),
                    ),
                  ),
                );
              }
              const codexEnvironment = { ...environment };
              delete codexEnvironment.T3CODE_TRANSCRIPTION_API_KEY;
              delete codexEnvironment.OPENAI_API_KEY;
              // withCodexAppServerClient supplies the T3 Code originator itself.
              delete codexEnvironment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
              const effectiveHomePath = yield* prepareCodexTranscriptionHome(config);
              const { client: codex } = yield* CodexProvider.withCodexAppServerClient({
                binaryPath: config.binaryPath,
                homePath: effectiveHomePath,
                launchArgs: resolveCodexLaunchArgs(config.launchArgs, codexEnvironment),
                cwd: process.cwd(),
                environment: codexEnvironment,
                extendEnv: false,
              });
              return yield* transcribeCodexAccount(codex, client, audio).pipe(
                Effect.withTracerEnabled(false),
              );
            }).pipe(
              Effect.scoped,
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.timeout(VOICE_TRANSCRIPTION_TIMEOUT),
              Effect.mapError((cause) =>
                cause instanceof VoiceTranscriptionError ? cause : safeProviderError(cause),
              ),
              Effect.withTracerEnabled(false),
            );
          }
          if (provider !== "openai-api") {
            return yield* Effect.fail(
              new VoiceTranscriptionError({
                reason: "provider_unavailable",
                detail: "T3CODE_TRANSCRIPTION_PROVIDER must be codex-account or openai-api.",
              }),
            );
          }
          const apiKey = preferences.apiKey;
          if (!apiKey)
            return yield* Effect.fail(
              new VoiceTranscriptionError({
                reason: "provider_unavailable",
                detail: "T3CODE_TRANSCRIPTION_API_KEY is required.",
              }),
            );
          return yield* transcribeOpenAiApi(client, audio, apiKey, preferences.model).pipe(
            Effect.withTracerEnabled(false),
          );
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof VoiceTranscriptionError ? cause : safeProviderError(cause),
          ),
          Effect.withTracerEnabled(false),
        );
      },
    });
  }),
).pipe(
  Layer.provide(
    FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchWithoutRedirects)),
    ),
  ),
);
