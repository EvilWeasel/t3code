import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createLiveVoiceThreadPreparer,
  liveVoiceDraftStartReason,
  LIVE_VOICE_THREAD_CHANGED,
  type LiveVoiceThreadContext,
} from "./LiveVoiceDraftThread";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function draftContext(): LiveVoiceThreadContext {
  return {
    target: {
      environmentId: "environment-a",
      threadId: "draft-thread",
      provider: "codex",
      providerInstanceId: "native-codex",
    },
    persisted: false,
    unavailableReason: null,
    thread: {
      commandId: CommandId.make("live-voice-thread-create:draft-id"),
      threadId: ThreadId.make("draft-thread"),
      projectId: ProjectId.make("project-a"),
      title: "New thread",
      modelSelection: { instanceId: ProviderInstanceId.make("native-codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "plan",
      branch: "voice-branch",
      worktreePath: "/project/existing-worktree",
    },
  };
}

function harness(initial = draftContext()) {
  let context: LiveVoiceThreadContext | null = initial;
  const createThread = vi.fn(async (_input: LiveVoiceThreadContext["thread"]): Promise<void> => {});
  const onCreated = vi.fn();
  const prepare = createLiveVoiceThreadPreparer({
    readContext: () => context,
    createThread,
    onCreated,
  });
  return {
    prepare,
    createThread,
    onCreated,
    setContext: (next: LiveVoiceThreadContext | null) => {
      context = next;
    },
  };
}

describe("Live voice draft persistence", () => {
  it("waits for the empty thread receipt and preserves its destination and settings", async () => {
    const context = draftContext();
    const saved = deferred();
    const h = harness(context);
    h.createThread.mockImplementation(() => saved.promise);
    let readyForLease = false;
    const preparing = h.prepare(context.target, new AbortController().signal).then(() => {
      readyForLease = true;
    });
    expect(h.createThread).toHaveBeenCalledExactlyOnceWith(context.thread);
    expect(readyForLease).toBe(false);
    expect(h.onCreated).not.toHaveBeenCalled();
    saved.resolve();
    await preparing;
    expect(readyForLease).toBe(true);
    expect(h.onCreated).toHaveBeenCalledExactlyOnceWith(context);
    expect(h.createThread.mock.calls[0]?.[0]).not.toHaveProperty("message");
    expect(h.createThread.mock.calls[0]?.[0]).not.toHaveProperty("initialMessage");
  });

  it("shares a pending creation and retains its accepted receipt before the shell arrives", async () => {
    const context = draftContext();
    const saved = deferred();
    const h = harness(context);
    h.createThread.mockImplementation(() => saved.promise);
    const first = h.prepare(context.target, new AbortController().signal);
    const second = h.prepare(context.target, new AbortController().signal);
    expect(h.createThread).toHaveBeenCalledOnce();
    saved.resolve();
    await Promise.all([first, second]);
    await h.prepare(context.target, new AbortController().signal);
    expect(h.createThread).toHaveBeenCalledOnce();
    h.setContext({ ...context, persisted: true });
    await h.prepare(context.target, new AbortController().signal);
    expect(h.createThread).toHaveBeenCalledOnce();
  });

  it("retries a failed acknowledgement with the same ordinary command identity", async () => {
    const context = draftContext();
    const h = harness(context);
    h.createThread.mockRejectedValueOnce(new Error("lost acknowledgement"));
    await expect(h.prepare(context.target, new AbortController().signal)).rejects.toThrow();
    expect(h.onCreated).not.toHaveBeenCalled();
    await h.prepare(context.target, new AbortController().signal);
    expect(h.createThread.mock.calls.map(([input]) => input.commandId)).toEqual([
      context.thread.commandId,
      context.thread.commandId,
    ]);
  });

  it("retains a late accepted creation after cancellation without preparing that call", async () => {
    const context = draftContext();
    const saved = deferred();
    const h = harness(context);
    h.createThread.mockImplementation(() => saved.promise);
    const controller = new AbortController();
    const preparing = h.prepare(context.target, controller.signal);
    const rejected = expect(preparing).rejects.toThrow(LIVE_VOICE_THREAD_CHANGED);
    controller.abort();
    saved.resolve();
    await rejected;
    await h.prepare(context.target, new AbortController().signal);
    expect(h.createThread).toHaveBeenCalledOnce();
    expect(h.onCreated).toHaveBeenCalledOnce();
  });

  it.each(["route", "provider", "project", "workspace", "runtime", "interaction"] as const)(
    "rejects a changed %s after persistence before allowing lease preparation",
    async (changed) => {
      const context = draftContext();
      const saved = deferred();
      const h = harness(context);
      h.createThread.mockImplementation(() => saved.promise);
      const preparing = h.prepare(context.target, new AbortController().signal);
      const rejected = expect(preparing).rejects.toThrow(LIVE_VOICE_THREAD_CHANGED);
      h.setContext(
        changed === "route"
          ? null
          : changed === "provider"
            ? { ...context, target: { ...context.target, providerInstanceId: "another-codex" } }
            : {
                ...context,
                thread: {
                  ...context.thread,
                  ...(changed === "project" ? { projectId: ProjectId.make("project-b") } : {}),
                  ...(changed === "workspace" ? { worktreePath: "/another-worktree" } : {}),
                  ...(changed === "runtime" ? { runtimeMode: "approval-required" as const } : {}),
                  ...(changed === "interaction" ? { interactionMode: "default" as const } : {}),
                },
              },
      );
      saved.resolve();
      await rejected;
    },
  );

  it("leaves an already persisted thread unchanged", async () => {
    const context = { ...draftContext(), persisted: true };
    const h = harness(context);
    await h.prepare(context.target, new AbortController().signal);
    expect(h.createThread).not.toHaveBeenCalled();
    expect(h.onCreated).not.toHaveBeenCalled();
  });

  it("blocks an unprepared new worktree instead of creating a thread in the root workspace", async () => {
    const input = {
      isDraft: true,
      projectAvailable: true,
      environmentChanging: false,
      envMode: "worktree" as const,
      worktreePath: null,
    };
    const reason = liveVoiceDraftStartReason(input);
    expect(reason).toContain("Prepare this thread's worktree");
    const context = { ...draftContext(), unavailableReason: reason };
    const h = harness(context);
    await expect(h.prepare(context.target, new AbortController().signal)).rejects.toThrow(reason!);
    expect(h.createThread).not.toHaveBeenCalled();
    expect(liveVoiceDraftStartReason({ ...input, worktreePath: "/prepared" })).toBeNull();
    expect(liveVoiceDraftStartReason({ ...input, envMode: "local" })).toBeNull();
    expect(liveVoiceDraftStartReason({ ...input, isDraft: false })).toBeNull();
  });
});
