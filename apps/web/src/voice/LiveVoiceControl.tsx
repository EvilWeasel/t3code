import { AsyncResult } from "effect/reactivity";
import { MicIcon, MicOffIcon, PhoneOffIcon, Volume2Icon, VolumeXIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { LiveVoiceEvent } from "@t3tools/contracts";
import {
  LiveVoiceController,
  isLiveVoiceSupported,
  type LiveVoiceControllerDependencies,
  type LiveVoiceLease,
  type LiveVoicePeer,
  type LiveVoiceSignalEvent,
  type LiveVoiceSignalingAdapter,
  type LiveVoiceState,
  type LiveVoiceTranscript as LiveVoiceTranscriptEntry,
  type LiveVoiceTarget,
} from "@t3tools/client-runtime/live-voice";

import { liveVoiceEnvironment } from "../state/liveVoice";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "~/components/ui/button";
import { randomUUID } from "~/lib/utils";
import { LiveVoiceTranscript } from "./LiveVoiceTranscript";

type VoiceEventBridge = {
  readonly subscribe: LiveVoiceSignalingAdapter["subscribe"];
  readonly publish: (
    lease: Pick<LiveVoiceLease, "leaseId" | "generation">,
    event: LiveVoiceEvent,
  ) => void;
  readonly publishUnavailable: (lease: Pick<LiveVoiceLease, "leaseId" | "generation">) => void;
};

function leaseKey(lease: Pick<LiveVoiceLease, "leaseId" | "generation">): string {
  return `${lease.leaseId}:${lease.generation}`;
}

function createVoiceEventBridge(): VoiceEventBridge {
  const listeners = new Map<string, Set<(event: LiveVoiceSignalEvent) => void>>();
  return {
    subscribe: (lease, listener, signal) => {
      const key = leaseKey(lease);
      let group = listeners.get(key);
      if (!group) listeners.set(key, (group = new Set()));
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          unsubscribe();
          reject(new DOMException("Live voice setup was cancelled.", "AbortError"));
        };
        const onEvent = (event: LiveVoiceSignalEvent) => {
          listener(event);
          if (
            event.type === "status" &&
            event.session.leaseId === lease.leaseId &&
            event.session.generation === lease.generation &&
            event.session.environmentId === lease.environmentId &&
            event.session.threadId === lease.threadId &&
            event.session.providerInstanceId === lease.providerInstanceId
          ) {
            signal.removeEventListener("abort", onAbort);
            resolve(unsubscribe);
          }
        };
        const unsubscribe = () => {
          group?.delete(onEvent);
          if (group?.size === 0) listeners.delete(key);
        };
        group.add(onEvent);
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    publish: (lease, event) =>
      listeners.get(leaseKey(lease))?.forEach((listener) => listener(event)),
    publishUnavailable: (lease) =>
      listeners.get(leaseKey(lease))?.forEach((listener) =>
        listener({
          type: "error",
          leaseId: lease.leaseId,
          generation: lease.generation,
          code: "runtime_unavailable",
        }),
      ),
  };
}

function LiveVoiceEventFeed(props: {
  readonly environmentId: EnvironmentId;
  readonly lease: LiveVoiceLease;
  readonly bridge: VoiceEventBridge;
}) {
  const leaseKeyValue = useMemo(
    () => ({ leaseId: props.lease.leaseId, generation: props.lease.generation }),
    [props.lease.generation, props.lease.leaseId],
  );
  const target = useMemo(
    () => ({ environmentId: props.environmentId, input: leaseKeyValue }),
    [leaseKeyValue, props.environmentId],
  );
  const result = useAtomValue(liveVoiceEnvironment.events(target));
  useEffect(() => {
    if (AsyncResult.isSuccess(result)) props.bridge.publish(leaseKeyValue, result.value);
    else if (AsyncResult.isFailure(result)) props.bridge.publishUnavailable(leaseKeyValue);
  }, [leaseKeyValue, props.bridge, result]);
  return null;
}

function unwrapCommand<A>(
  result: { readonly _tag: "Success"; readonly value: A } | { readonly _tag: "Failure" },
): A {
  if (result._tag === "Success") return result.value;
  throw new Error("Live voice request failed.");
}

export function LiveVoiceControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly providerInstanceId: string | null;
  readonly eligible: boolean;
  readonly unavailableReason: string;
}) {
  const prepare = useAtomCommand(liveVoiceEnvironment.prepare, {
    reportFailure: false,
    reportDefect: false,
  });
  const startRpc = useAtomCommand(liveVoiceEnvironment.start, {
    reportFailure: false,
    reportDefect: false,
  });
  const stopRpc = useAtomCommand(liveVoiceEnvironment.stop, {
    reportFailure: false,
    reportDefect: false,
  });
  const statusRpc = useAtomCommand(liveVoiceEnvironment.status, {
    reportFailure: false,
    reportDefect: false,
  });
  const [state, setState] = useState<LiveVoiceState>({
    phase: "idle",
    localMuted: false,
    outputMuted: false,
    transcript: [],
    sessionStatus: null,
    lease: null,
    error: null,
  });
  const target = useMemo<LiveVoiceTarget | null>(() => {
    if (!props.threadId || !props.providerInstanceId) return null;
    return {
      environmentId: props.environmentId,
      threadId: props.threadId,
      provider: "codex",
      providerInstanceId: props.providerInstanceId,
    };
  }, [props.environmentId, props.providerInstanceId, props.threadId]);
  const bridge = useMemo(() => createVoiceEventBridge(), []);
  const signaling = useMemo<LiveVoiceSignalingAdapter>(
    () => ({
      subscribe: bridge.subscribe,
      prepare: async (input) =>
        unwrapCommand(await prepare({ environmentId: props.environmentId, input })),
      start: async (input) =>
        unwrapCommand(await startRpc({ environmentId: props.environmentId, input })),
      stop: async (input) =>
        unwrapCommand(await stopRpc({ environmentId: props.environmentId, input })),
      status: async (input) =>
        unwrapCommand(await statusRpc({ environmentId: props.environmentId, input })),
    }),
    [bridge, prepare, props.environmentId, startRpc, statusRpc, stopRpc],
  );
  const dependencies = useMemo<LiveVoiceControllerDependencies>(
    () => ({
      signaling,
      getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true }),
      createPeer: () => new RTCPeerConnection() as unknown as LiveVoicePeer,
      createRemoteStream: (track) => new MediaStream([track]),
      createAudioSink: () => {
        const audio = document.createElement("audio");
        audio.autoplay = true;
        return audio;
      },
      createRequestId: randomUUID,
      scheduleTimeout: (callback, delayMs) => {
        const handle = window.setTimeout(callback, delayMs);
        return () => window.clearTimeout(handle);
      },
      onStateChange: setState,
    }),
    [signaling],
  );
  const controller = useMemo(() => new LiveVoiceController(dependencies), [dependencies]);

  const transcriptLease = state.lease;
  const transcriptMatchesTarget =
    transcriptLease !== null &&
    transcriptLease.environmentId === props.environmentId &&
    transcriptLease.threadId === props.threadId &&
    transcriptLease.providerInstanceId === props.providerInstanceId;
  const currentTranscript: ReadonlyArray<LiveVoiceTranscriptEntry> = transcriptMatchesTarget
    ? state.transcript
    : [];

  useEffect(
    () => () => {
      void controller.end();
    },
    [controller],
  );
  useEffect(() => {
    void controller.contextChanged(target);
  }, [controller, target]);

  const supported = isLiveVoiceSupported({
    provider: "codex",
    setupMode: "managed",
    RTCPeerConnection: typeof RTCPeerConnection === "undefined" ? undefined : RTCPeerConnection,
    getUserMedia:
      typeof navigator === "undefined" ? undefined : navigator.mediaDevices?.getUserMedia,
  });
  const active = state.phase === "live" || state.phase === "playback-blocked";
  const busy =
    state.phase === "preparing" ||
    state.phase === "prepared" ||
    state.phase === "connecting" ||
    state.phase === "stopping";
  const canStart = props.eligible && target !== null && supported && !busy && !active;
  const unavailableLabel = !supported
    ? "Live voice needs browser WebRTC and microphone access."
    : props.unavailableReason;
  const unavailableNotice = !supported
    ? "Unsupported in this browser"
    : !target
      ? "Open a thread for Live"
      : !props.eligible
        ? props.unavailableReason
        : null;
  const statusText =
    state.phase === "preparing"
      ? "Preparing restricted voice session…"
      : state.phase === "prepared" || state.phase === "connecting"
        ? "Connecting to Live…"
        : state.phase === "playback-blocked"
          ? "Live connected. Audio playback needs permission."
          : state.phase === "live"
            ? "Live connected"
            : state.phase === "stopping"
              ? "Ending Live…"
              : state.phase === "error"
                ? state.error
                : null;

  const toggleMicrophone = useCallback(
    () => void controller.setLocalMuted(!state.localMuted),
    [controller, state.localMuted],
  );
  const toggleOutput = useCallback(
    () => void controller.setOutputMuted(!state.outputMuted),
    [controller, state.outputMuted],
  );
  const onStart = useCallback(() => {
    if (target) void controller.start(target);
  }, [controller, target]);

  return (
    <div className="flex items-center gap-1" data-live-voice-phase={state.phase}>
      {state.lease && state.phase !== "ended" ? (
        <LiveVoiceEventFeed
          environmentId={props.environmentId}
          lease={state.lease}
          bridge={bridge}
        />
      ) : null}
      {!active && !busy ? (
        <>
          {state.phase === "error" ? (
            <span role="status" className="text-xs text-destructive">
              {statusText}
            </span>
          ) : null}
          {state.phase !== "error" && unavailableNotice ? (
            <span className="text-xs text-muted-foreground">{unavailableNotice}</span>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!canStart}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onStart}
            aria-label={props.eligible && supported ? "Start Live voice" : unavailableLabel}
            title={props.eligible && supported ? "Start Live voice" : unavailableLabel}
          >
            <MicIcon />
          </Button>
        </>
      ) : (
        <>
          <span role="status" className="text-xs text-muted-foreground">
            {statusText}
          </span>
          {active ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={toggleMicrophone}
                aria-label={state.localMuted ? "Unmute microphone" : "Mute microphone"}
                title={state.localMuted ? "Unmute microphone" : "Mute microphone"}
              >
                {state.localMuted ? <MicOffIcon /> : <MicIcon />}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={toggleOutput}
                aria-label={state.outputMuted ? "Unmute Live audio" : "Mute Live audio"}
                title={state.outputMuted ? "Unmute Live audio" : "Mute Live audio"}
              >
                {state.outputMuted ? <VolumeXIcon /> : <Volume2Icon />}
              </Button>
              {state.phase === "playback-blocked" ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void controller.retryPlayback()}
                >
                  Enable audio
                </Button>
              ) : null}
            </>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => void controller.end()}
            aria-label="End Live voice"
            title="End Live voice"
          >
            <PhoneOffIcon />
          </Button>
        </>
      )}
      <LiveVoiceTranscript
        key={
          transcriptMatchesTarget && transcriptLease
            ? `${transcriptLease.environmentId}:${transcriptLease.threadId}:${transcriptLease.providerInstanceId}:${transcriptLease.leaseId}:${transcriptLease.generation}`
            : "no-live-transcript"
        }
        transcript={currentTranscript}
      />
    </div>
  );
}
