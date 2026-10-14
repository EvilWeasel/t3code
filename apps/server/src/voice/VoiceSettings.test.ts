import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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
    yield* store.write({ ...settings, model: "another-model" });
    assert.equal((yield* store.read).apiKey, "fixture-private-key");
    yield* store.write({ ...settings, apiKey: "" });
    assert.equal((yield* store.read).apiKey, "fixture-private-key");
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
