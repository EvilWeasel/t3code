import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { VoiceTranscriptionSettings } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  environmentId: "environment-a",
  scopeKind: "environment" as "environment" | "all" | "project" | "checkout",
  request: vi.fn(),
  editable: true,
}));
vi.mock("../../voice/voiceSettingsClient", () => ({ voiceSettingsRequest: state.request }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    target: { environmentId: state.environmentId },
    scope: {
      kind: state.scopeKind,
      environmentId: state.environmentId,
      label: `Host ${state.environmentId}`,
    },
  }),
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => state.editable }));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({}) }));
vi.mock("./settingsLayout", async () => {
  const { createElement } = await import("react");
  return {
    SettingsSection: ({ children }: { children: ReactNode }) =>
      createElement("section", null, children),
    SettingsRow: ({
      children,
      description,
      control,
    }: {
      children: ReactNode;
      description: ReactNode;
      control: ReactNode;
    }) => createElement("div", null, description, control, children),
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
// Replace only the select transport; exercise the panel's provider/account transitions.
vi.mock("../ui/select", async () => {
  const { createContext, useContext } = await import("react");
  const Context = createContext<{
    value: string;
    disabled: boolean;
    onValueChange: (value: string) => void;
  }>({ value: "", disabled: false, onValueChange: () => {} });
  return {
    Select: ({
      children,
      ...props
    }: {
      children: ReactNode;
      value: string;
      disabled: boolean;
      onValueChange: (value: string) => void;
    }) => <Context value={props}>{children}</Context>,
    SelectTrigger: ({ children: _children, ...props }: { children: ReactNode }) => {
      const context = useContext(Context);
      return (
        <select
          {...props}
          value={context.value}
          disabled={context.disabled}
          onChange={(event) => context.onValueChange(event.target.value)}
        />
      );
    },
    SelectValue: () => null,
    SelectPopup: ({ children }: { children: ReactNode }) => children,
    SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
      <option value={value}>{children}</option>
    ),
  };
});
import { VoiceTranscriptionSettingsPanel } from "./VoiceTranscriptionSettings";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.environmentId = "environment-a";
  state.scopeKind = "environment";
  state.editable = true;
  state.request.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
const settings = (model: string): typeof VoiceTranscriptionSettings.Type => ({
  provider: "openai-api",
  instanceId: null,
  model,
  apiKeyConfigured: false,
  supportsEncryptedApiKeyStorage: true,
  apiKeySource: "none",
  available: true,
  message: "Configured",
  instances: [],
});

it.each(["all", "project", "checkout"] as const)(
  "does not read or write a representative host in %s scope",
  async (kind) => {
    state.scopeKind = kind;
    await act(async () => {
      renderer = create(<VoiceTranscriptionSettingsPanel />);
    });
    expect(state.request).not.toHaveBeenCalled();
    expect(renderer!.root.findAllByType("button")).toHaveLength(0);
    expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain(
      "Select one environment",
    );
  },
);

it("names the explicit host and sends reads and changes only to that host", async () => {
  state.request.mockResolvedValue(settings("model-a"));
  await act(async () => {
    renderer = create(<VoiceTranscriptionSettingsPanel />);
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Host environment-a");
  await act(async () => {
    renderer!.root.findByType("button").props.onClick();
  });
  expect(state.request.mock.calls.map((call) => call[0])).toEqual([
    "environment-a",
    "environment-a",
  ]);
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

it("saves a write-only key, clears the input and preserves it on later settings saves", async () => {
  state.request.mockImplementation((_environmentId: string, update: unknown) =>
    Promise.resolve({
      ...settings("gpt-transcribe"),
      apiKeyConfigured: Boolean(update),
      apiKeySource: update ? "saved" : "none",
    }),
  );
  await act(async () => {
    renderer = create(<VoiceTranscriptionSettingsPanel />);
  });
  act(() => {
    renderer!.root.findByProps({ "aria-label": "Transcription API key" }).props.onChange({
      target: { value: "fixture-write-only-key" },
    });
  });
  const saveButton = () => renderer!.root.findAllByType("button").at(-1)!;
  await act(async () => saveButton().props.onClick());
  expect(state.request.mock.calls[1]?.[1]).toMatchObject({
    provider: "openai-api",
    apiKey: "fixture-write-only-key",
  });
  expect(renderer!.root.findByProps({ "aria-label": "Transcription API key" }).props.value).toBe(
    "",
  );
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("fixture-write-only-key");
  await act(async () => saveButton().props.onClick());
  expect(state.request.mock.calls[2]?.[1]).not.toHaveProperty("apiKey");
  await act(async () => renderer!.root.findAllByType("button")[0]!.props.onClick());
  expect(state.request.mock.calls[3]?.[1]).toHaveProperty("apiKey", null);
});

it("discards an unsaved API key when switching to account transcription", async () => {
  state.request.mockResolvedValue(settings("gpt-transcribe"));
  await act(async () => {
    renderer = create(<VoiceTranscriptionSettingsPanel />);
  });
  act(() => {
    renderer!.root.findByProps({ "aria-label": "Transcription API key" }).props.onChange({
      target: { value: "fixture-unsaved-key" },
    });
    renderer!.root
      .findAllByType("select")
      .find((control) => control.props["aria-label"] === "Voice transcription provider")!
      .props.onChange({
        target: { value: "codex-account" },
      });
  });
  expect(renderer!.root.findAllByProps({ "aria-label": "Transcription model" })).toHaveLength(0);
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(state.request.mock.calls[1]?.[1]).toMatchObject({ provider: "codex-account" });
  expect(state.request.mock.calls[1]?.[1]).not.toHaveProperty("apiKey");
  act(() => {
    renderer!.root
      .findAllByType("select")
      .find((control) => control.props["aria-label"] === "Voice transcription provider")!
      .props.onChange({
        target: { value: "openai-api" },
      });
  });
  expect(renderer!.root.findByProps({ "aria-label": "Transcription API key" }).props.value).toBe(
    "",
  );
});

it.each([undefined, false])(
  "does not submit a key to an environment without confirmed encrypted storage (%s)",
  async (support) => {
    const { supportsEncryptedApiKeyStorage: _support, ...oldSettings } = settings("legacy-model");
    const legacy =
      support === undefined
        ? oldSettings
        : { ...oldSettings, supportsEncryptedApiKeyStorage: support };
    state.request.mockResolvedValue(legacy);
    await act(async () => {
      renderer = create(<VoiceTranscriptionSettingsPanel />);
    });
    const keyInput = renderer!.root.findByProps({ "aria-label": "Transcription API key" });
    expect(keyInput.props.disabled).toBe(true);
    // Even a stale input callback cannot send a key after capability changes.
    act(() => {
      keyInput.props.onChange({ target: { value: "fixture-key-must-not-upload" } });
    });
    await act(async () => renderer!.root.findAllByType("button").at(-1)!.props.onClick());
    expect(state.request).toHaveBeenCalledOnce();
    expect(JSON.stringify(renderer!.toJSON())).toContain("Update this environment");
  },
);

it("can remove a legacy saved key without re-uploading it", async () => {
  const { supportsEncryptedApiKeyStorage: _support, ...oldSettings } = settings("legacy-model");
  const legacy = { ...oldSettings, apiKeyConfigured: true, apiKeySource: "saved" as const };
  state.request.mockResolvedValue(legacy);
  await act(async () => {
    renderer = create(<VoiceTranscriptionSettingsPanel />);
  });
  await act(async () => renderer!.root.findAllByType("button")[0]!.props.onClick());
  expect(state.request.mock.calls[1]?.[1]).toHaveProperty("apiKey", null);
});

it("preserves account choices and gates every setting while a save is in flight", async () => {
  let completeSave!: (value: typeof VoiceTranscriptionSettings.Type) => void;
  const value = {
    ...settings("gpt-transcribe"),
    provider: "codex-account" as const,
    instances: [
      { id: "codex-a", label: "Personal", authenticated: true },
      { id: "codex-b", label: "Work", authenticated: false },
    ],
  };
  state.request.mockImplementation((_host: string, update: unknown) =>
    update
      ? new Promise<typeof VoiceTranscriptionSettings.Type>((resolve) => {
          completeSave = resolve;
        })
      : Promise.resolve(value),
  );
  await act(async () => {
    renderer = create(<VoiceTranscriptionSettingsPanel />);
  });
  const account = renderer!.root
    .findAllByType("select")
    .find((control) => control.props["aria-label"] === "Transcription Codex account")!;
  act(() => account.props.onChange({ target: { value: "codex-b" } }));
  act(() => renderer!.root.findByType("button").props.onClick());
  expect(state.request.mock.calls[1]?.[1]).toMatchObject({
    provider: "codex-account",
    instanceId: "codex-b",
  });
  expect(renderer!.root.findAllByType("select").every((control) => control.props.disabled)).toBe(
    true,
  );
  expect(renderer!.root.findByType("button").props.disabled).toBe(true);
  await act(async () => completeSave(value));
  expect(renderer!.root.findByType("button").props.disabled).toBe(false);
});

it("keeps keys masked and displays a recoverable save error without clearing unsaved input", async () => {
  state.request
    .mockResolvedValueOnce(settings("gpt-transcribe"))
    .mockRejectedValueOnce(new Error("fixture backend failure"));
  await act(async () => {
    renderer = create(<VoiceTranscriptionSettingsPanel />);
  });
  act(() =>
    renderer!.root
      .findByProps({ "aria-label": "Transcription API key" })
      .props.onChange({ target: { value: "fixture-secret" } }),
  );
  await act(async () => renderer!.root.findByType("button").props.onClick());
  const input = renderer!.root.findByProps({ "aria-label": "Transcription API key" });
  expect(input.props.type).toBe("password");
  expect(input.props.value).toBe("fixture-secret");
  expect(renderer!.root.findByProps({ role: "status" }).children.join("")).toContain(
    "Could not save voice settings",
  );
  expect(renderer!.root.findByType("button").props.disabled).toBe(false);
});

it("does not allow changes through a read-only connection", async () => {
  state.editable = false;
  state.request.mockResolvedValue(settings("gpt-transcribe"));
  await act(async () => {
    renderer = create(<VoiceTranscriptionSettingsPanel />);
  });
  expect(renderer!.root.findAllByType("input").every((control) => control.props.disabled)).toBe(
    true,
  );
  expect(renderer!.root.findByType("select").props.disabled).toBe(true);
  expect(renderer!.root.findByType("button").props.disabled).toBe(true);
  await act(async () => renderer!.root.findByType("button").props.onClick());
  expect(state.request).toHaveBeenCalledOnce();
});
