import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Data from "effect/Data";
import { AtomRegistry } from "effect/reactivity";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization/service";
import * as ManagedRelay from "@t3tools/client-runtime/relay/managed-relay";
import { transcribeEnvironmentVoiceRecording } from "@t3tools/client-runtime/state/voice-transcription";
import type { VoiceDictationTranscriber } from "./useVoiceDictation";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "../state/session";

const MAX_VOICE_RECORDING_BYTES = 25 * 1024 * 1024;

class VoiceTranscriptionEnvironmentUnavailableError extends Data.TaggedError(
  "VoiceTranscriptionEnvironmentUnavailableError",
)<{
  readonly message: string;
}> {}

const transcribeAtom = connectionAtomRuntime.fn<{
  readonly environmentId: EnvironmentId;
  readonly audio: Blob;
  readonly filename: string;
  readonly signal: AbortSignal;
}>()(
  (input, get) =>
    Effect.gen(function* () {
      const preparedOption = get(
        environmentSession.preparedConnectionValueAtom(input.environmentId),
      );
      if (Option.isNone(preparedOption))
        return yield* new VoiceTranscriptionEnvironmentUnavailableError({
          message: "The selected environment is not connected.",
        });
      const prepared = preparedOption.value;
      if (prepared.environmentId !== input.environmentId)
        return yield* new VoiceTranscriptionEnvironmentUnavailableError({
          message: "The selected environment changed.",
        });
      const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
      const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
      return yield* transcribeEnvironmentVoiceRecording({
        ...input,
        prepared,
        signer,
        remoteAuthorization,
      });
    }),
  { concurrent: true },
);

/** Upload only to the composer environment through its authenticated HTTP client. */
export function transcribeVoiceRecording(environmentId: EnvironmentId): VoiceDictationTranscriber {
  return async (audio, { signal }) => {
    if (audio.size > MAX_VOICE_RECORDING_BYTES) throw new Error("voice-recording-too-large");
    const contentType = audio.type.trim().toLowerCase() || "audio/webm";
    const extension = contentType.includes("wav")
      ? "wav"
      : contentType.includes("mp4")
        ? "m4a"
        : contentType.includes("ogg")
          ? "ogg"
          : "webm";
    const args = { environmentId, audio, filename: `voice-message.${extension}`, signal };
    appAtomRegistry.set(transcribeAtom, args);
    return await Effect.runPromise(
      AtomRegistry.getResult(appAtomRegistry, transcribeAtom, { suspendOnWaiting: true }),
    );
  };
}
