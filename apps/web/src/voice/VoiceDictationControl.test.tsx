import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { useVoiceDictation } from "./useVoiceDictation";

const captured = vi.hoisted(() => ({
  input: null as Parameters<typeof useVoiceDictation>[0] | null,
}));
vi.mock("./useVoiceDictation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useVoiceDictation")>();
  return {
    ...actual,
    useVoiceDictation: (input: Parameters<typeof useVoiceDictation>[0]) => {
      captured.input = input;
      return {
        state: { phase: "idle" },
        start: vi.fn(),
        stop: vi.fn(),
        cancel: vi.fn(),
        transcribe: vi.fn(),
      };
    },
  };
});
vi.mock("~/components/ui/button", async () => {
  const { createElement } = await import("react");
  return { Button: (props: Record<string, unknown>) => createElement("button", props) };
});
import { VoiceDictationControl } from "./VoiceDictationControl";

let renderer: ReactTestRenderer | undefined;
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
