import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { VoiceDictationState, useVoiceDictation } from "./useVoiceDictation";

const captured = vi.hoisted(() => ({
  useActualHook: false,
  input: null as Parameters<typeof useVoiceDictation>[0] | null,
  state: { phase: "idle" } as VoiceDictationState,
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  transcribe: vi.fn(),
}));
vi.mock("./useVoiceDictation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useVoiceDictation")>();
  return {
    ...actual,
    useVoiceDictation: (input: Parameters<typeof useVoiceDictation>[0]) => {
      captured.input = input;
      if (captured.useActualHook) return actual.useVoiceDictation(input);
      return {
        state: captured.state,
        start: captured.start,
        stop: captured.stop,
        cancel: captured.cancel,
        transcribe: captured.transcribe,
      };
    },
  };
});
vi.mock("~/components/ui/button", async () => {
  const { createElement } = await import("react");
  return { Button: (props: Record<string, unknown>) => createElement("button", props) };
});
vi.mock("~/components/ui/popover", () => ({
  Popover: ({ children }: { children: import("react").ReactNode }) => children,
  PopoverTrigger: ({ children }: { children: import("react").ReactNode }) => (
    <button>{children}</button>
  ),
  PopoverPopup: ({ children }: { children: import("react").ReactNode }) => (
    <section>{children}</section>
  ),
  PopoverTitle: ({ children }: { children: import("react").ReactNode }) => <h2>{children}</h2>,
}));
import { VoiceDictationControl } from "./VoiceDictationControl";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  captured.useActualHook = false;
  captured.state = { phase: "idle" };
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("rejects transcript delivery after the selected draft changes so the hook retains audio", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let currentTarget = "environment-a:draft";
  const insert = vi.fn(() => true);
  act(() => {
    renderer = create(
      <VoiceDictationControl
        targetKey={currentTarget}
        currentTargetKey={() => currentTarget}
        transcribe={async () => "words"}
        onTranscript={insert}
      />,
    );
  });
  currentTarget = "environment-b:draft";
  expect(() => captured.input!.onTranscript("words")).toThrow("Return to the original draft");
  expect(insert).not.toHaveBeenCalled();
  currentTarget = "environment-a:draft";
  captured.input!.onTranscript("words");
  expect(insert).toHaveBeenCalledWith("words", "environment-a:draft");
  insert.mockReturnValueOnce(false);
  expect(() => captured.input!.onTranscript("words")).toThrow("could not be inserted");
});

function mountRecording(
  transcribe: Parameters<typeof VoiceDictationControl>[0]["transcribe"] = async () => "words",
) {
  act(() => {
    renderer = create(
      <VoiceDictationControl
        targetKey="draft-a"
        currentTargetKey={() => "draft-a"}
        transcribe={transcribe}
        onTranscript={() => true}
        onSend={async () => true}
      />,
    );
  });
}

it("keeps a failed recording available for review, insertion, sending and discard", async () => {
  captured.state = {
    phase: "error",
    audioUrl: "blob:fixture-recording",
    message: "Provider unavailable. ".repeat(80),
  };
  mountRecording();
  expect(renderer!.root.findByType("audio").props.src).toBe("blob:fixture-recording");
  expect(renderer!.root.findByType("details").props.open).not.toBe(true);
  expect(renderer!.root.findByProps({ role: "status" }).children.join("")).not.toContain(
    "Provider unavailable",
  );
  expect(renderer!.root.findByType("details").findByType("p").children.join("")).toContain(
    "Provider unavailable",
  );
  const buttons = renderer!.root.findAllByType("button");
  await act(async () =>
    buttons.find((button) => button.children.includes("Insert text"))!.props.onClick(),
  );
  expect(captured.transcribe).toHaveBeenLastCalledWith("insert");
  await act(async () =>
    buttons.find((button) => button.children.includes("Send"))!.props.onClick(),
  );
  expect(captured.transcribe).toHaveBeenLastCalledWith("send");
  act(() => renderer!.root.findByProps({ "aria-label": "Discard recording" }).props.onClick());
  expect(captured.cancel).toHaveBeenCalledOnce();
});

