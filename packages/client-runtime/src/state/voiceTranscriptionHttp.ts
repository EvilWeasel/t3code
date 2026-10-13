import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const TRANSCRIPTION_RESPONSE = Schema.Struct({ transcript: Schema.String });
const decodeTranscriptionResponse = Schema.decodeUnknownEffect(TRANSCRIPTION_RESPONSE);

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
        const response = yield* HttpClient.execute(request).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { signal: input.signal }),
        );
        const payload = yield* response.json;
        const decoded = yield* decodeTranscriptionResponse(payload);
        return decoded.transcript;
      }),
  });
};
