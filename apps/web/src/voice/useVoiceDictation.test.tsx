import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useVoiceDictation, type VoiceDictationTranscriber } from "./useVoiceDictation";

class FakeMediaRecorder {
  static instance: FakeMediaRecorder | null = null;
  state: RecordingState = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly stream: MediaStream) {
    FakeMediaRecorder.instance = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state !== "recording") return;
    this.ondataavailable?.({ data: new Blob(["audio"]) } as BlobEvent);
    this.state = "inactive";
    this.onstop?.();
  }
}

let renderer: ReactTestRenderer | null = null;
let latest: ReturnType<typeof useVoiceDictation> | null = null;
let onTranscript: ReturnType<typeof vi.fn<(transcript: string) => void>>;
let trackStop: ReturnType<typeof vi.fn>;
let revokedUrls: string[];

function Probe({ transcribe }: { transcribe: VoiceDictationTranscriber | null }) {
  latest = useVoiceDictation({ transcribe, onTranscript });
  return null;
}

function render(transcribe: VoiceDictationTranscriber | null) {
  act(() => {
    if (renderer) renderer.update(<Probe transcribe={transcribe} />);
    else renderer = create(<Probe transcribe={transcribe} />);
  });
}

async function startAndStop() {
  await act(async () => latest?.start());
  expect(latest?.state.phase).toBe("recording");
  act(() => latest?.stop());
  expect(latest?.state.phase).toBe("review");
}

beforeEach(() => {
  onTranscript = vi.fn();
  trackStop = vi.fn();
  revokedUrls = [];
  FakeMediaRecorder.instance = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(
        async () => ({ getTracks: () => [{ stop: trackStop }] }) as unknown as MediaStream,
      ),
    },
  });
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:voice-review"),
    revokeObjectURL: vi.fn((url: string) => revokedUrls.push(url)),
  });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  latest = null;
  vi.unstubAllGlobals();
});

describe("useVoiceDictation", () => {
  it("keeps the recording for playback review, then inserts only after explicit transcription", async () => {
    const transcribe = vi.fn(async () => "  recognized words  ");
    render(transcribe);
    await startAndStop();

    expect(latest?.state).toEqual({
      phase: "review",
      audioUrl: "blob:voice-review",
      audioType: "audio/webm",
    });
    expect(trackStop).toHaveBeenCalledOnce();
    expect(transcribe).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();

    await act(async () => latest?.transcribe());
    expect(transcribe).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("recognized words");
    expect(latest?.state.phase).toBe("idle");
    expect(revokedUrls).toEqual(["blob:voice-review"]);
  });

  it("retains review audio after failure and permits retry", async () => {
    const transcribe = vi
      .fn<VoiceDictationTranscriber>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("retry worked");
    render(transcribe);
    await startAndStop();

    await act(async () => latest?.transcribe());
    expect(latest?.state).toEqual({
      phase: "error",
      message: "Transcription failed. Your recording is still available to retry.",
      audioUrl: "blob:voice-review",
    });
    expect(revokedUrls).toEqual([]);

    await act(async () => latest?.transcribe());
    expect(onTranscript).toHaveBeenCalledWith("retry worked");
    expect(revokedUrls).toEqual(["blob:voice-review"]);
  });

  it("cancels in-flight transcription and ignores a late result", async () => {
    let finish!: (value: string) => void;
    const transcribe = vi.fn<VoiceDictationTranscriber>(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    render(transcribe);
    await startAndStop();

    let transcription: Promise<void> | undefined;
    act(() => {
      transcription = latest?.transcribe();
    });
    const signal = transcribe.mock.calls[0]?.[1].signal;
    act(() => latest?.cancel());
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish("too late");
      await transcription;
    });
    expect(onTranscript).not.toHaveBeenCalled();
    expect(latest?.state.phase).toBe("idle");
    expect(revokedUrls).toEqual(["blob:voice-review"]);
  });

  it("stops tracks if permission resolves after cancellation", async () => {
    let grant!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    render(async () => "unused");
    let start: Promise<void> | undefined;
    act(() => {
      start = latest?.start();
    });
    act(() => latest?.cancel());
    const lateStop = vi.fn();
    await act(async () => {
      grant({ getTracks: () => [{ stop: lateStop }] } as unknown as MediaStream);
      await start;
    });
    expect(lateStop).toHaveBeenCalledOnce();
    expect(latest?.state.phase).toBe("idle");
    expect(FakeMediaRecorder.instance).toBeNull();
  });

  it("does not open a second stream while microphone permission is pending", async () => {
    let grant!: (stream: MediaStream) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          grant = resolve;
        }),
    );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    render(async () => "unused");
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => {
      first = latest?.start();
      second = latest?.start();
    });
    expect(getUserMedia).toHaveBeenCalledOnce();
    await act(async () => {
      grant({ getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream);
      await Promise.all([first, second]);
    });
    expect(FakeMediaRecorder.instance).not.toBeNull();
    expect(latest?.state.phase).toBe("recording");
  });

  it("ignores a rejected permission request after cancellation", async () => {
    let reject!: (error: Error) => void;
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>((_resolve, fail) => {
              reject = fail;
            }),
        ),
      },
    });
    render(async () => "unused");
    let start: Promise<void> | undefined;
    act(() => {
      start = latest?.start();
    });
    act(() => latest?.cancel());
    await act(async () => {
      reject(new Error("permission denied"));
      await start;
    });
    expect(latest?.state.phase).toBe("idle");
  });

  it("does not let a late stop callback from a cancelled recorder affect a new capture", async () => {
    render(async () => "unused");
    await act(async () => latest?.start());
    const oldRecorder = FakeMediaRecorder.instance!;
    const oldOnStop = oldRecorder.onstop!;
    const oldOnData = oldRecorder.ondataavailable!;
    act(() => latest?.cancel());
    await act(async () => latest?.start());
    const currentRecorder = FakeMediaRecorder.instance!;

    act(() => {
      oldOnData({ data: new Blob(["stale"]) } as BlobEvent);
      oldOnStop();
    });
    expect(currentRecorder.state).toBe("recording");
    expect(latest?.state.phase).toBe("recording");
    act(() => latest?.stop());
    expect(latest?.state.phase).toBe("review");
  });
});
