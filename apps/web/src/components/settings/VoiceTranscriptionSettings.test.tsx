import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { VoiceTranscriptionSettings } from "@t3tools/contracts";

const state = vi.hoisted(() => ({ environmentId: "environment-a", request: vi.fn() }));
vi.mock("../../voice/voiceSettingsClient", () => ({ voiceSettingsRequest: state.request }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ target: { environmentId: state.environmentId } }),
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({}) }));
vi.mock("./settingsLayout", async () => {
  const { createElement } = await import("react");
  return {
    SettingsSection: ({ children }: { children: ReactNode }) =>
      createElement("section", null, children),
    SettingsRow: ({ children, description }: { children: ReactNode; description: ReactNode }) =>
      createElement("div", null, description, children),
  };
});
vi.mock("../ui/button", async () => {
  const { createElement } = await import("react");
  return { Button: (props: Record<string, unknown>) => createElement("button", props) };
});
vi.mock("../ui/input", async () => {
  const { createElement } = await import("react");
  return { Input: (props: Record<string, unknown>) => createElement("input", props) };
});
import { VoiceTranscriptionSettingsPanel } from "./VoiceTranscriptionSettings";

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
const settings = (model: string): typeof VoiceTranscriptionSettings.Type => ({
  provider: "codex-account",
  instanceId: null,
  model,
  apiKeyConfigured: false,
  apiKeySource: "none",
  available: true,
  message: "Configured",
  instances: [],
});

it("ignores a saved response from a host after the settings target changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.environmentId = "environment-a";
  let completeSave: (value: typeof VoiceTranscriptionSettings.Type) => void = () => {
    throw new Error("Save did not start");
  };
  state.request.mockImplementation((environmentId: string, update: unknown) =>
    update
      ? new Promise<typeof VoiceTranscriptionSettings.Type>((resolve) => {
          completeSave = resolve;
        })
      : Promise.resolve(settings(environmentId)),
  );
  await act(async () => {
    renderer = create(<VoiceTranscriptionSettingsPanel />);
  });
  act(() => {
    renderer!.root.findByType("button").props.onClick();
  });
  state.environmentId = "environment-b";
  await act(async () => {
    renderer!.update(<VoiceTranscriptionSettingsPanel />);
  });
  await act(async () => {
    completeSave(settings("stale-environment-a"));
  });
  expect(
    renderer!.root
      .findAllByType("input")
      .find((input) => input.props["aria-label"] === "Transcription model")?.props.value,
  ).toBe("environment-b");
  expect(renderer!.root.findByType("button").props.disabled).toBe(false);
});
