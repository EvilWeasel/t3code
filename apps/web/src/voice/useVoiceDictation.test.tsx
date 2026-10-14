import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  useVoiceDictation,
  VoiceDictationServiceError,
  type VoiceDictationTranscriber,
} from "./useVoiceDictation";
import { acquireMicrophoneOwnership } from "@t3tools/client-runtime/live-voice";
import { readRecordingDraft } from "./recordingDraftStore";

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

function Probe({
  transcribe,
  targetKey,
}: {
  transcribe: VoiceDictationTranscriber | null;
  targetKey?: string | undefined;
}) {
  latest = useVoiceDictation({ transcribe, onTranscript, ...(targetKey ? { targetKey } : {}) });
  return null;
}

function render(transcribe: VoiceDictationTranscriber | null, targetKey?: string) {
  act(() => {
    if (renderer) renderer.update(<Probe transcribe={transcribe} targetKey={targetKey} />);
    else renderer = create(<Probe transcribe={transcribe} targetKey={targetKey} />);
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
  it("restores a failed recording after Settings navigation and retries after configuration", async () => {
    const targetKey = "voice-recovery:environment:thread";
    render(async () => {
      throw new VoiceDictationServiceError("Provider unavailable");
    }, targetKey);
    await startAndStop();
    await act(async () => latest?.transcribe());
    expect(latest?.state.phase).toBe("error");
    act(() => {
      renderer?.unmount();
      renderer = null;
    });
    expect((await readRecordingDraft(targetKey))?.audio.size).toBeGreaterThan(0);
    const retry = vi.fn(async () => "recovered words");
    await act(async () => render(retry, targetKey));
    expect(latest?.state).toMatchObject({ phase: "error", audioUrl: "blob:voice-review" });
    await act(async () => latest?.transcribe());
    expect(onTranscript).toHaveBeenCalledWith("recovered words");
    expect(await readRecordingDraft(targetKey)).toBeNull();
  });

  it("keeps recordings on their original draft across target switches", async () => {
    const transcribe = vi.fn(async () => "words");
    render(transcribe, "voice-switch:environment-a:thread");
    await startAndStop();
    await act(async () => render(transcribe, "voice-switch:environment-b:thread"));
    expect(latest?.state.phase).toBe("idle");
    await act(async () => render(transcribe, "voice-switch:environment-a:thread"));
    expect(latest?.state.phase).toBe("review");
    act(() => latest?.cancel());
    expect(await readRecordingDraft("voice-switch:environment-a:thread")).toBeNull();
  });

  it("keeps the audio when transcript insertion fails", async () => {
    const key = "voice-insertion:environment:thread";
    onTranscript.mockImplementationOnce(() => {
      throw new Error("Draft changed");
    });
    render(async () => "words", key);
    await startAndStop();
    await act(async () => latest?.transcribe());
    expect((await readRecordingDraft(key))?.audio.size).toBeGreaterThan(0);
    await act(async () => latest?.transcribe());
    expect(await readRecordingDraft(key)).toBeNull();
  });
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
    const liveCanStartDuringReview = acquireMicrophoneOwnership();
    expect(liveCanStartDuringReview).not.toBeNull();
    liveCanStartDuringReview?.();

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

  it("shows a validated provider failure message and keeps the recording available to retry", async () => {
    const transcribe = vi
      .fn<VoiceDictationTranscriber>()
      .mockRejectedValue(
        new VoiceDictationServiceError("The transcription provider denied this request."),
      );
    render(transcribe);
    await startAndStop();

    await act(async () => latest?.transcribe());
    expect(latest?.state).toEqual({
      phase: "error",
      message: "The transcription provider denied this request.",
      audioUrl: "blob:voice-review",
    });
    expect(revokedUrls).toEqual([]);
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

  it("does not request another stream after cancellation until the pending permission request settles", async () => {
    let grantFirst!: (stream: MediaStream) => void;
    let grantSecond!: (stream: MediaStream) => void;
    const getUserMedia = vi
      .fn()
      .mockImplementationOnce(() => new Promise<MediaStream>((resolve) => (grantFirst = resolve)))
      .mockImplementationOnce(() => new Promise<MediaStream>((resolve) => (grantSecond = resolve)));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    render(async () => "unused");

    let first: Promise<void> | undefined;
    act(() => {
      first = latest?.start();
    });
    act(() => latest?.cancel());
    await act(async () => latest?.start());
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(latest?.state).toMatchObject({ phase: "error" });

    const lateTrackStop = vi.fn();
    await act(async () => {
      grantFirst({ getTracks: () => [{ stop: lateTrackStop }] } as unknown as MediaStream);
      await first;
    });
    expect(lateTrackStop).toHaveBeenCalledOnce();

    let second: Promise<void> | undefined;
    act(() => {
      second = latest?.start();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    await act(async () => {
      grantSecond({ getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream);
      await second;
    });
    expect(latest?.state.phase).toBe("recording");
    act(() => latest?.cancel());
  });

  it("does not start dictation while Live owns the renderer microphone", async () => {
    const releaseLive = acquireMicrophoneOwnership();
    expect(releaseLive).not.toBeNull();
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);
    render(async () => "unused");

    await act(async () => latest?.start());

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(latest?.state).toEqual({
      phase: "error",
      message: "Another microphone session is active. End it before recording.",
    });
    const stillOwned = acquireMicrophoneOwnership();
    expect(stillOwned).toBeNull();
    stillOwned?.();
    releaseLive?.();
    await act(async () => latest?.start());
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(latest?.state.phase).toBe("recording");
    act(() => latest?.cancel());
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
    const releaseLive = acquireMicrophoneOwnership();
    expect(releaseLive).not.toBeNull();
    releaseLive?.();
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
