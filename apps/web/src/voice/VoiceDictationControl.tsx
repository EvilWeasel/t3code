import { MicIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { useVoiceDictation, type VoiceDictationTranscriber } from "./useVoiceDictation";
import { Button } from "~/components/ui/button";
import { useEffect, useRef } from "react";

export function VoiceDictationControl(props: {
  readonly targetKey: string;
  readonly currentTargetKey: () => string;
  readonly transcribe: VoiceDictationTranscriber | null;
  readonly onTranscript: (text: string, targetKey: string) => void;
}) {
  const recordedTargetKey = useRef(props.targetKey);
  const dictation = useVoiceDictation({
    transcribe: props.transcribe,
    onTranscript: (text) => {
      const targetKey = recordedTargetKey.current;
      if (props.currentTargetKey() === targetKey) {
        props.onTranscript(text, targetKey);
      }
    },
  });
  const state = dictation.state;
  const cancelRef = useRef(dictation.cancel);
  useEffect(() => {
    cancelRef.current = dictation.cancel;
  }, [dictation.cancel]);
  useEffect(() => {
    if (recordedTargetKey.current !== props.targetKey) {
      cancelRef.current();
    }
    recordedTargetKey.current = props.targetKey;
  }, [props.targetKey]);

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
          {error}
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
