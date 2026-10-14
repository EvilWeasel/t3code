import { VoiceTranscriptionSettingsInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const Config = Schema.Struct({
  provider: Schema.Literals(["codex-account", "openai-api"]),
  instanceId: Schema.NullOr(Schema.String),
  model: Schema.String,
});
const SECRET = "voice-transcription-api-key";

/** Non-secret preferences are independent of provider coding credentials. */
export const makeVoiceSettings = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const lock = yield* Semaphore.make(1);
  const filename = path.join(server.stateDir, "voice-transcription.json");
  const read = Effect.gen(function* () {
    const exists = yield* fs.exists(filename);
    const config = exists
      ? yield* fs
          .readFileString(filename)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Config))))
      : {
          provider:
            process.env.T3CODE_TRANSCRIPTION_PROVIDER === "openai-api"
              ? ("openai-api" as const)
              : ("codex-account" as const),
          instanceId: process.env.T3CODE_TRANSCRIPTION_CODEX_INSTANCE_ID ?? null,
          model: process.env.T3CODE_TRANSCRIPTION_MODEL || "gpt-transcribe",
        };
    const stored = yield* secrets.get(SECRET);
    const apiKey = Option.isSome(stored)
      ? new TextDecoder().decode(stored.value)
      : process.env.T3CODE_TRANSCRIPTION_API_KEY;
    const apiKeySource = Option.isSome(stored)
      ? ("saved" as const)
      : apiKey
        ? ("environment" as const)
        : ("none" as const);
    return { ...config, apiKey, apiKeySource };
  });
  const write = (input: typeof VoiceTranscriptionSettingsInput.Type) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (input.apiKey === null) yield* secrets.remove(SECRET);
        if (input.apiKey?.trim())
          yield* secrets.set(SECRET, new TextEncoder().encode(input.apiKey.trim()));
        const config = {
          provider: input.provider,
          instanceId: input.instanceId || null,
          model: input.model.trim() || "gpt-transcribe",
        };
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Config))(config);
        yield* fs.writeFileString(`${filename}.tmp`, encoded, { mode: 0o600 });
        yield* fs.rename(`${filename}.tmp`, filename);
      }).pipe(Effect.withTracerEnabled(false)),
    );
  return { read, write };
});
