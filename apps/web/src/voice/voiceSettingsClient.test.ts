import { EnvironmentId, EnvironmentScopeRequiredError } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  prepared: undefined as PreparedConnection | undefined,
  failure: undefined as unknown,
  calls: [] as unknown[],
}));

vi.mock("../connection/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  const Layer = await import("effect/Layer");
  return { connectionAtomRuntime: Atom.runtime(Layer.empty) };
});
vi.mock("../state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  return {
    environmentSession: {
      preparedConnectionValueAtom: () => Atom.make(Option.fromNullable(fixture.prepared)),
    },
  };
});
vi.mock("@t3tools/client-runtime/state/voice-transcription", async () => {
  const Effect = await import("effect/Effect");
  return {
    requestEnvironmentVoiceSettings: (input: unknown) => {
      fixture.calls.push(input);
      return Effect.fail(fixture.failure);
    },
  };
});

import { voiceSettingsErrorMessage, voiceSettingsRequest } from "./voiceSettingsClient";

beforeEach(() => {
  fixture.prepared = undefined;
  fixture.failure = undefined;
  fixture.calls = [];
});

it("keeps the typed permission failure across the actual Atom/Promise boundary", async () => {
  const environmentId = EnvironmentId.make("settings-destination");
  // Only the prepared identity is read before the injected transport boundary.
  fixture.prepared = { environmentId } as PreparedConnection;
  const denied = new EnvironmentScopeRequiredError({
    code: "insufficient_scope",
    requiredScope: "orchestration:operate",
    requiredPermission: "settings:write",
    traceId: "settings-denial",
  });
  fixture.failure = denied;
  await expect(voiceSettingsRequest(environmentId)).rejects.toBe(denied);
  expect(fixture.calls).toHaveLength(1);
  expect(voiceSettingsErrorMessage(denied)).toContain("settings:write");
});

it("never invokes the transport with a disconnected or mismatched destination", async () => {
  const environmentId = EnvironmentId.make("selected-destination");
  await expect(voiceSettingsRequest(environmentId)).rejects.toMatchObject({
    _tag: "VoiceSettingsUnavailable",
  });
  fixture.prepared = {
    environmentId: EnvironmentId.make("another-destination"),
  } as PreparedConnection;
  await expect(
    voiceSettingsRequest(environmentId, {
      provider: "openai-api",
      instanceId: null,
      model: "gpt-transcribe",
      apiKey: "synthetic-key",
    }),
  ).rejects.toMatchObject({ _tag: "VoiceSettingsUnavailable" });
  expect(fixture.calls).toHaveLength(0);
});

it("uses bounded static copy for typed errors and never exposes private error data", () => {
  for (const tag of [
    "EnvironmentScopeRequiredError",
    "EnvironmentAuthInvalidError",
    "VoiceSettingsUnavailable",
    "VoiceSettingsStorageUnavailable",
    "RemoteEnvironmentAuthTimeoutError",
    "RemoteEnvironmentAuthInvalidJsonError",
    "EnvironmentInternalError",
    "UnknownFailure",
  ]) {
    const message = voiceSettingsErrorMessage({
      _tag: tag,
      message: "private-provider-secret",
      body: "private-provider-secret",
      cause: new Error("private-provider-secret"),
    });
    expect(message.length).toBeGreaterThan(10);
    expect(message).not.toContain("private-provider-secret");
  }
  expect(voiceSettingsErrorMessage(new Error("private-provider-secret"))).not.toContain(
    "private-provider-secret",
  );
});
