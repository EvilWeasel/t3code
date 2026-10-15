import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { VoiceDictationState, useVoiceDictation } from "./useVoiceDictation";

const captured = vi.hoisted(() => ({
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
  expect(captured.transcribe).toHaveBeenLastCalledWith();
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

it("retries a reviewed recording with its captured provider after settings change", async () => {
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
  await expect(captured.input!.transcribe(audio, options)).resolves.toBe("original provider words");
  expect(original).toHaveBeenCalledWith(audio, options);
  expect(replacement).not.toHaveBeenCalled();
});
