import { describe, expect, it, vi } from "vite-plus/test";
import { LiveVoiceError } from "@t3tools/contracts";

import {
  isLiveVoiceSupported,
  LiveVoiceController,
  type LiveVoiceControllerDependencies,
  type LiveVoiceLease,
  type LiveVoiceTarget,
  type LiveVoicePeer,
  type LiveVoiceSignalEvent,
  type LiveVoiceSignalingAdapter,
} from "./controller.ts";
import { acquireMicrophoneOwnership } from "./microphoneOwnership.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const target: LiveVoiceTarget = {
  environmentId: "env-1",
  threadId: "thread-1",
  provider: "codex",
  providerInstanceId: "codex-1",
};
const lease = {
  ...target,
  leaseId: "lease-1",
  generation: 1,
  providerSessionId: "provider-session-1",
  plannerNativeThreadId: "planner-thread-1",
  status: "prepared",
} as unknown as LiveVoiceLease;
const statusEvent = (session: LiveVoiceLease): LiveVoiceSignalEvent => ({
  type: "status",
  session,
});
const answerEvent: LiveVoiceSignalEvent = {
  type: "answer",
  leaseId: lease.leaseId,
  generation: lease.generation,
  sdp: "answer-sdp",
};

function createHarness(
  options: {
    readonly media?: () => Promise<MediaStream>;
    readonly peer?: LiveVoicePeer;
    readonly startTimeoutMs?: number;
    readonly preparedLease?: LiveVoiceLease;
    readonly status?: () => Promise<LiveVoiceLease>;
    readonly prepare?: () => Promise<LiveVoiceLease>;
    readonly stop?: () => Promise<LiveVoiceLease>;
    readonly subscribeUntilStatus?: boolean;
  } = {},
) {
  const events = new Set<(event: LiveVoiceSignalEvent) => void>();
  const calls: string[] = [];
  const subscribed = deferred<void>();
  const signalingStarted = deferred<void>();
  const remoteDescriptionSet = deferred<void>();
  const stopRequested = deferred<void>();
  const preparedLease = options.preparedLease ?? lease;
  let startTimeout: (() => void) | null = null;
  let timeoutDelayMs: number | null = null;
  let localTrackEnabled = true;
  let stoppedTracks = 0;
  const track = {
    get enabled() {
      return localTrackEnabled;
    },
    set enabled(value: boolean) {
      localTrackEnabled = value;
    },
    stop: vi.fn(() => {
      stoppedTracks += 1;
    }),
  } as unknown as MediaStreamTrack;
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const channel = {
    readyState: "connecting" as RTCDataChannelState,
    close: vi.fn(() => {
      calls.push("channel-close");
    }),
    onopen: null as (() => void) | null,
    onclose: null as (() => void) | null,
  };
  const peer =
    options.peer ??
    ({
      connectionState: "new" as RTCPeerConnectionState,
      createDataChannel: vi.fn((label: string) => {
        calls.push(`channel:${label}`);
        return channel;
      }),
      createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" })),
      setLocalDescription: vi.fn(async () => {
        calls.push("local-offer");
      }),
      setRemoteDescription: vi.fn(async (description: RTCSessionDescriptionInit) => {
        calls.push(`remote:${description.sdp}`);
        remoteDescriptionSet.resolve();
      }),
      addTrack: vi.fn(() => {
        calls.push("add-track");
      }),
      close: vi.fn(() => {
        calls.push("peer-close");
      }),
      onconnectionstatechange: null,
      ontrack: null,
    } as unknown as LiveVoicePeer);
  const signaling: LiveVoiceSignalingAdapter = {
    subscribe: vi.fn(
      (
        input: LiveVoiceLease,
        listener: (event: LiveVoiceSignalEvent) => void,
        signal: AbortSignal,
      ): Promise<() => void> => {
        calls.push("subscribe");
        let resolveSubscription: ((unsubscribe: () => void) => void) | null = null;
        let onAbort: (() => void) | null = null;
        const subscribedListener = (event: LiveVoiceSignalEvent) => {
          listener(event);
          if (
            event.type === "status" &&
            event.session.leaseId === input.leaseId &&
            event.session.generation === input.generation &&
            event.session.environmentId === preparedLease.environmentId &&
            event.session.threadId === preparedLease.threadId &&
            event.session.providerInstanceId === preparedLease.providerInstanceId
          ) {
            if (onAbort) signal.removeEventListener("abort", onAbort);
            resolveSubscription?.(unsubscribe);
          }
        };
        events.add(subscribedListener);
        subscribed.resolve();
        const unsubscribe = () => {
          events.delete(subscribedListener);
          calls.push("unsubscribe");
        };
        if (!options.subscribeUntilStatus) return Promise.resolve(unsubscribe);
        return new Promise<() => void>((resolve, reject) => {
          resolveSubscription = resolve;
          onAbort = () => {
            unsubscribe();
            reject(signal.reason ?? new Error("Subscription aborted."));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    ),
    prepare: vi.fn(async () => {
      calls.push("prepare");
      return options.prepare ? options.prepare() : preparedLease;
    }),
    start: vi.fn(async () => {
      calls.push("signaling-start");
      signalingStarted.resolve();
      return { ...preparedLease, status: "active" } as LiveVoiceLease;
    }),
    status: vi.fn(options.status ?? (async () => preparedLease)),
    stop: vi.fn(async () => {
      calls.push("signaling-stop");
      stopRequested.resolve();
      return options.stop
        ? options.stop()
        : ({ ...preparedLease, status: "closed" } as LiveVoiceLease);
    }),
  };
  const audio = {
    autoplay: false,
    muted: false,
    srcObject: null as MediaStream | null,
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
  } as unknown as HTMLAudioElement;
  const states: string[] = [];
  const remoteStream = { getTracks: () => [] } as unknown as MediaStream;
  const dependencies: LiveVoiceControllerDependencies = {
    signaling,
    getUserMedia: async () => {
      calls.push("media-request");
      return options.media ? options.media() : stream;
    },
    createPeer: () => peer,
    createRemoteStream: vi.fn(() => remoteStream),
    createAudioSink: () => audio,
    createRequestId: (() => {
      let id = 0;
      return () => `request-${++id}`;
    })(),
    ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
    scheduleTimeout: (callback, delayMs) => {
      startTimeout = callback;
      timeoutDelayMs = delayMs;
      return () => {
        startTimeout = null;
        timeoutDelayMs = null;
      };
    },
    onStateChange: (state) => states.push(state.phase),
  };
  const controller = new LiveVoiceController(dependencies);
  return {
    controller,
    signaling,
    peer,
    channel,
    audio,
    remoteStream,
    calls,
    states,
    stream,
    subscribed: subscribed.promise,
    signalingStarted: signalingStarted.promise,
    remoteDescriptionSet: remoteDescriptionSet.promise,
    stopRequested: stopRequested.promise,
    emit: (event: LiveVoiceSignalEvent) => events.forEach((listener) => listener(event)),
    fireStartTimeout: () => startTimeout?.(),
    get hasStartTimeout() {
      return startTimeout !== null;
    },
    get timeoutDelayMs() {
      return timeoutDelayMs;
    },
    get timeoutCallback() {
      return startTimeout;
    },
    get stoppedTracks() {
      return stoppedTracks;
    },
    get localTrackEnabled() {
      return localTrackEnabled;
    },
  };
}

async function connectFirst(harness: ReturnType<typeof createHarness>, starting: Promise<void>) {
  await harness.subscribed;
  harness.emit(statusEvent(lease));
  await harness.signalingStarted;
  expect(harness.calls.indexOf("prepare")).toBeLessThan(harness.calls.indexOf("subscribe"));
  expect(harness.calls.indexOf("subscribe")).toBeLessThan(harness.calls.indexOf("local-offer"));
  harness.emit({ type: "answer", leaseId: "stale", generation: lease.generation, sdp: "wrong" });
  harness.emit(answerEvent);
  await harness.remoteDescriptionSet;
  expect(harness.controller.currentState.phase).toBe("connecting");
  harness.channel.readyState = "open";
  harness.channel.onopen?.();
  (harness.peer as { connectionState: RTCPeerConnectionState }).connectionState = "connected";
  harness.peer.onconnectionstatechange?.();
  harness.peer.ontrack?.({
    streams: [],
    track: {} as MediaStreamTrack,
  } as unknown as RTCTrackEvent);
  await starting;
}

async function connect(harness: ReturnType<typeof createHarness>, starting: Promise<void>) {
  await vi.waitFor(() => expect(harness.calls).toContain("subscribe"));
  harness.emit(statusEvent(lease));
  await vi.waitFor(() => expect(harness.calls).toContain("signaling-start"));
  expect(harness.calls.indexOf("prepare")).toBeLessThan(harness.calls.indexOf("subscribe"));
  expect(harness.calls.indexOf("subscribe")).toBeLessThan(harness.calls.indexOf("local-offer"));
  harness.emit({ type: "answer", leaseId: "stale", generation: lease.generation, sdp: "wrong" });
  harness.emit(answerEvent);
  await vi.waitFor(() => expect(harness.calls).toContain("remote:answer-sdp"));
  expect(harness.controller.currentState.phase).toBe("connecting");
  harness.channel.readyState = "open";
  harness.channel.onopen?.();
  (harness.peer as { connectionState: RTCPeerConnectionState }).connectionState = "connected";
  harness.peer.onconnectionstatechange?.();
  harness.peer.ontrack?.({
    streams: [],
    track: {} as MediaStreamTrack,
  } as unknown as RTCTrackEvent);
  await starting;
}

describe("LiveVoiceController", () => {
  it.each([false, true])(
    "recovers on the same lease with mute controls available (playback blocked: %s)",
    async (playbackBlocked) => {
      const harness = createHarness();
      if (playbackBlocked) {
        vi.mocked(harness.audio.play).mockRejectedValue(new Error("autoplay blocked"));
      }
      await connectFirst(harness, harness.controller.start(target));
      const connectionChanged = harness.peer.onconnectionstatechange!;
      (harness.peer as { connectionState: RTCPeerConnectionState }).connectionState =
        "disconnected";
      connectionChanged();

      expect(harness.controller.currentState.phase).toBe("reconnecting");
      expect(harness.timeoutDelayMs).toBe(15_000);
      const deadline = harness.timeoutCallback;
      connectionChanged();
      expect(harness.timeoutCallback).toBe(deadline);
      harness.controller.setLocalMuted(true);
      await harness.controller.setOutputMuted(true);
      await harness.controller.start(target);
      expect(harness.localTrackEnabled).toBe(false);
      expect(harness.audio.muted).toBe(true);
      expect(harness.signaling.prepare).toHaveBeenCalledOnce();
      expect(harness.signaling.start).toHaveBeenCalledOnce();
      expect(harness.signaling.stop).not.toHaveBeenCalled();

      (harness.peer as { connectionState: RTCPeerConnectionState }).connectionState = "connected";
      connectionChanged();
      expect(harness.controller.currentState).toMatchObject({
        phase: playbackBlocked ? "playback-blocked" : "live",
        localMuted: true,
        outputMuted: true,
        lease: { leaseId: lease.leaseId, generation: lease.generation },
      });
      expect(harness.hasStartTimeout).toBe(false);
      expect(harness.stoppedTracks).toBe(0);
      deadline?.();
      expect(harness.controller.currentState.phase).toBe(
        playbackBlocked ? "playback-blocked" : "live",
      );
      expect(harness.signaling.stop).not.toHaveBeenCalled();
      (harness.peer as { connectionState: RTCPeerConnectionState }).connectionState =
        "disconnected";
      connectionChanged();
      deadline?.();
      expect(harness.controller.currentState.phase).toBe("reconnecting");
      expect(harness.signaling.stop).not.toHaveBeenCalled();
      await harness.controller.end();
    },
  );

  it("releases local media at the reconnect deadline even when remote stop is still pending", async () => {
    const remoteStop = deferred<LiveVoiceLease>();
    const harness = createHarness({ stop: () => remoteStop.promise });
    await connectFirst(harness, harness.controller.start(target));
    const lateConnectionChanged = harness.peer.onconnectionstatechange!;
    (harness.peer as { connectionState: RTCPeerConnectionState }).connectionState = "disconnected";
    lateConnectionChanged();
    harness.fireStartTimeout();

    expect(harness.controller.currentState).toMatchObject({
      phase: "error",
      error: "Live voice connection was lost. Start a new call to reconnect.",
    });
    expect(harness.stoppedTracks).toBe(1);
    expect(harness.peer.close).toHaveBeenCalledOnce();
    expect(harness.channel.close).toHaveBeenCalledOnce();
    expect(harness.audio.srcObject).toBeNull();
    const releaseNextOwner = acquireMicrophoneOwnership();
    expect(releaseNextOwner).not.toBeNull();
    releaseNextOwner?.();
    await harness.stopRequested;
    expect(harness.signaling.stop).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: lease.leaseId, generation: lease.generation }),
    );
    (harness.peer as { connectionState: RTCPeerConnectionState }).connectionState = "connected";
    lateConnectionChanged();
    expect(harness.controller.currentState.phase).toBe("error");
    remoteStop.resolve({ ...lease, status: "closed" });
    await harness.controller.end();
  });

  it("ends during reconnect and fences late connection events without starting another call", async () => {
    const harness = createHarness();
    await connectFirst(harness, harness.controller.start(target));
    const lateConnectionChanged = harness.peer.onconnectionstatechange!;
    (harness.peer as { connectionState: RTCPeerConnectionState }).connectionState = "disconnected";
    lateConnectionChanged();
    await harness.controller.end();
    expect(harness.hasStartTimeout).toBe(false);
    expect(harness.stoppedTracks).toBe(1);
    (harness.peer as { connectionState: RTCPeerConnectionState }).connectionState = "connected";
    lateConnectionChanged();
    harness.fireStartTimeout();
    expect(harness.controller.currentState.phase).toBe("ended");
    expect(harness.signaling.prepare).toHaveBeenCalledOnce();
    expect(harness.signaling.stop).toHaveBeenCalledOnce();
  });

  it("does not start Live while dictation owns the renderer microphone", async () => {
    const releaseDictation = acquireMicrophoneOwnership();
    expect(releaseDictation).not.toBeNull();
    const harness = createHarness();

    await harness.controller.start(target);

    expect(harness.controller.currentState).toMatchObject({
      phase: "error",
      error: "Another live microphone session is active.",
    });
    expect(harness.signaling.prepare).not.toHaveBeenCalled();
    expect(harness.calls).not.toContain("media-request");
    expect(acquireMicrophoneOwnership()).toBeNull();

    releaseDictation?.();
    const starting = harness.controller.start(target);
    await vi.waitFor(() => expect(harness.calls).toContain("subscribe"));
    await harness.controller.end();
    await starting;
  });

  it("keeps the microphone reserved until an ended permission request settles and late tracks stop", async () => {
    const permission = deferred<MediaStream>();
    const harness = createHarness({ media: () => permission.promise });
    const starting = harness.controller.start(target);
    await vi.waitFor(() => expect(harness.calls).toContain("subscribe"));
    harness.emit(statusEvent(lease));
    await vi.waitFor(() => expect(harness.calls).toContain("media-request"));

    await harness.controller.end();
    await harness.controller.start(target);
    expect(harness.calls.filter((call) => call === "media-request")).toHaveLength(1);
    expect(acquireMicrophoneOwnership()).toBeNull();

    permission.resolve(harness.stream);
    await starting;
    expect(harness.stoppedTracks).toBe(1);
    const releaseNextOwner = acquireMicrophoneOwnership();
    expect(releaseNextOwner).not.toBeNull();
    releaseNextOwner?.();
  });

  it("releases microphone ownership after permission is denied", async () => {
    const harness = createHarness({ media: () => Promise.reject(new Error("permission denied")) });
    const starting = harness.controller.start(target);
    await vi.waitFor(() => expect(harness.calls).toContain("subscribe"));
    harness.emit(statusEvent(lease));
    await starting;

    expect(harness.controller.currentState.phase).toBe("error");
    const releaseNextOwner = acquireMicrophoneOwnership();
    expect(releaseNextOwner).not.toBeNull();
    releaseNextOwner?.();
  });

  it("does not let a stale release closure clear a later microphone owner", () => {
    const releaseFirst = acquireMicrophoneOwnership();
    expect(releaseFirst).not.toBeNull();
    releaseFirst?.();
    const releaseSecond = acquireMicrophoneOwnership();
    expect(releaseSecond).not.toBeNull();

    releaseFirst?.();
    expect(acquireMicrophoneOwnership()).toBeNull();
    releaseSecond?.();
    const releaseThird = acquireMicrophoneOwnership();
    expect(releaseThird).not.toBeNull();
    releaseThird?.();
  });

  it("prepares the authenticated lease, subscribes before SDP, and waits for all RTC readiness evidence", async () => {
    const harness = createHarness();
    const starting = harness.controller.start(target);
    await vi.waitFor(() => expect(harness.calls).toContain("subscribe"));
    expect(harness.calls).not.toContain("local-offer");
    harness.emit(statusEvent({ ...lease, environmentId: "stale" } as LiveVoiceLease));
    await Promise.resolve();
    expect(harness.calls).not.toContain("local-offer");
    harness.emit(statusEvent(lease));
    await vi.waitFor(() => expect(harness.calls).toContain("local-offer"));
    expect(harness.signaling.prepare).toHaveBeenCalledWith(
      { threadId: target.threadId, clientRequestId: "request-1" },
      expect.any(AbortSignal),
    );
    expect(harness.calls.indexOf("subscribe")).toBeLessThan(harness.calls.indexOf("local-offer"));
    expect(harness.signaling.start).toHaveBeenCalledWith(
      {
        leaseId: lease.leaseId,
        generation: 1,
        offerSdp: "offer-sdp",
        clientRequestId: "request-2",
      },
      expect.any(AbortSignal),
    );
    expect(harness.controller.currentState.phase).toBe("connecting");
    await connect(harness, starting);
    expect(harness.controller.currentState.phase).toBe("live");
    expect(harness.audio.srcObject).toBe(harness.remoteStream);
    expect(harness.audio.play).toHaveBeenCalled();
    expect(harness.calls).toContain("channel:oai-events");
    await harness.controller.end();
  });

  it("stops tracks granted after the selected environment changes during permission", async () => {
    const permission = deferred<MediaStream>();
    const harness = createHarness({ media: () => permission.promise });
    const starting = harness.controller.start(target);
    await vi.waitFor(() => expect(harness.calls).toContain("subscribe"));
    harness.emit(statusEvent(lease));
    await vi.waitFor(() => expect(harness.calls).toContain("media-request"));
    await harness.controller.contextChanged({ ...target, environmentId: "other" });
    permission.resolve(harness.stream);
    await starting;
    expect(harness.stoppedTracks).toBe(1);
    expect(harness.peer.createDataChannel).not.toHaveBeenCalled();
    expect(harness.controller.currentState.phase).toBe("ended");
  });

  it("recovers null native identities through status before requesting microphone access", async () => {
    const recovery = deferred<LiveVoiceLease>();
    const unresolved = {
      ...lease,
      providerSessionId: null,
      plannerNativeThreadId: null,
      status: "preparing",
    } as LiveVoiceLease;
    const getUserMedia = vi.fn(async () => createHarness().stream);
    const harness = createHarness({
      preparedLease: unresolved,
      status: () => recovery.promise,
      media: getUserMedia,
    });
    const starting = harness.controller.start(target);
    await vi.waitFor(() => expect(harness.calls).toContain("subscribe"));
    harness.emit(statusEvent(unresolved));
    await vi.waitFor(() => expect(harness.signaling.status).toHaveBeenCalledOnce());
    expect(getUserMedia).not.toHaveBeenCalled();
    recovery.resolve(lease);
    await vi.waitFor(() => expect(harness.calls).toContain("signaling-start"));
    expect(getUserMedia).toHaveBeenCalledOnce();
    harness.emit(answerEvent);
    await vi.waitFor(() => expect(harness.calls).toContain("remote:answer-sdp"));
    harness.channel.readyState = "open";
    harness.channel.onopen?.();
    (harness.peer as { connectionState: RTCPeerConnectionState }).connectionState = "connected";
    harness.peer.onconnectionstatechange?.();
    harness.peer.ontrack?.({
      streams: [],
      track: {} as MediaStreamTrack,
    } as unknown as RTCTrackEvent);
    await starting;
    expect(harness.controller.currentState.phase).toBe("live");
    await harness.controller.end();
  });

  it("releases media, peer and lease when applying the SDP answer fails", async () => {
    const brokenPeer = {
      connectionState: "new",
      createDataChannel: vi.fn(() => ({
        readyState: "connecting",
        close: vi.fn(),
        onopen: null,
        onclose: null,
      })),
      createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" })),
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => {
        throw new Error("private upstream detail");
      }),
      addTrack: vi.fn(),
      close: vi.fn(),
      onconnectionstatechange: null,
      ontrack: null,
    } as unknown as LiveVoicePeer;
    const harness = createHarness({ peer: brokenPeer });
    const starting = harness.controller.start(target);
    await vi.waitFor(() => expect(harness.calls).toContain("subscribe"));
    harness.emit(statusEvent(lease));
    await vi.waitFor(() => expect(harness.calls).toContain("signaling-start"));
    harness.emit(answerEvent);
    await starting;
    expect(harness.controller.currentState).toMatchObject({ phase: "error" });
    expect(harness.controller.currentState.error).not.toContain("private upstream detail");
    expect(brokenPeer.close).toHaveBeenCalledOnce();
    expect(harness.stoppedTracks).toBe(1);
    expect(harness.signaling.stop).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: lease.leaseId, generation: lease.generation }),
    );
  });

  it("mutes only local input/output and End Live stops signaling without cancelling T3 work", async () => {
    const harness = createHarness();
    const starting = harness.controller.start(target);
    await connect(harness, starting);
    harness.controller.setLocalMuted(true);
    await harness.controller.setOutputMuted(true);
    expect(harness.localTrackEnabled).toBe(false);
    expect(harness.controller.currentState.localMuted).toBe(true);
    expect(harness.controller.currentState.outputMuted).toBe(true);
    expect(harness.audio.muted).toBe(true);
    await harness.controller.end();
    expect(harness.localTrackEnabled).toBe(false);
    expect(harness.signaling.stop).toHaveBeenCalledOnce();
    expect(harness.controller.currentState.phase).toBe("ended");
  });

  it("bounds startup, cleans up the prepared lease, and rejects unsupported providers/surfaces", async () => {
    const harness = createHarness();
    const starting = harness.controller.start(target);
    await vi.waitFor(() => expect(harness.calls).toContain("subscribe"));
    harness.emit(statusEvent(lease));
    await vi.waitFor(() => expect(harness.calls).toContain("signaling-start"));
    harness.fireStartTimeout();
    await starting;
    expect(harness.controller.currentState.phase).toBe("error");
    expect(harness.signaling.stop).toHaveBeenCalledOnce();
    expect(harness.stoppedTracks).toBe(1);
    function FakeRTCPeerConnection() {}
    expect(
      isLiveVoiceSupported({
        provider: "claude",
        RTCPeerConnection: FakeRTCPeerConnection,
        getUserMedia: () => undefined,
      }),
    ).toBe(false);
    expect(isLiveVoiceSupported({ provider: "codex" })).toBe(false);
  });

  it("marks blocked browser playback separately from RTC readiness and can retry", async () => {
    const harness = createHarness();
    harness.audio.play = vi.fn(async () => {
      throw new Error("autoplay blocked");
    });
    const starting = harness.controller.start(target);
    await connect(harness, starting);
    expect(harness.controller.currentState.phase).toBe("playback-blocked");
    harness.audio.play = vi.fn(async () => undefined);
    await harness.controller.retryPlayback();
    expect(harness.controller.currentState.phase).toBe("live");
    await harness.controller.end();
  });

  it("does not let a rejected prepare from End A tear down a newer connected Start B", async () => {
    const prepareA = deferred<LiveVoiceLease>();
    let prepares = 0;
    const harness = createHarness({
      prepare: () => {
        prepares += 1;
        return prepares === 1 ? prepareA.promise : Promise.resolve(lease);
      },
    });
    const startingA = harness.controller.start(target);
    await vi.waitFor(() => expect(harness.calls).toContain("prepare"));
    await harness.controller.end();
    const startingB = harness.controller.start(target);
    await connect(harness, startingB);
    expect(harness.controller.currentState.phase).toBe("live");

    prepareA.reject(new Error("prepare A failed late"));
    await startingA;
    expect(harness.controller.currentState.phase).toBe("live");
    expect(harness.stoppedTracks).toBe(0);
    expect(harness.peer.close).not.toHaveBeenCalled();
    await harness.controller.end();
  });

  it("releases microphone tracks before waiting for a slow remote stop", async () => {
    const remoteStop = deferred<LiveVoiceLease>();
    const harness = createHarness({ stop: () => remoteStop.promise });
    const starting = harness.controller.start(target);
    await connect(harness, starting);

    const ending = harness.controller.end();
    expect(harness.stoppedTracks).toBe(1);
    await vi.waitFor(() => expect(harness.signaling.stop).toHaveBeenCalledOnce());
    remoteStop.resolve({ ...lease, status: "closed" } as LiveVoiceLease);
    await ending;
    expect(harness.controller.currentState.phase).toBe("ended");
  });

  it("keeps the startup deadline and connecting state when playback retry succeeds before datachannel readiness", async () => {
    const harness = createHarness();
    harness.audio.play = vi.fn(async () => {
      throw new Error("autoplay blocked");
    });
    const starting = harness.controller.start(target);
    await vi.waitFor(() => expect(harness.calls).toContain("subscribe"));
    harness.emit(statusEvent(lease));
    await vi.waitFor(() => expect(harness.calls).toContain("signaling-start"));
    harness.emit(answerEvent);
    await vi.waitFor(() => expect(harness.calls).toContain("remote:answer-sdp"));
    harness.peer.ontrack?.({
      streams: [],
      track: {} as MediaStreamTrack,
    } as unknown as RTCTrackEvent);
    await vi.waitFor(() => expect(harness.audio.play).toHaveBeenCalled());
    expect(harness.controller.currentState.phase).toBe("connecting");

    harness.audio.play = vi.fn(async () => undefined);
    await harness.controller.retryPlayback();
    expect(harness.controller.currentState.phase).toBe("connecting");
    expect(harness.hasStartTimeout).toBe(true);
    harness.fireStartTimeout();
    await starting;
    expect(harness.controller.currentState.phase).toBe("error");
    expect(harness.stoppedTracks).toBe(1);
  });

  it.each([
    ["End Live", "end"],
    ["the startup deadline", "timeout"],
  ] as const)("handles %s while subscribe waits for initial status", async (_label, finish) => {
    const harness = createHarness({ subscribeUntilStatus: true });
    const starting = harness.controller.start(target);
    await vi.waitFor(() => expect(harness.calls).toContain("subscribe"));

    if (finish === "end") await harness.controller.end();
    else harness.fireStartTimeout();

    await starting;
    expect(harness.controller.currentState.phase).toBe(finish === "end" ? "ended" : "error");
    expect(harness.calls).toContain("unsubscribe");
    expect(harness.signaling.stop).toHaveBeenCalledOnce();
    expect(harness.stoppedTracks).toBe(0);
    expect(harness.calls).not.toContain("media-request");
  });

  it("settles startup when End Live interrupts RTC readiness after SDP", async () => {
    const harness = createHarness();
    const starting = harness.controller.start(target);
    await vi.waitFor(() => expect(harness.calls).toContain("subscribe"));
    harness.emit(statusEvent(lease));
    await vi.waitFor(() => expect(harness.calls).toContain("signaling-start"));
    harness.emit(answerEvent);
    await vi.waitFor(() => expect(harness.calls).toContain("remote:answer-sdp"));

    await harness.controller.end();
    await starting;

    expect(harness.controller.currentState.phase).toBe("ended");
    expect(harness.stoppedTracks).toBe(1);
    expect(harness.channel.onopen).toBeNull();
    expect(harness.channel.onclose).toBeNull();
    expect(harness.signaling.stop).toHaveBeenCalledOnce();
  });

  it("cleans up an unanswered SDP wait when start RPC fails with a public voice category", async () => {
    const harness = createHarness();
    vi.mocked(harness.signaling.start).mockRejectedValueOnce(
      new LiveVoiceError({ code: "managed_account_required" }),
    );
    const starting = harness.controller.start(target);
    await vi.waitFor(() => expect(harness.calls).toContain("subscribe"));
    harness.emit(statusEvent(lease));
    await starting;
    expect(harness.controller.currentState).toMatchObject({
      phase: "error",
      error: "Sign in to a supported ChatGPT account to use Live voice.",
    });
    expect(harness.stoppedTracks).toBe(1);
    expect(harness.signaling.stop).toHaveBeenCalledOnce();
  });

  it("settles an ended preparation when the status RPC rejects late", async () => {
    const recovery = deferred<LiveVoiceLease>();
    const unresolved = {
      ...lease,
      providerSessionId: null,
      plannerNativeThreadId: null,
      status: "preparing",
    } as LiveVoiceLease;
    const harness = createHarness({
      preparedLease: unresolved,
      status: () => recovery.promise,
    });
    const starting = harness.controller.start(target);
    await vi.waitFor(() => expect(harness.calls).toContain("subscribe"));
    harness.emit(statusEvent(unresolved));
    await vi.waitFor(() => expect(harness.signaling.status).toHaveBeenCalledOnce());
    await harness.controller.end();
    recovery.reject(new Error("private late status failure"));
    await starting;
    expect(harness.controller.currentState.phase).toBe("ended");
    expect(harness.calls).not.toContain("media-request");
    expect(harness.signaling.stop).toHaveBeenCalledOnce();
  });

  it("keeps the ended call transcript available while releasing all media", async () => {
    const harness = createHarness();
    await connect(harness, harness.controller.start(target));
    harness.emit({
      type: "transcript",
      leaseId: lease.leaseId,
      generation: lease.generation,
      role: "user",
      text: "Keep this call transcript",
    });
    harness.emit({
      type: "transcript",
      leaseId: lease.leaseId,
      generation: lease.generation,
      role: "assistant",
      text: "The call has a useful answer",
    });
    await harness.controller.end();
    expect(harness.controller.currentState.phase).toBe("ended");
    expect(harness.controller.currentState.transcript.map((entry) => entry.text)).toEqual([
      "Keep this call transcript",
      "The call has a useful answer",
    ]);
    expect(harness.controller.currentState.lease?.threadId).toBe(target.threadId);
    expect(harness.stoppedTracks).toBe(1);
    expect(harness.audio.srcObject).toBeNull();
    expect(harness.calls).toContain("peer-close");
    harness.emit({
      type: "transcript",
      leaseId: lease.leaseId,
      generation: lease.generation,
      role: "assistant",
      text: "Late speech must be ignored",
    });
    expect(harness.controller.currentState.transcript).toHaveLength(2);
  });

  it("unsubscribes a late subscription without replacing a newer call's listener", async () => {
    const harness = createHarness();
    const subscription = deferred<() => void>();
    const unsubscribeLate = vi.fn();
    vi.mocked(harness.signaling.subscribe).mockImplementationOnce(() => subscription.promise);
    const firstStart = harness.controller.start(target);
    await vi.waitFor(() => expect(harness.signaling.subscribe).toHaveBeenCalledOnce());
    await harness.controller.end();

    const secondStart = harness.controller.start(target);
    await connect(harness, secondStart);
    subscription.resolve(unsubscribeLate);
    await firstStart;
    expect(unsubscribeLate).toHaveBeenCalledOnce();

    harness.emit({
      type: "transcript",
      leaseId: lease.leaseId,
      generation: lease.generation,
      role: "assistant",
      text: "The new call still receives events",
    });
    expect(harness.controller.currentState.transcript.at(-1)?.text).toBe(
      "The new call still receives events",
    );
    await harness.controller.end();
    expect(harness.calls.filter((call) => call === "unsubscribe")).toHaveLength(1);
  });
});

describe("native preparation configuration fencing", () => {
  it("sends the captured same-instance expectation only after deliberate Start", async () => {
    const pending = deferred<LiveVoiceLease>();
    const harness = createHarness({ prepare: () => pending.promise });
    const bound = { ...target, preparationConfigurationId: "configuration-1" };
    expect(harness.signaling.prepare).not.toHaveBeenCalled();
    const starting = harness.controller.start(bound);
    expect(harness.signaling.prepare).toHaveBeenCalledWith(
      {
        threadId: target.threadId,
        clientRequestId: expect.any(String),
        nativePreparation: {
          providerInstanceId: target.providerInstanceId,
          configurationId: "configuration-1",
        },
      },
      expect.any(AbortSignal),
    );
    await harness.controller.contextChanged({
      ...bound,
      preparationConfigurationId: "configuration-2",
    });
    pending.resolve(lease);
    await starting;
    expect(harness.signaling.stop).toHaveBeenCalledOnce();
    expect(harness.calls).not.toContain("add-track");
    expect(harness.calls).not.toContain("signaling-start");
  });
});
