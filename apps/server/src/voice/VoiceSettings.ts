import { VoiceTranscriptionSettingsInput } from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no authenticated encryption API.
import * as NodeCrypto from "node:crypto";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
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
const WRAPPING_KEY = "voice-transcription-wrapping-key";
const ENVELOPE = Buffer.from("t3-voice-key:v1\0");

class VoiceSecretEncryptionError extends Data.TaggedError("VoiceSecretEncryptionError")<{}> {
  override get message() {
    return "The saved voice key could not be secured. Remove it and save it again.";
  }
}

// The wrapping key is private to this environment but shares the secret store.
// This protects the credential file at rest, not against access to the whole store.
const encryptKey = (value: string, key: Uint8Array, nonce: Uint8Array) =>
  Effect.try({
    try: () => {
      const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(ENVELOPE);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([ENVELOPE, nonce, cipher.getAuthTag(), ciphertext]);
    },
    catch: () => new VoiceSecretEncryptionError(),
  });

const decryptKey = (value: Uint8Array, key: Uint8Array) =>
  Effect.try({
    try: () => {
      const bytes = Buffer.from(value);
      if (
        bytes.length <= ENVELOPE.length + 28 ||
        !bytes.subarray(0, ENVELOPE.length).equals(ENVELOPE)
      )
        throw new Error("Invalid voice key envelope");
      const decipher = NodeCrypto.createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(ENVELOPE.length, ENVELOPE.length + 12),
      );
      decipher.setAAD(ENVELOPE);
      decipher.setAuthTag(bytes.subarray(ENVELOPE.length + 12, ENVELOPE.length + 28));
      return Buffer.concat([
        decipher.update(bytes.subarray(ENVELOPE.length + 28)),
        decipher.final(),
      ]).toString("utf8");
    },
    catch: () => new VoiceSecretEncryptionError(),
  });

/** Non-secret preferences are independent of provider coding credentials. */
export const makeVoiceSettings = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const filename = path.join(server.stateDir, "voice-transcription.json");
  const readConfig = Effect.gen(function* () {
    const exists = yield* fs.exists(filename);
    return exists
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
  });
  const read = Effect.gen(function* () {
    const config = yield* readConfig;
    const stored = yield* secrets.get(SECRET);
    let apiKey = process.env.T3CODE_TRANSCRIPTION_API_KEY;
    if (Option.isSome(stored)) {
      const key = yield* secrets.get(WRAPPING_KEY);
      if (Option.isNone(key)) return yield* Effect.fail(new VoiceSecretEncryptionError());
      // Reads never migrate plaintext or recreate a missing wrapping key.
      apiKey = yield* decryptKey(stored.value, key.value);
    }
    const apiKeySource = Option.isSome(stored)
      ? ("saved" as const)
      : apiKey
        ? ("environment" as const)
        : ("none" as const);
    return { ...config, apiKey, apiKeySource };
  }).pipe(Effect.withTracerEnabled(false));
  // Settings remain recoverable without trusting or rewriting an unreadable key.
  // Transcription continues to use the strict read above.
  const readForSettings = read.pipe(
    Effect.map((config) => ({ ...config, keyUnavailable: false })),
    Effect.catchIf(
      (error) => error instanceof VoiceSecretEncryptionError,
      () =>
        readConfig.pipe(
          Effect.map((config) => ({
            ...config,
            apiKey: undefined,
            apiKeySource: "saved" as const,
            keyUnavailable: true,
          })),
        ),
    ),
  );
  const write = (input: typeof VoiceTranscriptionSettingsInput.Type) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (input.apiKey === null) yield* secrets.remove(SECRET);
        if (input.apiKey?.trim()) {
          const key = yield* secrets.getOrCreateRandom(WRAPPING_KEY, 32);
          const nonce = yield* crypto.randomBytes(12);
          const encrypted = yield* encryptKey(input.apiKey.trim(), key, nonce);
          yield* secrets.set(SECRET, encrypted);
        }
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
  return { read, readForSettings, write };
});
