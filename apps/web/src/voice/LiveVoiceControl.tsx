import { AsyncResult } from "effect/reactivity";
import {
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  PhoneCallIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type {
  EnvironmentId,
  ProjectId,
  ServerProvider,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
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
  type LiveVoiceTarget,
} from "@t3tools/client-runtime/live-voice";

import { liveVoiceEnvironment } from "../state/liveVoice";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { randomUUID } from "~/lib/utils";
import { LiveVoiceTranscript } from "./LiveVoiceTranscript";
import { unwrapLiveVoiceCommand } from "./LiveVoiceCommands";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";

export function deriveLiveVoiceProviderEntries(
  providers: ReadonlyArray<ServerProvider>,
  settings: Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides">,
  projectId: ProjectId | null,
) {
  return sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, projectId),
  );
}

/** A cached successful config must not hide a current projection failure. */
export function resolveLiveVoiceConfigState(result: AsyncResult.AsyncResult<unknown, unknown>) {
  return AsyncResult.isFailure(result)
    ? "failed"
    : AsyncResult.isInitial(result)
      ? "pending"
      : "ready";
}

type LiveVoiceAvailability = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly providerInstanceId: string | null;
  readonly reason: string | null;
  readonly facts: Readonly<{
    driver: "codex" | "other" | "unknown";
    setupMode: "managed" | "existing" | "missing" | "invalid" | "unknown";
    providerEnabled: boolean | null;
    providerAvailable: boolean | null;
    projectOverride: "enabled" | "disabled" | "unset" | "unknown";
    catalogState: "pending" | "ready" | "failed" | "scope-mismatch";
    settingsKnown: boolean;
    permissionState: "known" | "pending" | "unavailable";
    canOperate: boolean | null;
    selectionCurrent: boolean;
  }>;
};

/** Only cached facts for the selected destination may qualify its voice control. */
export function resolveLiveVoiceAvailability(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly providerInstanceId: string | null;
  readonly catalogEnvironmentId: EnvironmentId | null;
  readonly configState: "pending" | "ready" | "failed";
  readonly settingsKnown: boolean;
  readonly canOperate: boolean;
  readonly permissionState: "known" | "pending" | "unavailable";
  readonly selectionCurrent: boolean;
  readonly instanceRequested: boolean;
  readonly provider: {
    readonly driverKind: string;
    readonly enabled: boolean;
    readonly isAvailable: boolean;
  } | null;
  readonly instanceConfigured: boolean;
  readonly projectOverride?: boolean | undefined;
  readonly config: unknown;
}): LiveVoiceAvailability {
  let reason: string | null = null;
  if (!input.threadId) reason = "Open an existing thread to start Live voice.";
  else if (input.configState === "failed")
    reason = "Provider information could not be loaded. Reconnect this environment.";
  else if (input.configState === "pending")
    reason = "Waiting for this environment's provider information.";
  else if (input.catalogEnvironmentId !== input.environmentId)
    reason = "Waiting for this environment's provider information.";
  else if (!input.settingsKnown) reason = "Waiting for this environment's provider settings.";
  else if (input.permissionState === "pending")
    reason = "Waiting for this environment's thread permissions.";
  else if (input.permissionState === "unavailable")
    reason = "Thread permissions could not be verified. Reconnect this environment.";
  else if (!input.canOperate) reason = "You need permission to operate this thread.";
  else if (!input.provider)
    reason = input.instanceRequested
      ? "The selected provider instance is missing from this environment. Choose a configured provider."
      : "Configure a Codex provider in this environment's Settings.";
  else if (!input.provider.enabled)
    reason = "Enable the selected provider for this project in Settings.";
  else if (!input.provider.isAvailable)
    reason = "The selected provider is unavailable. Check its setup in Settings.";
  else if (input.provider.driverKind !== "codex")
    reason = "Select a managed Codex provider to use Live voice.";
  else if (!input.selectionCurrent || !input.providerInstanceId)
    reason = "Waiting for this thread's provider selection to update.";
  else if (!input.instanceConfigured)
    reason = "The selected Codex instance has no saved settings. Complete its setup in Settings.";
  else if (input.config === null || input.config === undefined)
    reason = "Codex setup mode is missing. Complete its setup in Settings.";
  else if (typeof input.config !== "object" || !("setupMode" in input.config))
    reason = "Codex setup mode is invalid or missing. Check its setup in Settings.";
  else if (input.config.setupMode === "existing")
    reason =
      "This Codex provider uses an existing installation. Live voice requires managed setup.";
  else if (input.config.setupMode !== "managed")
    reason = "Codex setup mode is invalid. Check its setup in Settings.";
  const catalogMatches = input.catalogEnvironmentId === input.environmentId;
  const catalogReady = catalogMatches && input.configState === "ready";
  const settingsReady = catalogReady && input.settingsKnown;
  const setupMode = !settingsReady
    ? "unknown"
    : input.config === null || input.config === undefined
      ? "missing"
      : typeof input.config !== "object"
        ? "invalid"
        : !("setupMode" in input.config)
          ? "missing"
          : input.config.setupMode === "managed" || input.config.setupMode === "existing"
            ? input.config.setupMode
            : "invalid";
  return Object.freeze({
    environmentId: input.environmentId,
    threadId: input.threadId,
    providerInstanceId: input.providerInstanceId,
    reason,
    facts: Object.freeze({
      driver:
        !catalogReady || !input.provider
          ? "unknown"
          : input.provider.driverKind === "codex"
            ? "codex"
            : "other",
      setupMode,
      providerEnabled: catalogReady ? (input.provider?.enabled ?? null) : null,
      providerAvailable: catalogReady ? (input.provider?.isAvailable ?? null) : null,
      projectOverride: !settingsReady
        ? "unknown"
        : input.projectOverride === undefined
          ? "unset"
          : input.projectOverride
            ? "enabled"
            : "disabled",
      catalogState:
        input.configState !== "ready"
          ? input.configState
          : catalogMatches
            ? "ready"
            : "scope-mismatch",
      settingsKnown: settingsReady,
      permissionState: input.permissionState,
      canOperate: input.permissionState === "known" ? input.canOperate : null,
      selectionCurrent: catalogReady && input.selectionCurrent,
    }),
  });
}

