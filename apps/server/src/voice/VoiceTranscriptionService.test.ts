import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentAuthenticatedPrincipal,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  MAX_VOICE_AUDIO_BYTES,
  VoiceTranscriptionError,
  createNoRedirectFetch,
  readTrustedAccountContext,
  safeProviderError,
  transcribeCodexAccount,
  transcribeOpenAiApi,
  validateVoiceAudio,
} from "./VoiceTranscriptionService.ts";
import { requireEnvironmentScope } from "../auth/http.ts";

const routeContext = {
  account: { type: "chatgpt", id: "account-1" },
  workspaceRouting: {
    chatgptAccountId: "account-1",
    backendOrigin: "https://chatgpt.com/",
    accountRoutingOverride: "us",
  },
};

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
}) {
  let authIndex = 0;
  const users = input.users ?? ["user-1"];
  const codex = {
    request: () =>
      Effect.sync(() => {
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
      const codex = mockCodex({ users: ["user-1", "user-1", "user-1"] });
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
    }),
);

it.effect("reports upstream 403 without retaining the raw response or request", () =>
  Effect.gen(function* () {
    const secret = "sk-fake-voice-secret";
    const codex = mockCodex({});
    const httpClient = {
      execute: (request: HttpClientRequest.HttpClientRequest) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(`forbidden Bearer ${secret}`, { status: 403 }),
          ),
        ),
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
      assert(!JSON.stringify(result.failure).includes(secret));
    }
  }),
);

it("redacts secrets and outbound request details from errors", () => {
  const secret = "sk-fake-voice-secret";
  const safe = safeProviderError(new Error(`Authorization: Bearer ${secret}`));
  assert(!safe.message.includes(secret));
  assert(!JSON.stringify(safe).includes(secret));
  assert(!Object.keys(safe).includes("cause"));
  assert.strictEqual(MAX_VOICE_AUDIO_BYTES, 25 * 1024 * 1024);
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
