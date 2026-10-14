import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { MicIcon, SquareIcon, Trash2Icon, SendIcon, Settings2Icon } from "lucide-react";
import {
  useVoiceDictation,
  VoiceDictationServiceError,
  type VoiceDictationTranscriber,
} from "./useVoiceDictation";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { useEffect, useRef } from "react";
import { useCallback } from "react";

export function VoiceDictationControl(props: {
  readonly environmentId?: EnvironmentId;
  readonly targetKey: string;
  readonly currentTargetKey: () => string;
  readonly transcribe: VoiceDictationTranscriber | null;
  readonly onTranscript: (text: string, targetKey: string) => boolean;
  readonly onSend?: (targetKey: string, transcript: string) => Promise<boolean>;
  readonly hasTranscript?: (transcript: string) => boolean;
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
    ...(props.hasTranscript ? { hasTranscript: props.hasTranscript } : {}),
    onSend: async (transcript) => {
      const targetKey = recordedTargetKey.current;
      if (props.currentTargetKey() !== targetKey) return false;
      return (await props.onSend?.(targetKey, transcript)) ?? false;
    },
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
  const settingsLink = props.environmentId ? (
    <Button
      variant="ghost"
      size="icon-sm"
      render={
        <Link to="/settings/integrations" search={{ machine: props.environmentId }} hash="voice" />
      }
      aria-label="Voice provider and API key settings"
      title="Voice provider and API key settings"
    >
      <Settings2Icon />
    </Button>
  ) : null;
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
        {settingsLink}
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
          onClick={() => dictation.stop()}
          aria-label="Stop recording"
          title="Stop recording"
        >
          <SquareIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={!props.onSend}
          onClick={() => dictation.stop("send")}
          aria-label="Transcribe and send recording"
          title="Transcribe and send recording"
        >
          <SendIcon />
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
    <Popover defaultOpen>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon-sm" />}
        aria-label={busy ? "Voice message processing" : "Review saved voice recording"}
        title={busy ? "Voice message processing" : "Review saved voice recording"}
        aria-busy={busy}
      >
        <MicIcon />
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="md" padding="compact">
        <div className="flex flex-col gap-2">
          <audio className="h-8 w-full" controls src={audioUrl} aria-label="Review recording" />
          {error ? (
            <span role="status" className="text-xs text-destructive">
              {error}
            </span>
          ) : null}
          {busy ? (
            <span role="status" className="text-xs text-muted-foreground">
              Processing voice message…
            </span>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {settingsLink}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || !props.transcribe}
              onClick={() => void dictation.transcribe()}
            >
              Insert text
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy || !props.transcribe || !props.onSend}
              onClick={() => void dictation.transcribe("send")}
            >
              Send
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
        </div>
      </PopoverPopup>
    </Popover>
  );
}
