import { MicIcon, SquareIcon, Trash2Icon } from "lucide-react";
import {
  useVoiceDictation,
  VoiceDictationServiceError,
  type VoiceDictationTranscriber,
} from "./useVoiceDictation";
import { Button } from "~/components/ui/button";
import { useEffect, useRef } from "react";
import { useCallback } from "react";

export function VoiceDictationControl(props: {
  readonly targetKey: string;
  readonly currentTargetKey: () => string;
  readonly transcribe: VoiceDictationTranscriber | null;
  readonly onTranscript: (text: string, targetKey: string) => boolean;
}) {
  const recordedTargetKey = useRef(props.targetKey);
  const recordingTranscriber = useRef<VoiceDictationTranscriber | null>(props.transcribe);
  const transcribeCapturedRecording = useCallback<VoiceDictationTranscriber>(
    (audio, options) => {
      if (recordedTargetKey.current !== props.currentTargetKey()) {
        return Promise.reject(
          new VoiceDictationServiceError(
            "The selected draft changed. Return to the original draft to retry this recording.",
          ),
        );
      }
      const transcribe = recordingTranscriber.current;
      return transcribe
        ? transcribe(audio, options)
        : Promise.reject(new Error("Transcription is unavailable for this environment."));
    },
    [props.currentTargetKey],
  );
  const dictation = useVoiceDictation({
    targetKey: props.targetKey,
    transcribe: transcribeCapturedRecording,
    onTranscript: (text) => {
      const targetKey = recordedTargetKey.current;
      if (props.currentTargetKey() !== targetKey) {
        throw new VoiceDictationServiceError(
          "The selected draft changed. Return to the original draft to retry this recording.",
        );
      }
      if (!props.onTranscript(text, targetKey)) {
        throw new VoiceDictationServiceError(
          "The transcript could not be inserted. Your recording is still available to retry.",
        );
      }
    },
  });
  const state = dictation.state;
  useEffect(() => {
    if (recordedTargetKey.current !== props.targetKey) {
      recordingTranscriber.current = props.transcribe;
    }
    recordedTargetKey.current = props.targetKey;
  }, [props.targetKey, props.transcribe]);

  if (state.phase === "idle" || (state.phase === "error" && !state.audioUrl)) {
    return (
      <div className="flex items-center gap-1">
        {state.phase === "error" ? (
          <span role="status" className="text-xs text-destructive">
            {state.message}
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            recordedTargetKey.current = props.targetKey;
            recordingTranscriber.current = props.transcribe;
            void dictation.start();
          }}
          aria-label="Record voice message"
          title="Record voice message"
        >
          <MicIcon />
        </Button>
      </div>
    );
  }

  if (state.phase === "recording") {
    return (
      <div className="flex items-center gap-1 rounded-md border border-border px-2 py-1">
        <span className="text-xs text-destructive" role="status">
          Recording
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={dictation.stop}
          aria-label="Stop recording"
          title="Stop recording"
        >
          <SquareIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={dictation.cancel}
          aria-label="Discard recording"
          title="Discard recording"
        >
          <Trash2Icon />
        </Button>
      </div>
    );
  }

  const audioUrl = state.audioUrl;
  const busy = state.phase === "transcribing";
  const error = state.phase === "error" ? state.message : null;
  return (
    <div className="flex max-w-[min(30rem,60vw)] items-center gap-2 rounded-md border border-border bg-background px-2 py-1">
      <audio
        className="h-8 min-w-0 max-w-32 sm:max-w-48"
        controls
        src={audioUrl}
        aria-label="Review recording"
      />
      {error ? (
        <span role="status" className="max-w-40 text-xs text-destructive">
          {error} Open Settings → Integrations → Voice transcription to check this environment.
        </span>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={busy || !props.transcribe}
        onClick={() => void dictation.transcribe()}
      >
        {busy ? "Transcribing…" : "Transcribe"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={dictation.cancel}
        aria-label="Discard recording"
        title="Discard recording"
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}
