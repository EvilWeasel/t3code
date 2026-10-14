import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { makeVoiceSettings } from "./VoiceSettings.ts";

it.effect("keeps an unchanged key private and removes only the explicitly saved key", () =>
  Effect.gen(function* () {
    const store = yield* makeVoiceSettings;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const settings = { provider: "openai-api" as const, instanceId: null, model: "gpt-transcribe" };
    yield* store.write({ ...settings, apiKey: "fixture-private-key" });
    assert.equal((yield* store.read).apiKey, "fixture-private-key");
    const raw = yield* fs.readFileString(path.join(config.stateDir, "voice-transcription.json"));
    assert.isFalse(raw.includes("fixture-private-key"));
    const secretPath = path.join(config.secretsDir, "voice-transcription-api-key.bin");
    const encrypted = yield* fs.readFile(secretPath);
    assert.isFalse(new TextDecoder().decode(encrypted).includes("fixture-private-key"));
    assert.equal((yield* fs.stat(secretPath)).mode & 0o777, 0o600);
    assert.equal((yield* fs.stat(config.secretsDir)).mode & 0o777, 0o700);
    const reopened = yield* makeVoiceSettings;
    assert.equal((yield* reopened.read).apiKey, "fixture-private-key");
    yield* store.write({ ...settings, model: "another-model" });
    assert.equal((yield* store.read).apiKey, "fixture-private-key");
    yield* store.write({ ...settings, apiKey: "" });
    assert.equal((yield* store.read).apiKey, "fixture-private-key");
    assert.deepEqual(yield* fs.readFile(secretPath), encrypted);
    yield* store.write({ ...settings, apiKey: "  fixture-private-key  " });
    assert.notDeepEqual(yield* fs.readFile(secretPath), encrypted);
    assert.equal((yield* reopened.read).apiKey, "fixture-private-key");
    yield* store.write({ ...settings, apiKey: null });
    assert.equal((yield* store.read).apiKey, process.env.T3CODE_TRANSCRIPTION_API_KEY);
    assert.notEqual((yield* store.read).apiKeySource, "saved");
  }).pipe(
    Effect.provide(
      ServerSecretStore.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "voice-settings-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);

it.effect("rejects tampering, missing wrapping keys and plaintext without rewriting secrets", () =>
  Effect.gen(function* () {
    const store = yield* makeVoiceSettings;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const settings = { provider: "openai-api" as const, instanceId: null, model: "gpt-transcribe" };
    yield* store.write({ ...settings, apiKey: "fixture-private-key" });
    const stored = yield* secrets.get("voice-transcription-api-key");
    assert(Option.isSome(stored));
    if (Option.isNone(stored)) return;
    const tampered = Uint8Array.from(stored.value);
    tampered[tampered.length - 1]! ^= 1;
    yield* secrets.set("voice-transcription-api-key", tampered);
    const rejected = yield* store.read.pipe(Effect.result);
    assert.equal(rejected._tag, "Failure");
    if (rejected._tag === "Failure")
      assert.isFalse(JSON.stringify(rejected.failure).includes("fixture-private-key"));
    assert.deepEqual(yield* secrets.get("voice-transcription-api-key"), Option.some(tampered));

    yield* secrets.set("voice-transcription-api-key", stored.value);
    yield* secrets.remove("voice-transcription-wrapping-key");
    assert.equal((yield* store.read.pipe(Effect.result))._tag, "Failure");
    assert(Option.isNone(yield* secrets.get("voice-transcription-wrapping-key")));

    const legacy = new TextEncoder().encode("fixture-legacy-plaintext");
    yield* secrets.set("voice-transcription-api-key", legacy);
    assert.equal((yield* store.read.pipe(Effect.result))._tag, "Failure");
    assert.deepEqual(yield* secrets.get("voice-transcription-api-key"), Option.some(legacy));
    yield* store.write({ ...settings, apiKey: null });
    assert(Option.isNone(yield* secrets.get("voice-transcription-api-key")));
    yield* store.write({ ...settings, apiKey: "fixture-replacement-key" });
    assert.equal((yield* store.read).apiKey, "fixture-replacement-key");
    // Plaintext is rejected even when an existing wrapping key is available.
    yield* secrets.set("voice-transcription-api-key", legacy);
    assert.equal((yield* store.read.pipe(Effect.result))._tag, "Failure");
    assert.deepEqual(yield* secrets.get("voice-transcription-api-key"), Option.some(legacy));
  }).pipe(
    Effect.provide(
      ServerSecretStore.layer.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "voice-key-security-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
