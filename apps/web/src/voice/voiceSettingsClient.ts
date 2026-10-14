import type {
  EnvironmentId,
  VoiceTranscriptionSettings,
  VoiceTranscriptionSettingsInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AtomRegistry } from "effect/reactivity";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization/service";
import * as ManagedRelay from "@t3tools/client-runtime/relay/managed-relay";
import { requestEnvironmentVoiceSettings } from "@t3tools/client-runtime/state/voice-transcription";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "../state/session";

export async function voiceSettingsRequest(
  environmentId: EnvironmentId,
  update?: typeof VoiceTranscriptionSettingsInput.Type,
): Promise<typeof VoiceTranscriptionSettings.Type> {
  const request = connectionAtomRuntime.fn<void>()((_input, get) =>
    Effect.gen(function* () {
      const prepared = get(environmentSession.preparedConnectionValueAtom(environmentId));
      if (Option.isNone(prepared))
        return yield* Effect.fail(new Error("Environment disconnected."));
      const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
      const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
      return yield* requestEnvironmentVoiceSettings({
        prepared: prepared.value,
        signer,
        remoteAuthorization,
        ...(update ? { update } : {}),
      });
    }).pipe(Effect.withTracerEnabled(false)),
  );
  appAtomRegistry.set(request, undefined);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, request, { suspendOnWaiting: true }),
  );
}
