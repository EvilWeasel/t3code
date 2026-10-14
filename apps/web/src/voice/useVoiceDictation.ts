import { useCallback, useEffect, useRef, useState } from "react";
import { acquireMicrophoneOwnership } from "@t3tools/client-runtime/live-voice";

export type VoiceDictationState =
  | { readonly phase: "idle" }
  | { readonly phase: "recording" }
  | { readonly phase: "review"; readonly audioUrl: string; readonly audioType: string }
  | { readonly phase: "transcribing"; readonly audioUrl: string }
  | { readonly phase: "error"; readonly message: string; readonly audioUrl?: string };

export type VoiceDictationTranscriber = (
  audio: Blob,
  options: { readonly signal: AbortSignal },
) => Promise<string>;

export class VoiceDictationServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceDictationServiceError";
  }
}

const MAX_RECORDING_DURATION_MS = 5 * 60 * 1000;
type ActiveCapture = {
  generation: number;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  chunks: Blob[];
  mediaRequestPending: boolean;
  releaseMicrophone: () => void;
  timeout?: ReturnType<typeof setTimeout>;
};

/** Browser capture and review lifecycle. Transcription is injected so transport/auth stays separate. */
export function useVoiceDictation(input: {
  readonly transcribe: VoiceDictationTranscriber | null;
  readonly onTranscript: (transcript: string) => void;
}) {
  const [state, setState] = useState<VoiceDictationState>({ phase: "idle" });
  const captureRef = useRef<ActiveCapture | null>(null);
  const startingRef = useRef(false);
  const audioRef = useRef<Blob | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const releaseCapture = useCallback((capture: ActiveCapture) => {
    if (capture.timeout !== undefined) clearTimeout(capture.timeout);
    for (const track of capture.stream?.getTracks() ?? []) track.stop();
    // Keep the token through a cancelled, nonabortable permission request.
    if (!capture.mediaRequestPending) capture.releaseMicrophone();
    if (captureRef.current === capture) captureRef.current = null;
  }, []);

  const clearAudio = useCallback(() => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    audioRef.current = null;
  }, []);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    const capture = captureRef.current;
    const recorder = capture?.recorder;
    if (recorder?.state === "recording") recorder.stop();
    if (capture) releaseCapture(capture);
    startingRef.current = false;
    clearAudio();
    setState({ phase: "idle" });
  }, [clearAudio, releaseCapture]);

  const start = useCallback(async () => {
    if (
      startingRef.current ||
      captureRef.current !== null ||
      (state.phase !== "idle" && state.phase !== "error")
    )
      return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setState({ phase: "error", message: "Audio recording is not supported in this browser." });
      return;
    }
    const releaseMicrophone = acquireMicrophoneOwnership();
    if (!releaseMicrophone) {
      setState({
        phase: "error",
        message: "Another microphone session is active. End it before recording.",
        ...(audioUrlRef.current ? { audioUrl: audioUrlRef.current } : {}),
      });
      return;
    }
    const generation = ++generationRef.current;
    startingRef.current = true;
    const capture: ActiveCapture = {
      generation,
      chunks: [],
      mediaRequestPending: true,
      releaseMicrophone,
    };
    captureRef.current = capture;
    clearAudio();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      capture.mediaRequestPending = false;
      capture.stream = stream;
      startingRef.current = false;
      if (generationRef.current !== generation || captureRef.current !== capture) {
        for (const track of stream.getTracks()) track.stop();
        capture.releaseMicrophone();
        return;
      }
      const recorder = new MediaRecorder(stream);
      capture.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (
          captureRef.current === capture &&
          generationRef.current === generation &&
          event.data.size > 0
        )
          capture.chunks.push(event.data);
      };
      recorder.onstop = () => {
        if (generationRef.current !== generation || captureRef.current !== capture) {
          releaseCapture(capture);
          return;
        }
        releaseCapture(capture);
        const audio = new Blob(capture.chunks, { type: recorder.mimeType || "audio/webm" });
        if (audio.size === 0) {
          setState({ phase: "error", message: "The recording was empty. Try again." });
          return;
        }
        const audioUrl = URL.createObjectURL(audio);
        audioRef.current = audio;
        audioUrlRef.current = audioUrl;
        setState({ phase: "review", audioUrl, audioType: audio.type });
      };
      recorder.onerror = () => {
        if (generationRef.current !== generation || captureRef.current !== capture) return;
        releaseCapture(capture);
        setState({ phase: "error", message: "The recording could not be completed." });
      };
      recorder.start();
      capture.timeout = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, MAX_RECORDING_DURATION_MS);
      setState({ phase: "recording" });
    } catch {
      capture.mediaRequestPending = false;
      startingRef.current = false;
      if (generationRef.current !== generation || captureRef.current !== capture) {
        capture.releaseMicrophone();
        return;
      }
      releaseCapture(capture);
      setState({
        phase: "error",
        message: "Microphone access is unavailable. Check browser permissions and try again.",
      });
    }
  }, [clearAudio, releaseCapture, state.phase]);

  const stop = useCallback(() => {
    if (captureRef.current?.recorder?.state === "recording") captureRef.current.recorder.stop();
  }, []);

  const transcribe = useCallback(async () => {
    const audio = audioRef.current;
    const audioUrl = audioUrlRef.current;
    if (
      !audio ||
      !audioUrl ||
      !input.transcribe ||
      (state.phase !== "review" && state.phase !== "error")
    )
      return;
    const generation = ++generationRef.current;
    const abortController = new AbortController();
    abortRef.current = abortController;
    setState({ phase: "transcribing", audioUrl });
    try {
      const transcript = (await input.transcribe(audio, { signal: abortController.signal })).trim();
      if (generationRef.current !== generation || abortController.signal.aborted) return;
      if (!transcript) {
        setState({
          phase: "error",
          message: "No speech was detected. You can record again.",
          audioUrl,
        });
        return;
      }
      input.onTranscript(transcript);
      clearAudio();
      setState({ phase: "idle" });
    } catch (error) {
      if (generationRef.current !== generation || abortController.signal.aborted) return;
      setState({
        phase: "error",
        message:
          error instanceof VoiceDictationServiceError
            ? error.message
            : "Transcription failed. Your recording is still available to retry.",
        audioUrl,
      });
    } finally {
      if (abortRef.current === abortController) abortRef.current = null;
    }
  }, [clearAudio, input, state.phase]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      abortRef.current?.abort();
      const capture = captureRef.current;
      if (capture) releaseCapture(capture);
      clearAudio();
    },
    [clearAudio, releaseCapture],
  );

  return { state, start, stop, transcribe, cancel } as const;
}
