import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Multipart from "effect/http/Multipart";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as VoiceTranscriptionService from "./VoiceTranscriptionService.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* VoiceTranscriptionService.VoiceTranscriptionService;
    const fs = yield* FileSystem.FileSystem;
    return handlers.handle(
      "voiceTranscription",
      Effect.fn("environment.voice.transcription")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
        const file = args.payload.audio;
        if (!Multipart.isPersistedFile(file))
          return yield* Effect.die(new Error("Invalid audio upload."));
        const bytes = yield* fs
          .readFile(file.path)
          .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        const transcript = yield* service
          .transcribe({ bytes, contentType: file.contentType, fileName: file.name })
          .pipe(
            traceLocalHandlerWork,
            Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
          );
        return { transcript };
      }),
    );
  }),
);