/** The actual rendered gate, also usable by a future explicitly requested diagnostic producer. */
export function resolveLiveVoiceControlGate(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly providerInstanceId: string | null;
  readonly availability: LiveVoiceAvailability;
  readonly eligible: boolean;
  readonly phase: LiveVoiceState["phase"];
  readonly RTCPeerConnection?: unknown;
  readonly getUserMedia?: unknown;
}) {
  const availabilityMatchesTarget =
    input.availability.environmentId === input.environmentId &&
    input.availability.threadId === input.threadId &&
    input.availability.providerInstanceId === input.providerInstanceId;
  const targetPresent = Boolean(
    input.threadId && input.providerInstanceId && availabilityMatchesTarget,
  );
  const supported = isLiveVoiceSupported({
    provider: "codex",
    setupMode: "managed",
    RTCPeerConnection: input.RTCPeerConnection,
    getUserMedia: input.getUserMedia,
  });
  const webRtcAvailable = typeof input.RTCPeerConnection === "function";
  const microphoneApiAvailable = typeof input.getUserMedia === "function";
  const active =
    input.phase === "live" || input.phase === "playback-blocked" || input.phase === "reconnecting";
  const busy =
    input.phase === "preparing" ||
    input.phase === "prepared" ||
    input.phase === "connecting" ||
    input.phase === "stopping";
  const eligible = input.eligible && input.availability.reason === null;
  const canStart = eligible && targetPresent && supported && !busy && !active;
  const reason = !availabilityMatchesTarget
    ? "Waiting for this environment's voice availability to update."
    : !webRtcAvailable
      ? "This browser does not provide WebRTC. Use a browser with WebRTC support."
      : !microphoneApiAvailable
        ? "Microphone access is unavailable in this browser context. Open the app in a trusted secure context."
        : (input.availability.reason ??
          (!targetPresent
            ? "Open a thread for a voice call"
            : !input.eligible
              ? "Live voice is unavailable for this thread. Check the selected provider and permissions."
              : null));
  return Object.freeze({
    environmentId: input.environmentId,
    threadId: input.threadId,
    providerInstanceId: input.providerInstanceId,
    phase: input.phase,
    targetPresent,
    active,
    busy,
    webRtcAvailable,
    microphoneApiAvailable,
    canStart,
    reason,
    facts: availabilityMatchesTarget ? input.availability.facts : null,
  });
}

