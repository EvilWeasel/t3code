import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
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
});
