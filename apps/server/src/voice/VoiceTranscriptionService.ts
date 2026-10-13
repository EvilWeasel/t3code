import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

export class VoiceTranscriptionError extends Data.TaggedError("VoiceTranscriptionError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

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

export const layer: Layer.Layer<VoiceTranscriptionService> = Layer.effect(
  VoiceTranscriptionService,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return VoiceTranscriptionService.of({
      transcribe: (audio) => {
        const provider = process.env.T3CODE_TRANSCRIPTION_PROVIDER ?? "codex-account";
        if (provider !== "openai-api") {
          return Effect.fail(
            new VoiceTranscriptionError({
              detail:
                provider === "codex-account"
                  ? "Codex account transcription requires workspace routing support."
                  : "T3CODE_TRANSCRIPTION_PROVIDER must be codex-account or openai-api.",
            }),
          );
        }
        const apiKey = process.env.T3CODE_TRANSCRIPTION_API_KEY;
        if (!apiKey)
          return Effect.fail(
            new VoiceTranscriptionError({ detail: "T3CODE_TRANSCRIPTION_API_KEY is required." }),
          );
        const body = new FormData();
        body.set("file", new Blob([audio.bytes], { type: audio.contentType }), audio.fileName);
        body.set("model", process.env.T3CODE_TRANSCRIPTION_MODEL || "gpt-transcribe");
        return HttpClientRequest.post("https://api.openai.com/v1/audio/transcriptions").pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${apiKey}`),
          HttpClientRequest.bodyFormData(body),
          client.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.flatMap((value) => {
            if (
              value &&
              typeof value === "object" &&
              typeof (value as { text?: unknown }).text === "string"
            ) {
              return Effect.succeed((value as { text: string }).text);
            }
            return Effect.fail(
              new VoiceTranscriptionError({
                detail: "Transcription provider returned an invalid response.",
              }),
            );
          }),
          Effect.mapError((cause) =>
            cause instanceof VoiceTranscriptionError
              ? cause
              : new VoiceTranscriptionError({
                  detail: "Transcription provider request failed.",
                  cause,
                }),
          ),
        );
      },
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
