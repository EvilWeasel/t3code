import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { environmentThreadShells } from "~/state/threads";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import type { RestartingMachine, SkippedMachine, UpdateHistoryRead } from "./updateEverything.logic";

/** A thread an agent is working on now. A restart stops these; queued threads wait. */
const isRunning = (status: string) =>
  status === "preparing" || status === "starting" || status === "running";

/** Running threads across the environments in a newline-joined key. */
const runningThreadCountAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) =>
    environmentIds
      .split("\n")
      .filter((id) => id !== "")
      .reduce(
        (count, id) =>
          count +
          get(environmentThreadShells.environmentThreadsAtom(EnvironmentId.make(id))).filter(
            (thread) => isRunning(thread.status),
          ).length,
        0,
      ),
  ).pipe(Atom.withLabel(`update-everything-running-threads:${environmentIds}`)),
);

interface UpdateEverythingDialogProps {
  readonly mode?: "confirm";
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly summary: string;
  readonly lines: ReadonlyArray<string>;
  readonly restarts: ReadonlyArray<RestartingMachine>;
  /** Behind machines the run leaves alone. */
  readonly skipped: ReadonlyArray<SkippedMachine>;
  readonly onConfirm: () => void;
}

/**
 * Confirms an "update everything" run. It counts the running threads that the
 * restarts stop, and how many can resume afterwards because "Continue threads
 * after restarts" is on for their server. Recovery still skips some, such as a
 * thread waiting on the user, so the text says "can resume", not "will".
 * Machines the run skips are listed with the reason, so none drop silently.
 */
interface LastOutcomeDialogProps {
  readonly mode: "history";
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly history: UpdateHistoryRead;
  readonly onClear: () => boolean;
}

export function UpdateEverythingDialog(props: UpdateEverythingDialogProps | LastOutcomeDialogProps) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup>
        {props.mode === "history"
          ? <LastUpdateOutcomeContent history={props.history} onClear={props.onClear} />
          : <UpdateEverythingDialogContent {...props} />}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function LastUpdateOutcomeContent({ history, onClear }: Pick<LastOutcomeDialogProps, "history" | "onClear">) {
  const [clearFailed, setClearFailed] = useState(false);
  const completed = history.status === "ready" ? history.value.lastCompleted : null;
  const pending = history.status === "ready" && history.value.pendingInstall !== null;
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Last completed update</AlertDialogTitle>
        <AlertDialogDescription>
          {history.status === "unavailable" ? "The saved result is unavailable in this environment."
            : completed ? `Completed ${new Date(completed.completedAt).toLocaleString()}`
              : "No completed update result has been saved here."}
        </AlertDialogDescription>
        {completed ? <p className="pt-2 text-sm">
          {`Client ${completed.clientVersion}${completed.targetVersion ? `; requested ${completed.targetVersion}` : ""}`}
        </p> : null}
        {pending ? <p className="pt-2 text-sm">An app installation is awaiting version verification. It has not replaced the last completed result.</p> : null}
        {completed ? <ul className="max-h-80 space-y-2 overflow-y-auto pt-2 text-sm">
          {completed.rows.map((row, index) => <li key={`${row.environmentId}:${row.component}:${row.instanceId ?? ""}:${index}`}>
            <span className="font-medium">{row.machineLabel}</span>
            {` · ${row.component === "provider" ? `${row.driver} (${row.instanceId})` : row.component}: ${row.status}`}
            {row.reason !== "none" ? ` — ${row.reason.replaceAll("-", " ")}` : ""}
          </li>)}
        </ul> : null}
        {clearFailed ? <p role="status" className="pt-2 text-sm">The saved result could not be cleared.</p> : null}
      </AlertDialogHeader>
      <AlertDialogFooter>
        <Button variant="outline" onClick={() => setClearFailed(!onClear())}>Clear result</Button>
        <AlertDialogClose render={<Button variant="outline" />}>Close</AlertDialogClose>
      </AlertDialogFooter>
    </>
  );
}

function UpdateEverythingDialogContent({
  summary,
  lines,
  restarts,
  skipped,
  onConfirm,
}: Omit<UpdateEverythingDialogProps, "open" | "onOpenChange">) {
  const stopped = useAtomValue(
    runningThreadCountAtom(
      restarts
        .filter((machine) => !machine.continuesThreads)
        .map((machine) => machine.environmentId)
        .join("\n"),
    ),
  );
  const continuing = useAtomValue(
    runningThreadCountAtom(
      restarts
        .filter((machine) => machine.continuesThreads)
        .map((machine) => machine.environmentId)
        .join("\n"),
    ),
  );
  const running = stopped + continuing;
  const threads = `${running} running ${running === 1 ? "thread" : "threads"}`;

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{summary}?</AlertDialogTitle>
        <AlertDialogDescription className="whitespace-pre-line">
          {lines.join("\n")}
        </AlertDialogDescription>
        {running > 0 ? (
          <p className="pt-2 text-sm">
            {stopped === 0
              ? `${threads} will be interrupted and can resume after the restart.`
              : continuing === 0
                ? `${threads} will be interrupted.`
                : `${threads} will be interrupted. ${continuing} can resume after the restart.`}
          </p>
        ) : null}
        {skipped.length > 0 ? (
          <p className="whitespace-pre-line pt-2 text-sm">
            {skipped.map((machine) => `Skips ${machine.label}: ${machine.reason}`).join("\n")}
          </p>
        ) : null}
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
        <Button onClick={onConfirm}>Update</Button>
      </AlertDialogFooter>
    </>
  );
}
