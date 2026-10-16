import type { CreateThreadInput } from "@t3tools/client-runtime/operations";
import type { LiveVoiceTarget } from "@t3tools/client-runtime/live-voice";

export const LIVE_VOICE_THREAD_CHANGED = "The selected voice thread changed. Start again.";
export const LIVE_VOICE_THREAD_CREATE_FAILED =
  "The voice thread could not be saved. Reconnect and try again.";

export function liveVoiceDraftStartReason(input: {
  readonly isDraft: boolean;
  readonly projectAvailable: boolean;
  readonly environmentChanging: boolean;
  readonly envMode: "local" | "worktree";
  readonly worktreePath: string | null;
}): string | null {
  if (!input.isDraft) return null;
  if (!input.projectAvailable) return "Choose a project before starting Live voice.";
  if (input.environmentChanging) return "Wait for this draft's environment to finish changing.";
  if (input.envMode === "worktree" && !input.worktreePath)
    return "Prepare this thread's worktree before starting Live voice.";
  return null;
}

export type LiveVoiceThreadContext = {
  readonly target: LiveVoiceTarget;
  readonly persisted: boolean;
  readonly thread: CreateThreadInput;
  readonly unavailableReason: string | null;
};

function matchesTarget(left: LiveVoiceTarget, right: LiveVoiceTarget): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId &&
    left.provider === right.provider &&
    left.providerInstanceId === right.providerInstanceId
  );
}

/** Keep the draft identity and its retry receipt until its ordinary shell arrives. */
export function createLiveVoiceThreadPreparer(dependencies: {
  readonly readContext: () => LiveVoiceThreadContext | null;
  readonly createThread: (input: CreateThreadInput) => Promise<void>;
  readonly onCreated: (context: LiveVoiceThreadContext) => void;
}) {
  const creations = new Map<
    string,
    { readonly fingerprint: string; accepted: boolean; pending: Promise<void> | null }
  >();
  return async (target: LiveVoiceTarget, signal: AbortSignal): Promise<void> => {
    const readCurrent = () => {
      const context = dependencies.readContext();
      if (signal.aborted || !context || !matchesTarget(context.target, target))
        throw new Error(LIVE_VOICE_THREAD_CHANGED);
      if (context.unavailableReason) throw new Error(context.unavailableReason);
      return context;
    };
    const context = readCurrent();
    if (context.persisted) return;
    const key = JSON.stringify([target.environmentId, target.threadId]);
    const fingerprint = JSON.stringify(context.thread);
    let creation = creations.get(key);
    if (creation && creation.fingerprint !== fingerprint)
      throw new Error(LIVE_VOICE_THREAD_CHANGED);
    if (!creation) {
      creation = { fingerprint, accepted: false, pending: null };
      creations.set(key, creation);
    }
    const captured = creation;
    if (!captured.accepted && !captured.pending) {
      captured.pending = dependencies
        .createThread(context.thread)
        .then(() => {
          captured.accepted = true;
          dependencies.onCreated(context);
        })
        .finally(() => {
          captured.pending = null;
        });
    }
    if (captured.pending) await captured.pending;
    const current = readCurrent();
    if (JSON.stringify(current.thread) !== fingerprint) throw new Error(LIVE_VOICE_THREAD_CHANGED);
  };
}
