import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  MicIcon,
  SquareIcon,
  Trash2Icon,
  SendIcon,
  Settings2Icon,
  AlertCircleIcon,
} from "lucide-react";
import {
  useVoiceDictation,
  VoiceDictationServiceError,
  type VoiceDictationTranscriber,
} from "./useVoiceDictation";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger, PopoverTitle } from "~/components/ui/popover";
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
    const controls = (
      <div className="flex shrink-0 items-center gap-1">
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
    if (state.phase !== "error") return controls;
    return (
      <div className="flex shrink-0 items-center gap-1">
        <Popover defaultOpen>
          <PopoverTrigger
            render={<Button variant="ghost" size="icon-sm" />}
            aria-label="Voice recording error"
            title="Voice recording error"
          >
            <AlertCircleIcon className="text-destructive" />
          </PopoverTrigger>
          <PopoverPopup side="top" align="end" width="md">
            <div className="flex min-w-0 flex-col gap-3">
              <PopoverTitle>Could not record</PopoverTitle>
              <VoiceRecordingError message={state.message} />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Use the microphone button to try recording again.
              </p>
            </div>
          </PopoverPopup>
        </Popover>
        {controls}
      </div>
    );
  }

  if (state.phase === "recording") {
    return (
      <div className="flex shrink-0 flex-wrap items-center gap-1 rounded-lg border border-border px-2 py-1">
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
      <PopoverPopup side="top" align="end" width="md">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <PopoverTitle>Voice recording</PopoverTitle>
            {settingsLink}
          </div>
          <audio
            className="block h-10 w-full min-w-0 shrink-0 [color-scheme:light] dark:[color-scheme:dark]"
            controls
            src={audioUrl}
            aria-label="Review recording"
          />
          {error ? <VoiceRecordingError message={error} /> : null}
          {busy ? (
            <span role="status" className="text-xs text-muted-foreground">
              Processing voice message…
            </span>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
            <Button
              type="button"
              variant="default"
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

/** Keep provider diagnostics available without letting them dominate the composer. */
function VoiceRecordingError({ message }: { readonly message: string }) {
  return (
    <div className="min-w-0 space-y-1 text-xs leading-relaxed">
      <p role="status" className="flex items-start gap-2 text-muted-foreground">
        <AlertCircleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        Voice action failed. Review the details and try again.
      </p>
      <details className="min-w-0 text-muted-foreground">
        <summary className="cursor-pointer rounded-sm py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Error details
        </summary>
        <p className="max-h-28 overflow-y-auto whitespace-pre-wrap wrap-anywhere pt-1">{message}</p>
      </details>
    </div>
  );
}
