import { useState } from "react";
import { CopyIcon } from "lucide-react";
import type { LiveVoiceState } from "@t3tools/client-runtime/live-voice";

import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";

type LiveVoiceTranscriptEntry = LiveVoiceState["transcript"][number];

function transcriptText(transcript: ReadonlyArray<LiveVoiceTranscriptEntry>): string {
  return transcript
    .map((entry) => `${entry.speaker === "user" ? "You" : "Live"}:\n${entry.text}`)
    .join("\n\n");
}

export function LiveVoiceTranscript(props: {
  readonly transcript: ReadonlyArray<LiveVoiceTranscriptEntry>;
}) {
  const [open, setOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copying" | "copied" | "error">("idle");

  if (props.transcript.length === 0) return null;

  const copyTranscript = async () => {
    setCopyStatus("copying");
    try {
      const copied = await writeTextToClipboard(
        transcriptText(props.transcript),
        "Live transcript",
      );
      setCopyStatus(copied ? "copied" : "error");
    } catch {
      setCopyStatus("error");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" size="xs" variant="ghost" />}>
        Transcript
      </DialogTrigger>
      <DialogPopup className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>Live transcript</DialogTitle>
          <DialogDescription>
            Turns from this Live session. New turns appear while it is open.
          </DialogDescription>
        </DialogHeader>
        <div
          role="region"
          aria-label="Live conversation transcript"
          tabIndex={0}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pb-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ol className="space-y-4">
            {props.transcript.map((entry, index) => (
              <li key={`${index}-${entry.speaker}`} className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {entry.speaker === "user" ? "You" : "Live"}
                </p>
                <p className="select-text whitespace-pre-wrap break-words text-sm">{entry.text}</p>
              </li>
            ))}
          </ol>
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <span
            role={copyStatus === "error" ? "alert" : "status"}
            aria-live={copyStatus === "error" ? "assertive" : "polite"}
            className="text-sm"
          >
            {copyStatus === "copied"
              ? "Transcript copied."
              : copyStatus === "error"
                ? "Couldn’t copy transcript. Try again."
                : copyStatus === "copying"
                  ? "Copying transcript…"
                  : null}
          </span>
          <Button
            type="button"
            variant="outline"
            disabled={copyStatus === "copying"}
            onClick={() => void copyTranscript()}
          >
            <CopyIcon />
            {copyStatus === "copied" ? "Copied" : "Copy transcript"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
