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
import { decodeJwt } from "jose";
import { CodexSettings } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexProvider from "../provider/CodexProvider.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveCodexLaunchArgs } from "../provider/codexLaunchArgs.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";

export class VoiceTranscriptionError extends Data.TaggedError("VoiceTranscriptionError")<{
  readonly detail: string;
  readonly status?: number;
}> {}

export const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;
export const VOICE_TRANSCRIPTION_TIMEOUT = "60 seconds" as const;

export const validateVoiceAudio = (audio: VoiceAudio) =>
  audio.bytes.byteLength <= MAX_VOICE_AUDIO_BYTES
    ? Effect.void
    : Effect.fail(
        new VoiceTranscriptionError({ detail: "Audio upload exceeds the 25 MiB limit." }),
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
  return new VoiceTranscriptionError({
    detail:
      status === undefined
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
  const auth = yield* client.request("getAuthStatus", { includeToken: true, refreshToken });
  if (!auth.authToken || auth.authMethod !== "chatgpt") {
    return yield* Effect.fail(
      new VoiceTranscriptionError({ detail: "Codex is not signed in with a ChatGPT account." }),
    );
  }
  const account = yield* client.raw.request("account/read", {}).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(RawAccountRead)),
    Effect.mapError(
      () =>
        new VoiceTranscriptionError({ detail: "Codex did not provide trusted workspace routing." }),
    ),
  );
  if (!account.account || account.account.type !== "chatgpt") {
    return yield* Effect.fail(
      new VoiceTranscriptionError({ detail: "Codex is not signed in with a ChatGPT account." }),
    );
  }
  if (
    account.account.id !== undefined &&
    account.account.id !== account.workspaceRouting.chatgptAccountId
  ) {
    return yield* Effect.fail(
      new VoiceTranscriptionError({ detail: "Codex account does not match workspace routing." }),
    );
  }
  const claims = yield* Effect.try({
    try: () => decodeJwt(auth.authToken!),
    catch: () =>
      new VoiceTranscriptionError({ detail: "Codex account identity could not be verified." }),
  });
  const authClaims = claims["https://api.openai.com/auth"];
  if (!authClaims || typeof authClaims !== "object") {
    return yield* Effect.fail(
      new VoiceTranscriptionError({ detail: "Codex account identity could not be verified." }),
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
        detail: "Codex account identity does not match workspace routing.",
      }),
    );
  }
  return { token: auth.authToken, routing: account.workspaceRouting, userId: claimUserId };
});

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
    const origin = new URL(context.routing.backendOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/"
    ) {
      return Effect.fail(
        new VoiceTranscriptionError({ detail: "Codex workspace routing origin is invalid." }),
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
          detail: "Codex workspace routing changed during transcription.",
        }),
      );
    }
    return firstResult.success;
  }
  if (firstResult.failure.status !== 401) return yield* Effect.fail(firstResult.failure);
  const refreshed = yield* readTrustedAccountContext(client, true);
  if (!samePrincipal(refreshed, initial)) {
    return yield* Effect.fail(
      new VoiceTranscriptionError({
        detail: "Codex account changed during authorization refresh.",
      }),
    );
  }
  const retry = yield* perform(refreshed);
  const current = yield* readTrustedAccountContext(client, false);
  if (!samePrincipal(current, refreshed)) {
    return yield* Effect.fail(
      new VoiceTranscriptionError({
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

export class VoiceTranscriptionService extends Context.Service<
  VoiceTranscriptionService,
  {
    readonly transcribe: (audio: VoiceAudio) => Effect.Effect<string, VoiceTranscriptionError>;
  }
>()("t3/voice/VoiceTranscriptionService") {}

export const layer: Layer.Layer<
  VoiceTranscriptionService,
  never,
  ServerSettings.ServerSettingsService | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(
  VoiceTranscriptionService,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return VoiceTranscriptionService.of({
      transcribe: (audio) => {
        if (audio.bytes.byteLength > MAX_VOICE_AUDIO_BYTES) {
          return Effect.fail(
            new VoiceTranscriptionError({ detail: "Audio upload exceeds the 25 MiB limit." }),
          );
        }
        const provider = process.env.T3CODE_TRANSCRIPTION_PROVIDER ?? "codex-account";
        if (provider === "codex-account") {
          return Effect.gen(function* () {
            const settings = yield* settingsService.getSettings;
            const requestedId = process.env.T3CODE_TRANSCRIPTION_CODEX_INSTANCE_ID;
            const selectedId = requestedId ?? settings.defaultModelSelection?.instanceId ?? "codex";
            const selected = Object.entries(settings.providerInstances).find(
              ([id, entry]) =>
                id === selectedId && entry.driver === "codex" && entry.enabled !== false,
            );
            if (!selected) {
              return yield* Effect.fail(
                new VoiceTranscriptionError({
                  detail: "No enabled Codex provider instance is configured.",
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
                    detail: "The selected Codex configuration is invalid.",
                  }),
              ),
            );
            if (!config.binaryPath) {
              return yield* Effect.fail(
                new VoiceTranscriptionError({
                  detail: "The selected Codex instance has no executable.",
                }),
              );
            }
            const environment = yield* mergeProviderInstanceEnvironment(envelope.environment);
            const codexEnvironment = { ...environment };
            delete codexEnvironment.T3CODE_TRANSCRIPTION_API_KEY;
            delete codexEnvironment.OPENAI_API_KEY;
            const { client: codex } = yield* CodexProvider.withCodexAppServerClient({
              binaryPath: config.binaryPath,
              homePath: config.homePath,
              launchArgs: resolveCodexLaunchArgs(config.launchArgs, codexEnvironment),
              cwd: process.cwd(),
              environment: codexEnvironment,
            });
            return yield* transcribeCodexAccount(codex, client, audio);
          }).pipe(
            Effect.scoped,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.timeout(VOICE_TRANSCRIPTION_TIMEOUT),
            Effect.mapError((cause) =>
              cause instanceof VoiceTranscriptionError ? cause : safeProviderError(cause),
            ),
          );
        }
        if (provider !== "openai-api") {
          return Effect.fail(
            new VoiceTranscriptionError({
              detail: "T3CODE_TRANSCRIPTION_PROVIDER must be codex-account or openai-api.",
            }),
          );
        }
        const apiKey = process.env.T3CODE_TRANSCRIPTION_API_KEY;
        if (!apiKey)
          return Effect.fail(
            new VoiceTranscriptionError({ detail: "T3CODE_TRANSCRIPTION_API_KEY is required." }),
          );
        return transcribeOpenAiApi(
          client,
          audio,
          apiKey,
          process.env.T3CODE_TRANSCRIPTION_MODEL || "gpt-transcribe",
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