it.each(["transcribing", "review"] as const)(
  "gates %s actions without losing audio or discard",
  (phase) => {
    captured.state =
      phase === "review"
        ? { phase, audioUrl: "blob:fixture-recording", audioType: "audio/webm" }
        : { phase, audioUrl: "blob:fixture-recording" };
    mountRecording(phase === "review" ? null : async () => "words");
    expect(renderer!.root.findByType("audio").props.src).toBe("blob:fixture-recording");
    const actions = renderer!.root
      .findAllByType("button")
      .filter(
        (button) => button.children.includes("Insert text") || button.children.includes("Send"),
      );
    expect(actions).toHaveLength(2);
    expect(actions.every((button) => button.props.disabled)).toBe(true);
    expect(
      renderer!.root.findByProps({ "aria-label": "Discard recording" }).props.disabled,
    ).not.toBe(true);
  },
);

it("keeps a no-audio error in a disclosure and allows recording again", () => {
  captured.state = { phase: "error", message: "Microphone permission unavailable" };
  mountRecording();
  expect(renderer!.root.findAllByType("audio")).toHaveLength(0);
  expect(renderer!.root.findByType("details").findByType("p").children.join("")).toBe(
    "Microphone permission unavailable",
  );
  act(() => renderer!.root.findByProps({ "aria-label": "Record voice message" }).props.onClick());
  expect(captured.start).toHaveBeenCalledOnce();
});

it("keeps the captured callback until an explicit current-settings retry", async () => {
  captured.state = { phase: "review", audioUrl: "blob:fixture-recording", audioType: "audio/webm" };
  const original = vi.fn(async () => "original provider words");
  const replacement = vi.fn(async () => "replacement provider words");
  mountRecording(original);
  act(() =>
    renderer!.update(
      <VoiceDictationControl
        targetKey="draft-a"
        currentTargetKey={() => "draft-a"}
        transcribe={replacement}
        onTranscript={() => true}
      />,
    ),
  );
  expect(renderer!.root.findByType("audio").props.src).toBe("blob:fixture-recording");
  const audio = new Blob(["fixture audio"], { type: "audio/webm" });
  const options = { signal: new AbortController().signal };
  const transcribe = captured.input?.transcribe;
  if (!transcribe) throw new Error("Expected the reviewed recording to retain its transcriber");
  await expect(transcribe(audio, options)).resolves.toBe("original provider words");
  expect(original).toHaveBeenCalledWith(audio, options);
  expect(replacement).not.toHaveBeenCalled();
});

class SyntheticMediaRecorder {
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly stream: MediaStream) {}
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state !== "recording") return;
    this.ondataavailable?.({ data: new Blob(["synthetic fixture"]) } as BlobEvent);
    this.state = "inactive";
    this.onstop?.();
  }
}

function installSyntheticCapture() {
  captured.useActualHook = true;
  const getUserMedia = vi.fn(
    async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
  );
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", SyntheticMediaRecorder);
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:synthetic-retry"),
    revokeObjectURL: vi.fn(),
  });
  return getUserMedia;
}

function action(label: string) {
  return renderer!.root
    .findAllByType("button")
    .find((button) => button.props["aria-label"] === label || button.children.includes(label))!;
}

