import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as RpcHttp from "../rpc/http.ts";
import { transcribeEnvironmentVoiceRecording } from "./voiceTranscriptionHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-voice-test"),
  label: "Remote test environment",
  httpBaseUrl: "https://remote-environment.example.test/base",
  wsBaseUrl: "wss://remote-environment.example.test/ws",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: { _tag: "Bearer", token: "environment-session-token" },
  target: TARGET,
};

describe("transcribeEnvironmentVoiceRecording", () => {
  it.effect(
    "uploads the reviewed blob to the selected environment with no page-origin request",
    () =>
      Effect.gen(function* () {
        const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
        const controller = new AbortController();
        const fetchFn = ((request, init) => {
          calls.push([request, init ?? {}]);
          return Promise.resolve(Response.json({ transcript: "recognized words" }));
        }) satisfies typeof fetch;
        const audio = new Blob(["sample"], { type: "audio/wav" });
        const result = yield* transcribeEnvironmentVoiceRecording({
          prepared: PREPARED,
          audio,
          filename: "voice-message.wav",
          signal: controller.signal,
          signer: Option.none(),
          remoteAuthorization: Option.none(),
        }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)));

        expect(result).toBe("recognized words");
        expect(calls).toHaveLength(1);
        expect(String(calls[0]![0])).toBe(
          "https://remote-environment.example.test/api/voice/transcription",
        );
        expect(new Headers(calls[0]![1].headers).get("authorization")).toBe(
          "Bearer environment-session-token",
        );
        expect(calls[0]![1].signal).toBeInstanceOf(AbortSignal);
        expect(calls[0]![1].signal?.aborted).toBe(false);
        const body = calls[0]![1].body;
        expect(body).toBeInstanceOf(FormData);
        const file = (body as FormData).get("audio") as File;
        expect(file.name).toBe("voice-message.wav");
        expect(file.type).toBe("audio/wav");
        expect(yield* Effect.promise(() => file.text())).toBe("sample");
        expect((body as FormData).has("file")).toBe(false);
      }),
  );

  it.effect("reports an unavailable remote response without reading or exposing its body", () =>
    Effect.gen(function* () {
      const fetchFn = (() =>
        Promise.resolve(
          new Response("private challenge body", { status: 403 }),
        )) satisfies typeof fetch;
      const error = yield* transcribeEnvironmentVoiceRecording({
        prepared: PREPARED,
        audio: new Blob(["sample"], { type: "audio/webm" }),
        filename: "voice-message.webm",
        signal: new AbortController().signal,
        signer: Option.none(),
        remoteAuthorization: Option.none(),
      }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)), Effect.flip);
      expect(error._tag).toBe("RemoteEnvironmentAuthUndeclaredStatusError");
      expect(JSON.stringify(error)).not.toContain("private challenge body");
    }),
  );

  it.effect("decodes only the typed provider failure contract from upstream 502 responses", () =>
    Effect.gen(function* () {
      const fetchFn = (() =>
        Promise.resolve(
          Response.json(
            {
              _tag: "VoiceTranscriptionHttpError",
              code: "voice_transcription_failed",
              reason: "upstream_forbidden",
              detail: "Provider response detail is bounded by the service contract.",
            },
            { status: 502 },
          ),
        )) satisfies typeof fetch;
      const error = yield* transcribeEnvironmentVoiceRecording({
        prepared: PREPARED,
        audio: new Blob(["sample"], { type: "audio/webm" }),
        filename: "voice-message.webm",
        signal: new AbortController().signal,
        signer: Option.none(),
        remoteAuthorization: Option.none(),
      }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)), Effect.flip);

      expect(error._tag).toBe("VoiceTranscriptionHttpError");
      if (error._tag === "VoiceTranscriptionHttpError") {
        expect(error.reason).toBe("upstream_forbidden");
        expect(error.detail).toBe("Provider response detail is bounded by the service contract.");
      }
    }),
  );

  it.effect("signs the voice URL with the selected relay environment's DPoP session", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const proofs: Array<{
        readonly method: string;
        readonly url: string;
        readonly accessToken: string;
      }> = [];
      const fetchFn = ((request, init) => {
        calls.push([request, init ?? {}]);
        return Promise.resolve(Response.json({ transcript: "relay transcript" }));
      }) satisfies typeof fetch;
      const environmentId = EnvironmentId.make("environment-relay-voice");
      const target = new RelayConnectionTarget({ environmentId, label: "Selected relay" });
      const prepared: PreparedConnection = {
        ...PREPARED,
        environmentId,
        target,
        httpBaseUrl: "https://relay.invalid",
        httpAuthorization: { _tag: "Dpop", accessToken: "stale-access-token", expiresAtEpochMs: 1 },
      };
      const remoteAuthorization = Option.some({
        authorizeDpopHttp: () =>
          Effect.succeed({
            environmentId,
            label: "Selected relay",
            httpBaseUrl: "https://selected-environment.example.test",
            httpAuthorization: {
              _tag: "Dpop" as const,
              accessToken: "fresh-access-token",
              expiresAtEpochMs: 4_102_444_800_000,
            },
          }),
      } as never);
      const signer = Option.some({
        thumbprint: Effect.succeed("thumbprint"),
        createProof: (input: {
          readonly method: string;
          readonly url: string;
          readonly accessToken: string;
        }) => {
          proofs.push(input);
          return Effect.succeed("request-bound-proof");
        },
      } as never);

      const result = yield* transcribeEnvironmentVoiceRecording({
        prepared,
        audio: new Blob(["sample"], { type: "audio/webm" }),
        filename: "voice-message.webm",
        signal: new AbortController().signal,
        signer,
        remoteAuthorization,
      }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetchFn)));

      expect(result).toBe("relay transcript");
      expect(String(calls[0]![0])).toBe(
        "https://selected-environment.example.test/api/voice/transcription",
      );
      expect(new Headers(calls[0]![1].headers).get("authorization")).toBe(
        "DPoP fresh-access-token",
      );
      expect(new Headers(calls[0]![1].headers).get("dpop")).toBe("request-bound-proof");
      expect(proofs).toEqual([
        {
          method: "POST",
          url: "https://selected-environment.example.test/api/voice/transcription",
          accessToken: "fresh-access-token",
        },
      ]);
    }),
  );
});
