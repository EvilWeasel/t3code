import { useCallback, useEffect, useRef, useState } from "react";
import { acquireMicrophoneOwnership } from "@t3tools/client-runtime/live-voice";
import {
  MAX_RECORDING_BYTES,
  readRecordingDraft,
  writeRecordingDraft,
} from "./recordingDraftStore";

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

// A remounted composer can await the same in-flight send without dispatching again.
const pendingSends = new WeakMap<Blob, Promise<boolean>>();

const MAX_RECORDING_DURATION_MS = 5 * 60 * 1000;
export type VoiceDictationDelivery = "insert" | "send" | "review";

type ActiveCapture = {
  delivery: VoiceDictationDelivery;
  preserveOnStop?: boolean;
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
  readonly targetKey?: string;
  readonly transcribe: VoiceDictationTranscriber | null;
  readonly onTranscript: (transcript: string) => void;
  readonly onSend?: () => Promise<boolean>;
}) {
  const [state, setState] = useState<VoiceDictationState>({ phase: "idle" });
  const captureRef = useRef<ActiveCapture | null>(null);
  const startingRef = useRef(false);
  const audioRef = useRef<Blob | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const targetKey = input.targetKey;
  const inputRef = useRef(input);
  inputRef.current = input;
  const insertedTranscriptRef = useRef<string | undefined>(undefined);

  const releaseCapture = useCallback((capture: ActiveCapture) => {
    if (capture.timeout !== undefined) clearTimeout(capture.timeout);
    for (const track of capture.stream?.getTracks() ?? []) track.stop();
    delete capture.stream;
    // Keep the token through a cancelled, nonabortable permission request.
    if (!capture.mediaRequestPending) capture.releaseMicrophone();
    if (captureRef.current === capture) captureRef.current = null;
  }, []);

  const clearAudio = useCallback(() => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    audioRef.current = null;
    insertedTranscriptRef.current = undefined;
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
    if (targetKey) writeRecordingDraft(targetKey, null);
    setState({ phase: "idle" });
  }, [clearAudio, releaseCapture, targetKey]);

  const transcribe = useCallback(
    async (delivery: Exclude<VoiceDictationDelivery, "review"> = "insert") => {
      const audio = audioRef.current;
      const audioUrl = audioUrlRef.current;
      const transcriber = inputRef.current.transcribe;
      if (
        !audio ||
        !audioUrl ||
        (!transcriber && !insertedTranscriptRef.current) ||
        abortRef.current !== null
      )
        return;
      const generation = ++generationRef.current;
      const abortController = new AbortController();
      abortRef.current = abortController;
      setState({ phase: "transcribing", audioUrl });
      try {
        const transcript =
          insertedTranscriptRef.current ??
          (transcriber
            ? (await transcriber(audio, { signal: abortController.signal })).trim()
            : "");
        if (generationRef.current !== generation || abortController.signal.aborted) return;
        if (!transcript) {
          setState({
            phase: "error",
            message: "No speech was detected. You can record again.",
            audioUrl,
          });
          return;
        }
        if (!insertedTranscriptRef.current) {
          inputRef.current.onTranscript(transcript);
          insertedTranscriptRef.current = transcript;
          if (targetKey) writeRecordingDraft(targetKey, { audio, transcript });
        }
        if (delivery === "send") {
          let sending = pendingSends.get(audio);
          if (!sending) {
            sending = inputRef.current.onSend?.() ?? Promise.resolve(false);
            pendingSends.set(audio, sending);
            void sending
              .finally(() => {
                if (pendingSends.get(audio) === sending) pendingSends.delete(audio);
              })
              .catch(() => undefined);
          }
          const accepted = await sending;
          // Admission belongs to the original draft even after Settings/navigation.
          // Do not erase a replacement recording made while this request was pending.
          if (accepted && targetKey && (await readRecordingDraft(targetKey))?.audio === audio)
            writeRecordingDraft(targetKey, null);
          if (generationRef.current !== generation || abortController.signal.aborted) return;
          if (!accepted)
            throw new VoiceDictationServiceError(
              "The message could not be sent. Your text and recording are available to retry.",
            );
        }
        if (targetKey) writeRecordingDraft(targetKey, null);
        clearAudio();
        setState({ phase: "idle" });
      } catch (error) {
        if (generationRef.current !== generation || abortController.signal.aborted) return;
        const message =
          error instanceof VoiceDictationServiceError
            ? error.message
            : delivery === "send" && insertedTranscriptRef.current
              ? "Sending failed. Your text and recording are still available to retry."
              : "Transcription failed. Your recording is still available to retry.";
        if (targetKey)
          writeRecordingDraft(targetKey, {
            audio,
            message,
            transcript: insertedTranscriptRef.current,
          });
        setState({
          phase: "error",
          message,
          audioUrl,
        });
      } finally {
        if (abortRef.current === abortController) abortRef.current = null;
      }
    },
    [clearAudio, targetKey],
  );

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
      delivery: "insert",
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
          ((captureRef.current === capture && generationRef.current === generation) ||
            capture.preserveOnStop) &&
          event.data.size > 0
        )
          capture.chunks.push(event.data);
      };
      recorder.onstop = () => {
        if (capture.preserveOnStop) {
          const audio = new Blob(capture.chunks, { type: recorder.mimeType || "audio/webm" });
          if (targetKey && audio.size > 0 && audio.size <= MAX_RECORDING_BYTES)
            writeRecordingDraft(targetKey, { audio });
          releaseCapture(capture);
          return;
        }
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
        if (audio.size > MAX_RECORDING_BYTES) {
          setState({
            phase: "error",
            message: "This recording is too large. Record a shorter message.",
          });
          return;
        }
        const audioUrl = URL.createObjectURL(audio);
        audioRef.current = audio;
        audioUrlRef.current = audioUrl;
        if (targetKey) writeRecordingDraft(targetKey, { audio });
        setState({ phase: "review", audioUrl, audioType: audio.type });
        if (capture.delivery !== "review") void transcribe(capture.delivery);
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
  }, [clearAudio, releaseCapture, state.phase, targetKey, transcribe]);

  const stop = useCallback((delivery: VoiceDictationDelivery = "insert") => {
    const capture = captureRef.current;
    if (capture?.recorder?.state === "recording") {
      capture.delivery = delivery;
      capture.recorder.stop();
    }
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    setState({ phase: "idle" });
    if (targetKey)
      void readRecordingDraft(targetKey).then((draft) => {
        if (!draft || generationRef.current !== generation || audioRef.current) return;
        const audioUrl = URL.createObjectURL(draft.audio);
        audioRef.current = draft.audio;
        insertedTranscriptRef.current = draft.transcript;
        audioUrlRef.current = audioUrl;
        setState(
          draft.message
            ? { phase: "error", audioUrl, message: draft.message }
            : { phase: "review", audioUrl, audioType: draft.audio.type },
        );
      });
    return () => {
      generationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      const capture = captureRef.current;
      if (capture) {
        capture.preserveOnStop = true;
        if (capture.recorder?.state === "recording") capture.recorder.stop();
        releaseCapture(capture);
      }
      clearAudio();
    };
  }, [clearAudio, releaseCapture, targetKey]);

  return { state, start, stop, transcribe, cancel } as const;
}
