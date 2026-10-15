import type {
  EnvironmentId,
  VoiceTranscriptionSettings,
  VoiceTranscriptionSettingsInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { AtomRegistry } from "effect/reactivity";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization/service";
import * as ManagedRelay from "@t3tools/client-runtime/relay/managed-relay";
import { requestEnvironmentVoiceSettings } from "@t3tools/client-runtime/state/voice-transcription";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "../state/session";

class VoiceSettingsUnavailable extends Data.TaggedError("VoiceSettingsUnavailable")<{
  readonly message: string;
}> {}

/** Fixed client copy only: errors can contain private upstream bodies or request payloads. */
export function voiceSettingsErrorMessage(error: unknown): string {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error ? error._tag : undefined;
  switch (tag) {
    case "EnvironmentScopeRequiredError":
      return "This connection cannot change voice settings. Use a connection with settings:write permission on this environment.";
    case "EnvironmentAuthInvalidError":
      return "This environment rejected the connection credentials. Reconnect this environment and try again.";
    case "VoiceSettingsUnavailable":
      return "The selected environment is not connected. Reconnect it and try again.";
    case "VoiceSettingsStorageUnavailable":
      return "Update this environment before saving an API key. Encrypted storage is not confirmed.";
    case "RemoteEnvironmentAuthTimeoutError":
      return "This environment did not respond in time. Reload its voice settings before retrying.";
    case "RemoteEnvironmentAuthInvalidJsonError":
      return "This environment returned an unsupported voice settings response. Update the environment and try again.";
    case "EnvironmentInternalError":
      return "This environment could not confirm its voice settings. Reload them and check the server's storage before retrying.";
    default:
      return "Could not reach voice settings on this environment. Check its connection and try again.";
  }
}

export async function voiceSettingsRequest(
  environmentId: EnvironmentId,
  update?: typeof VoiceTranscriptionSettingsInput.Type,
): Promise<typeof VoiceTranscriptionSettings.Type> {
  const request = connectionAtomRuntime.fn<void>()((_input, get) =>
    Effect.gen(function* () {
      const prepared = get(environmentSession.preparedConnectionValueAtom(environmentId));
      if (Option.isNone(prepared) || prepared.value.environmentId !== environmentId)
        return yield* Effect.fail(
          new VoiceSettingsUnavailable({ message: "Environment disconnected." }),
        );
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
  const result = await Effect.runPromise(
    Effect.result(AtomRegistry.getResult(appAtomRegistry, request, { suspendOnWaiting: true })),
  );
  if (Result.isSuccess(result)) return result.success;
  // Preserve the typed failure across the Promise boundary instead of wrapping
  // it in a FiberFailure that hides permission/storage errors from the client.
  throw result.failure;
}