it("retries the same retained Blob after a missing callback becomes available", async () => {
  const getUserMedia = installSyntheticCapture();
  const insert = vi.fn(() => true);
  const targetKey = "control:missing-callback-retry";
  const currentTargetKey = () => targetKey;
  await act(async () => {
    renderer = create(
      <VoiceDictationControl
        targetKey={targetKey}
        currentTargetKey={currentTargetKey}
        transcribe={null}
        onTranscript={insert}
      />,
    );
  });
  await act(async () => action("Record voice message").props.onClick());
  await act(async () => action("Stop recording").props.onClick());
  const { readRecordingDraft } = await import("./recordingDraftStore");
  const originalAudio = (await readRecordingDraft(targetKey))!.audio;
  const replacement = vi.fn(async () => "recovered words");
  await act(async () =>
    renderer!.update(
      <VoiceDictationControl
        targetKey={targetKey}
        currentTargetKey={currentTargetKey}
        transcribe={replacement}
        onTranscript={insert}
      />,
    ),
  );
  expect(replacement).not.toHaveBeenCalled();
  expect(renderer!.root.findByType("audio").props.src).toBe("blob:synthetic-retry");
  await act(async () => action("Insert text").props.onClick());
  expect(replacement).toHaveBeenCalledExactlyOnceWith(
    originalAudio,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(insert).toHaveBeenCalledExactlyOnceWith("recovered words", targetKey);
  expect(getUserMedia).toHaveBeenCalledOnce();
});

it("does not replace an in-flight callback or automatically resubmit after settings change", async () => {
  const getUserMedia = installSyntheticCapture();
  const targetKey = "control:pending-settings-retry";
  const currentTargetKey = () => targetKey;
  let rejectOriginal!: (error: Error) => void;
  const original = vi.fn(
    (_audio: Blob, _options: { signal: AbortSignal }) =>
      new Promise<string>((_resolve, reject) => {
        rejectOriginal = reject;
      }),
  );
  const replacement = vi.fn(async () => "new settings words");
  const insert = vi.fn(() => true);
  await act(async () => {
    renderer = create(
      <VoiceDictationControl
        targetKey={targetKey}
        currentTargetKey={currentTargetKey}
        transcribe={original}
        onTranscript={insert}
      />,
    );
  });
  await act(async () => action("Record voice message").props.onClick());
  await act(async () => action("Stop recording").props.onClick());
  const originalAudio = original.mock.calls[0]![0];
  await act(async () =>
    renderer!.update(
      <VoiceDictationControl
        targetKey={targetKey}
        currentTargetKey={currentTargetKey}
        transcribe={replacement}
        onTranscript={insert}
      />,
    ),
  );
  expect(replacement).not.toHaveBeenCalled();
  expect(action("Insert text").props.disabled).toBe(true);
  await act(async () => rejectOriginal(new Error("synthetic provider refusal")));
  expect(replacement).not.toHaveBeenCalled();
  await act(async () => action("Insert text").props.onClick());
  expect(replacement).toHaveBeenCalledExactlyOnceWith(
    originalAudio,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(original).toHaveBeenCalledOnce();
  expect(insert).toHaveBeenCalledExactlyOnceWith("new settings words", targetKey);
  expect(getUserMedia).toHaveBeenCalledOnce();
});

it("ignores a stale retry handler after the selected draft changes", () => {
  captured.state = { phase: "review", audioUrl: "blob:fixture-recording", audioType: "audio/webm" };
  let currentTarget = "draft-a";
  const transcribe = vi.fn(async () => "words");
  const insert = vi.fn(() => true);
  act(() => {
    renderer = create(
      <VoiceDictationControl
        targetKey={currentTarget}
        currentTargetKey={() => currentTarget}
        transcribe={transcribe}
        onTranscript={insert}
      />,
    );
  });
  const staleRetry = action("Insert text").props.onClick;
  currentTarget = "draft-b";
  act(() =>
    renderer!.update(
      <VoiceDictationControl
        targetKey={currentTarget}
        currentTargetKey={() => currentTarget}
        transcribe={transcribe}
        onTranscript={insert}
      />,
    ),
  );
  act(() => staleRetry());
  expect(captured.transcribe).not.toHaveBeenCalled();
  expect(transcribe).not.toHaveBeenCalled();
  expect(insert).not.toHaveBeenCalled();
});
