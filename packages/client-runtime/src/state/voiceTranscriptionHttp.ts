import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  VoiceTranscriptionFailureReason,
  VoiceTranscriptionHttpError,
} from "@t3tools/contracts";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import type { VoiceTranscriptionSettingsInput } from "@t3tools/contracts";

export const requestEnvironmentVoiceSettings = (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization: Option.Option<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
  readonly update?: typeof VoiceTranscriptionSettingsInput.Type;
}) =>
  executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "voice",
    method: input.update ? "PUT" : "GET",
    timeoutMs: 15_000,
    url: (urls) => urls.voiceSettings(),
    request: ({ client, headers }) =>
      input.update
        ? client.updateVoiceSettings({ payload: input.update, headers })
        : client.voiceSettings({ headers }),
  });

const TRANSCRIPTION_RESPONSE = Schema.Struct({ transcript: Schema.String });
const decodeTranscriptionResponse = Schema.decodeUnknownEffect(TRANSCRIPTION_RESPONSE);
const decodeTranscriptionFailure = Schema.decodeUnknownEffect(VoiceTranscriptionHttpError);

/** Fixed client copy for validated service failure reasons; never display response detail directly. */
export const voiceTranscriptionFailureMessage = (
  reason: typeof VoiceTranscriptionFailureReason.Type,
): string => {
  switch (reason) {
    case "audio_too_large":
      return "This recording is too large. Record a shorter message.";
    case "auth_required":
      return "Transcription authentication is unavailable for this environment.";
    case "invalid_routing":
      return "Transcription routing is not configured for this environment.";
    case "provider_unavailable":
      return "The transcription provider is unavailable. Try again shortly.";
    case "upstream_unauthorized":
      return "The transcription provider rejected its authorization.";
    case "upstream_forbidden":
      return "The transcription provider denied this request.";
    case "upstream_failure":
      return "The transcription provider failed. Try again.";
    case "invalid_response":
      return "The transcription service returned an invalid result.";
    case "timeout":
      return "Transcription timed out. Your recording is available to retry.";
    default:
      return "Transcription failed. Your recording is available to retry.";
  }
};

/** Upload a reviewed recording to the selected environment with its normal HTTP authorization. */
export const transcribeEnvironmentVoiceRecording = (input: {
  readonly prepared: PreparedConnection;
  readonly audio: Blob;
  readonly filename: string;
  readonly signal: AbortSignal;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization: Option.Option<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
}) => {
  const form = new FormData();
  form.append("audio", input.audio, input.filename);
  return executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer: input.signer,
    remoteAuthorization: input.remoteAuthorization,
    group: "voice",
    method: "POST",
    url: (urls) => urls.voiceTranscription(),
    timeoutMs: 60_000,
    request: ({ headers, url }) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders({
            ...headers,
            [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
          }),
          HttpClientRequest.bodyFormData(form),
        );
        // Inspect the typed service error before Effect's default 2xx filter
        // turns it into a generic status error. Other statuses still use the
        // normal environment HTTP error mapping below.
        const response = yield* Effect.flatMap(HttpClient.HttpClient, (client) =>
          HttpClient.execute(request).pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { signal: input.signal }),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.filterStatus(client, () => true),
            ),
          ),
        );
        if (response.status === 502) {
          const payload = yield* response.json;
          const serviceFailure = yield* decodeTranscriptionFailure(payload).pipe(
            Effect.catch(() => HttpClientResponse.filterStatusOk(response)),
          );
          return yield* Effect.fail(serviceFailure);
        }
        const successfulResponse = yield* HttpClientResponse.filterStatusOk(response);
        const payload = yield* successfulResponse.json;
        const decoded = yield* decodeTranscriptionResponse(payload);
        return decoded.transcript;
      }),
  });
};