type LiveVoiceDiagnosticModel = Readonly<{
  epoch: number;
  revision: number;
  gate: ReturnType<typeof resolveLiveVoiceControlGate>;
}>;

/** Pure model only. No production caller until the explicit request/bridge contract is frozen. */
export function advanceLiveVoiceDiagnosticModel(
  previous: LiveVoiceDiagnosticModel | null,
  gate: LiveVoiceDiagnosticModel["gate"],
): LiveVoiceDiagnosticModel {
  if (previous === null) return Object.freeze({ epoch: 1, revision: 1, gate });
  const sameContext =
    previous.gate.environmentId === gate.environmentId &&
    previous.gate.threadId === gate.threadId &&
    previous.gate.providerInstanceId === gate.providerInstanceId;
  if (sameContext && JSON.stringify(previous.gate) === JSON.stringify(gate)) return previous;
  return Object.freeze({
    epoch: sameContext ? previous.epoch : previous.epoch + 1,
    revision: sameContext ? previous.revision + 1 : 1,
    gate,
  });
}

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

export function LiveVoiceControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly providerInstanceId: string | null;
  readonly eligible: boolean;
  readonly availability: LiveVoiceAvailability;
}) {
  const hintId = useId();
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
  const gate = resolveLiveVoiceControlGate({
    environmentId: props.environmentId,
    threadId: props.threadId,
    providerInstanceId: props.providerInstanceId,
    availability: props.availability,
    eligible: props.eligible,
    phase: state.phase,
    RTCPeerConnection: typeof RTCPeerConnection === "undefined" ? undefined : RTCPeerConnection,
    getUserMedia:
      typeof navigator === "undefined" ? undefined : navigator.mediaDevices?.getUserMedia,
  });
  const { active, busy, canStart, reason: unavailableNotice, targetPresent } = gate;
  const target = useMemo<LiveVoiceTarget | null>(() => {
    if (!props.threadId || !props.providerInstanceId || !targetPresent) return null;
    return {
      environmentId: props.environmentId,
      threadId: props.threadId,
      provider: "codex",
      providerInstanceId: props.providerInstanceId,
    };
  }, [targetPresent, props.environmentId, props.providerInstanceId, props.threadId]);
  const bridge = useMemo(() => createVoiceEventBridge(), []);
  const signaling = useMemo<LiveVoiceSignalingAdapter>(
    () => ({
      subscribe: bridge.subscribe,
      prepare: async (input) =>
        unwrapLiveVoiceCommand(await prepare({ environmentId: props.environmentId, input })),
      start: async (input) =>
        unwrapLiveVoiceCommand(await startRpc({ environmentId: props.environmentId, input })),
      stop: async (input) =>
        unwrapLiveVoiceCommand(await stopRpc({ environmentId: props.environmentId, input })),
      status: async (input) =>
        unwrapLiveVoiceCommand(await statusRpc({ environmentId: props.environmentId, input })),
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
  const currentTranscript: LiveVoiceState["transcript"] = transcriptMatchesTarget
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

  const statusText =
    state.phase === "preparing"
      ? "Preparing restricted voice session…"
      : state.phase === "prepared" || state.phase === "connecting"
        ? "Connecting to Live…"
        : state.phase === "playback-blocked"
          ? "Live connected. Audio playback needs permission."
          : state.phase === "reconnecting"
            ? "Live connection interrupted. Reconnecting…"
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
    if (canStart && target) void controller.start(target);
  }, [canStart, controller, target]);

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
          {unavailableNotice ? (
            <span role="status" className="max-w-64 text-xs text-muted-foreground">
              {unavailableNotice}
            </span>
          ) : null}
          {state.phase === "error" ? (
            <span role="status" className="text-xs text-destructive">
              {statusText}
            </span>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              aria-describedby={hintId}
              render={<span className="inline-flex" tabIndex={!canStart ? 0 : undefined} />}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={!canStart}
                onPointerDown={(event) => event.preventDefault()}
                onClick={onStart}
                aria-label="Start voice call"
              >
                <PhoneCallIcon />
              </Button>
            </TooltipTrigger>
            <TooltipPopup id={hintId} role="tooltip">
              {unavailableNotice ?? "Start voice call"}
            </TooltipPopup>
          </Tooltip>
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
