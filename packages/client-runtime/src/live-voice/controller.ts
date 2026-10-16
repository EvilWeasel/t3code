import {
  LiveVoiceError,
  liveVoicePublicErrorMessage,
  type LiveVoiceEvent,
  type LiveVoicePrepareInput,
  type LiveVoiceSession,
  type LiveVoiceStartInput,
  type LiveVoiceStopInput,
  type LiveVoiceSubscribeInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { acquireMicrophoneOwnership } from "./microphoneOwnership.ts";

/** Owns one browser WebRTC session; all authenticated lease/signaling work is injected. */

export type LiveVoiceTarget = {
  readonly environmentId: string;
  readonly threadId: string;
  readonly provider: string;
  readonly providerInstanceId: string;
};

/** The workspace Codex thread and the restricted voice planner are different native threads. */
export type LiveVoiceLease = LiveVoiceSession;

export type LiveVoiceIdentity = LiveVoiceLease;

export type LiveVoiceSignalEvent = LiveVoiceEvent;

export interface LiveVoiceSignalingAdapter {
  /** Resolve only after a matching initial status proves the server stream is registered. */
  subscribe(
    lease: LiveVoiceLease,
    listener: (event: LiveVoiceSignalEvent) => void,
    signal: AbortSignal,
  ): Promise<() => void>;
  prepare(input: LiveVoicePrepareInput, signal: AbortSignal): Promise<LiveVoiceLease>;
  start(input: LiveVoiceStartInput, signal: AbortSignal): Promise<LiveVoiceSession>;
  status(input: LiveVoiceSubscribeInput): Promise<LiveVoiceSession>;
  stop(input: LiveVoiceStopInput): Promise<LiveVoiceSession>;
}

export type LiveVoicePeer = Pick<
  RTCPeerConnection,
  | "connectionState"
  | "createDataChannel"
  | "createOffer"
  | "setLocalDescription"
  | "setRemoteDescription"
  | "addTrack"
  | "close"
> & {
  onconnectionstatechange: (() => void) | null;
  ontrack: ((event: Pick<RTCTrackEvent, "streams" | "track">) => void) | null;
};

export type LiveVoiceDataChannel = Pick<RTCDataChannel, "readyState" | "close"> & {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
};

export type LiveVoiceMediaStream = Pick<MediaStream, "getAudioTracks" | "getTracks">;
export type LiveVoiceAudioTrack = Pick<MediaStreamTrack, "enabled" | "stop">;
export type LiveVoiceTranscript = {
  readonly speaker: "user" | "assistant";
  readonly text: string;
  readonly final: boolean;
};
export type LiveVoicePhase =
  | "idle"
  | "preparing"
  | "prepared"
  | "connecting"
  | "live"
  | "reconnecting"
  | "playback-blocked"
  | "stopping"
  | "ended"
  | "error";
export type LiveVoiceState = {
  readonly phase: LiveVoicePhase;
  readonly localMuted: boolean;
  readonly outputMuted: boolean;
  readonly transcript: ReadonlyArray<LiveVoiceTranscript>;
  readonly sessionStatus: LiveVoiceSession["status"] | null;
  readonly lease: LiveVoiceLease | null;
  readonly error: string | null;
};

export type LiveVoiceControllerDependencies = {
  readonly signaling: LiveVoiceSignalingAdapter;
  readonly beforePrepare?: (target: LiveVoiceTarget, signal: AbortSignal) => Promise<void>;
  readonly getUserMedia: () => Promise<LiveVoiceMediaStream>;
  readonly createPeer: () => LiveVoicePeer;
  readonly createRemoteStream: (track: MediaStreamTrack) => MediaStream;
  readonly createAudioSink: () => HTMLAudioElement;
  readonly createRequestId: () => string;
  readonly startTimeoutMs?: number;
  readonly scheduleTimeout: (callback: () => void, delayMs: number) => () => void;
  readonly onStateChange: (state: LiveVoiceState) => void;
};

type MicrophoneOwnership = {
  readonly release: () => void;
  mediaRequestPending: boolean;
};

const IDLE_STATE: LiveVoiceState = {
  phase: "idle",
  localMuted: false,
  outputMuted: false,
  transcript: [],
  sessionStatus: null,
  lease: null,
  error: null,
};
const MAX_TRANSCRIPT_ENTRIES = 24;
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_TIMEOUT_MS = 15_000;
const isLiveVoiceError = Schema.is(LiveVoiceError);
function stopTracks(stream: LiveVoiceMediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function identityMatchesTarget(identity: LiveVoiceIdentity, target: LiveVoiceTarget): boolean {
  return (
    identity.environmentId === target.environmentId &&
    identity.threadId === target.threadId &&
    identity.providerInstanceId === target.providerInstanceId
  );
}

function eventMatchesLease(event: LiveVoiceEvent, lease: LiveVoiceSession): boolean {
  if (event.type === "status") {
    return (
      event.session.leaseId === lease.leaseId &&
      event.session.generation === lease.generation &&
      event.session.environmentId === lease.environmentId &&
      event.session.threadId === lease.threadId &&
      event.session.providerInstanceId === lease.providerInstanceId
    );
  }
  return event.leaseId === lease.leaseId && event.generation === lease.generation;
}

function sessionMatchesLease(session: LiveVoiceSession, lease: LiveVoiceSession): boolean {
  return (
    session.leaseId === lease.leaseId &&
    session.generation === lease.generation &&
    session.environmentId === lease.environmentId &&
    session.threadId === lease.threadId &&
    session.providerInstanceId === lease.providerInstanceId
  );
}

function safeErrorMessage(error: unknown): string {
  if (isLiveVoiceError(error)) return liveVoicePublicErrorMessage(error.code);
  const localMessages = new Set([
    "Live voice preparation is still pending. Try again shortly.",
    "The prepared Live session does not match the selected thread.",
    "The browser did not create a WebRTC offer.",
    "Live session did not become ready in time.",
    "WebRTC connection ended.",
    "Live voice connection was lost. Start a new call to reconnect.",
    "Live data channel closed.",
    "Live session closed by the environment.",
    "The selected voice thread changed. Start again.",
    "The voice thread could not be saved. Reconnect and try again.",
  ]);
  if (error instanceof Error && localMessages.has(error.message)) return error.message;
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "NotAllowedError"
  ) {
    return "Allow microphone access to start Live voice.";
  }
  return "Live voice could not connect. Check microphone access and connection, then try again.";
}

export class LiveVoiceController {
  private readonly dependencies: LiveVoiceControllerDependencies;
  private state: LiveVoiceState = IDLE_STATE;
  private target: LiveVoiceTarget | null = null;
  private identity: LiveVoiceIdentity | null = null;
  private operation = 0;
  private abortController: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  private stream: LiveVoiceMediaStream | null = null;
  private peer: LiveVoicePeer | null = null;
  private channel: LiveVoiceDataChannel | null = null;
  private audio: HTMLAudioElement | null = null;
  private remoteMediaReady = false;
  private remoteDescriptionReady = false;
  private playbackBlocked = false;
  private channelIsOpen = false;
  private peerIsConnected = false;
  private cancelStartTimer: (() => void) | null = null;
  private cancelReconnectTimer: (() => void) | null = null;
  private answer: ((sdp: string) => void) | null = null;
  private rejectAnswer: ((error: Error) => void) | null = null;
  private resolvePrepared: ((session: LiveVoiceSession) => void) | null = null;
  private rejectPrepared: ((error: Error) => void) | null = null;
  private resolveSubscriptionReady: (() => void) | null = null;
  private rejectSubscriptionReady: ((error: Error) => void) | null = null;
  private resolveRtcReady: (() => void) | null = null;
  private rejectRtcReady: ((error: Error) => void) | null = null;
  private rtcReady: Promise<void> | null = null;
  private microphoneOwnership: MicrophoneOwnership | null = null;
  private readonly stopRequestIds = new Map<string, string>();
  private readonly stopRequests = new Map<string, Promise<void>>();

  constructor(dependencies: LiveVoiceControllerDependencies) {
    this.dependencies = dependencies;
  }

  get currentState(): LiveVoiceState {
    return this.state;
  }

  async start(target: LiveVoiceTarget): Promise<void> {
    if (
      this.state.phase === "preparing" ||
      this.state.phase === "prepared" ||
      this.state.phase === "connecting" ||
      this.state.phase === "live" ||
      this.state.phase === "reconnecting" ||
      this.state.phase === "stopping" ||
      this.state.phase === "playback-blocked"
    )
      return;
    if (target.provider !== "codex") {
      this.setState({
        ...IDLE_STATE,
        phase: "error",
        error: "Live voice is only available for Codex threads.",
      });
      return;
    }
    if (this.microphoneOwnership?.mediaRequestPending) {
      this.setState({
        ...IDLE_STATE,
        phase: "error",
        error: "A microphone permission request is still finishing. Try again shortly.",
      });
      return;
    }
    const releaseMicrophone = acquireMicrophoneOwnership();
    if (!releaseMicrophone) {
      this.setState({
        ...IDLE_STATE,
        phase: "error",
        error: "Another live microphone session is active.",
      });
      return;
    }

    const operation = ++this.operation;
    const microphoneOwnership: MicrophoneOwnership = {
      release: releaseMicrophone,
      mediaRequestPending: false,
    };
    this.microphoneOwnership = microphoneOwnership;
    this.target = target;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.setState({ ...IDLE_STATE, phase: "preparing" });
    this.cancelStartTimer = this.dependencies.scheduleTimeout(() => {
      if (this.identity) {
        void this.failAndStop(
          operation,
          this.identity,
          new Error("Live session did not become ready in time."),
        );
      } else if (operation === this.operation) {
        ++this.operation;
        this.abortController?.abort();
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.releaseMicrophoneIfReady(microphoneOwnership);
        this.target = null;
        this.setState({
          ...this.state,
          phase: "error",
          error: "Live session did not become ready in time.",
        });
      }
    }, this.dependencies.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    let lease: LiveVoiceLease | null = null;

    try {
      if (this.dependencies.beforePrepare) {
        await this.dependencies.beforePrepare(target, signal);
        if (!this.isCurrentTarget(operation, target)) return;
      }
      // The server authenticates and binds the selected T3 destination before WebRTC exists.
      lease = await this.dependencies.signaling.prepare(
        {
          threadId: target.threadId as LiveVoicePrepareInput["threadId"],
          clientRequestId: this.dependencies.createRequestId(),
        },
        signal,
      );
      if (!this.isCurrentTarget(operation, target)) {
        await this.stopLease(lease);
        return;
      }
      if (!identityMatchesTarget(lease, target))
        throw new Error("The prepared Live session does not match the selected thread.");
      this.identity = lease;
      this.setState({
        ...this.state,
        phase: lease.status === "prepared" ? "prepared" : "preparing",
        sessionStatus: lease.status,
        lease,
        error: null,
      });
      const subscriptionReady = new Promise<void>((resolve, reject) => {
        this.resolveSubscriptionReady = resolve;
        this.rejectSubscriptionReady = reject;
      });
      // subscribe() may stay pending until the server emits its initial status.
      // End/timeout can reject this barrier before subscribe() settles, so attach
      // a handler now while still awaiting the original promise below.
      void subscriptionReady.catch(() => undefined);
      const unsubscribe = await this.dependencies.signaling.subscribe(
        lease,
        (event) => this.onSignal(operation, event),
        signal,
      );
      if (!this.isCurrentLease(operation, lease)) {
        unsubscribe();
        return;
      }
      this.unsubscribe = unsubscribe;
      await subscriptionReady;
      if (!this.isCurrentLease(operation, lease)) return;
      let prepared = lease;
      if (lease.status !== "prepared" || !lease.providerSessionId || !lease.plannerNativeThreadId) {
        const ready = new Promise<LiveVoiceSession>((resolve, reject) => {
          this.resolvePrepared = resolve;
          this.rejectPrepared = reject;
        });
        void ready.catch(() => undefined);
        const current = await this.dependencies.signaling.status({
          leaseId: lease.leaseId,
          generation: lease.generation,
        });
        this.acceptSessionStatus(operation, lease, current);
        prepared = await ready;
      }
      if (!this.isCurrentLease(operation, prepared)) return;
      if (!prepared.providerSessionId || !prepared.plannerNativeThreadId)
        throw new Error("Live voice preparation is still pending. Try again shortly.");
      lease = prepared;
      const activeLease = prepared;
      this.setState({
        ...this.state,
        phase: "prepared",
        sessionStatus: prepared.status,
        lease: prepared,
        error: null,
      });

      microphoneOwnership.mediaRequestPending = true;
      let stream: LiveVoiceMediaStream;
      try {
        // getUserMedia cannot be aborted; an End during this await keeps its token reserved.
        stream = await this.dependencies.getUserMedia();
      } finally {
        microphoneOwnership.mediaRequestPending = false;
      }
      if (!this.isCurrentLease(operation, activeLease)) {
        stopTracks(stream);
        this.releaseMicrophoneIfReady(microphoneOwnership);
        await this.stopLease(activeLease);
        return;
      }
      this.stream = stream;
      const peer = this.dependencies.createPeer();
      this.peer = peer;
      const channel = peer.createDataChannel("oai-events") as unknown as LiveVoiceDataChannel;
      this.channel = channel;
      this.channelIsOpen = channel.readyState === "open";
      this.peerIsConnected = peer.connectionState === "connected";
      this.rtcReady = new Promise<void>((resolve, reject) => {
        this.resolveRtcReady = resolve;
        this.rejectRtcReady = reject;
        channel.onopen = () => {
          this.channelIsOpen = true;
          this.resolveRtcReadyIfReady();
        };
        channel.onclose = () => {
          const error = new Error("Live data channel closed.");
          reject(error);
          void this.failAndStop(operation, activeLease, error);
        };
      });
      void this.rtcReady.catch(() => undefined);
      for (const track of stream.getAudioTracks())
        peer.addTrack(track as MediaStreamTrack, stream as MediaStream);
      const audio = this.dependencies.createAudioSink();
      this.audio = audio;
      audio.autoplay = true;
      audio.muted = this.state.outputMuted;
      peer.onconnectionstatechange = () => {
        if (!this.isCurrentLease(operation, activeLease)) return;
        this.peerIsConnected = peer.connectionState === "connected";
        if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          void this.failAndStop(operation, activeLease, new Error("WebRTC connection ended."));
          return;
        }
        if (
          peer.connectionState === "disconnected" &&
          (this.state.phase === "live" || this.state.phase === "playback-blocked")
        ) {
          this.setState({ ...this.state, phase: "reconnecting", error: null });
          // Give this peer time to recover without creating a second native session.
          let pending = true;
          const cancelTimeout = this.dependencies.scheduleTimeout(() => {
            if (!pending || this.state.phase !== "reconnecting") return;
            void this.failAndStop(
              operation,
              activeLease,
              new Error("Live voice connection was lost. Start a new call to reconnect."),
            );
          }, DEFAULT_RECONNECT_TIMEOUT_MS);
          this.cancelReconnectTimer = () => {
            pending = false;
            cancelTimeout();
          };
        }
        this.resolveRtcReadyIfReady();
      };
      peer.ontrack = (event) => {
        if (!this.isCurrentLease(operation, activeLease)) return;
        audio.srcObject = event.streams[0] ?? this.dependencies.createRemoteStream(event.track);
        this.remoteMediaReady = true;
        this.resolveRtcReadyIfReady();
        void this.tryPlayback(operation, activeLease);
      };

      this.setState({ ...this.state, phase: "connecting" });
      const offer = await peer.createOffer();
      if (!this.isCurrentLease(operation, activeLease)) return;
      await peer.setLocalDescription(offer);
      if (!this.isCurrentLease(operation, activeLease)) return;
      if (!offer.sdp) throw new Error("The browser did not create a WebRTC offer.");

      // Server events are already subscribed; RPC acceptance alone never changes the UI to live.
      const answerPromise = this.waitForAnswer(operation, activeLease);
      void answerPromise.catch(() => undefined);
      const starting = await this.dependencies.signaling.start(
        {
          leaseId: activeLease.leaseId,
          generation: activeLease.generation,
          offerSdp: offer.sdp,
          clientRequestId: this.dependencies.createRequestId(),
        },
        signal,
      );
      if (!this.isCurrentLease(operation, activeLease)) return;
      this.acceptSessionStatus(operation, activeLease, starting);
      const answer = await answerPromise;
      if (!this.isCurrentLease(operation, activeLease)) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answer });
      if (!this.isCurrentLease(operation, activeLease)) return;
      this.remoteDescriptionReady = true;
      this.updateReadyPhase(operation, activeLease);
      await this.rtcReady;
      if (!this.isCurrentLease(operation, activeLease)) return;
      await this.tryPlayback(operation, activeLease);
      if (!this.isCurrentLease(operation, activeLease)) return;
      this.updateReadyPhase(operation, activeLease);
    } catch (error) {
      if (operation === this.operation) {
        const message = safeErrorMessage(error);
        this.setState({ ...this.state, phase: "error", error: message });
        // Release locally before stop RPC so a slow server cannot retain the mic.
        await this.release(lease, microphoneOwnership);
        if (lease) await this.stopLease(lease);
      } else if (lease) {
        // A stale operation may stop only the lease it captured; global resources
        // may now belong to a newer start on this controller.
        this.releaseMicrophoneIfReady(microphoneOwnership);
        await this.stopLease(lease);
      }
    }
  }

  async contextChanged(target: LiveVoiceTarget | null): Promise<void> {
    if (!target && this.target) await this.end();
    if (!target) return;
    if (
      this.target &&
      (this.target.environmentId !== target.environmentId ||
        this.target.threadId !== target.threadId ||
        this.target.provider !== target.provider ||
        this.target.providerInstanceId !== target.providerInstanceId)
    )
      await this.end();
  }

  setLocalMuted(muted: boolean): void {
    if (
      this.state.phase !== "live" &&
      this.state.phase !== "playback-blocked" &&
      this.state.phase !== "reconnecting"
    )
      return;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    this.setState({ ...this.state, localMuted: muted });
  }

  async setOutputMuted(muted: boolean): Promise<void> {
    if (
      this.state.phase !== "live" &&
      this.state.phase !== "playback-blocked" &&
      this.state.phase !== "reconnecting"
    )
      return;
    if (this.audio) this.audio.muted = muted;
    this.setState({ ...this.state, outputMuted: muted });
    if (!muted && this.state.phase === "playback-blocked" && this.identity) {
      await this.tryPlayback(this.operation, this.identity);
    }
  }

  async retryPlayback(): Promise<void> {
    if (!this.identity) return;
    await this.tryPlayback(this.operation, this.identity);
  }

  /** Ends only Live/media ownership. It never cancels the durable T3 work run. */
  async end(): Promise<void> {
    const lease = this.identity;
    const transcript = this.state.transcript;
    const microphoneOwnership = this.microphoneOwnership;
    const operation = ++this.operation;
    this.setState({ ...this.state, phase: "stopping" });
    this.abortController?.abort();
    this.rejectAnswer?.(new Error("Live session ended."));
    this.rejectPrepared?.(new Error("Live session ended."));
    this.rejectSubscriptionReady?.(new Error("Live session ended."));
    this.rejectRtcReady?.(new Error("Live session ended."));
    await this.release(lease, microphoneOwnership);
    if (lease) await this.stopLease(lease);
    if (operation === this.operation)
      this.setState({ ...IDLE_STATE, phase: "ended", lease, transcript });
  }

  private onSignal(operation: number, event: LiveVoiceSignalEvent): void {
    const identity = this.identity;
    if (!identity || operation !== this.operation || !eventMatchesLease(event, identity)) return;
    if (event.type === "status") {
      this.acceptSessionStatus(operation, identity, event.session);
      if (
        sessionMatchesLease(event.session, identity) &&
        identityMatchesTarget(event.session, this.target!)
      ) {
        this.resolveSubscriptionReady?.();
        this.resolveSubscriptionReady = null;
        this.rejectSubscriptionReady = null;
      }
    }
    if (event.type === "answer") this.answer?.(event.sdp);
    if (event.type === "error")
      void this.failAndStop(
        operation,
        identity,
        new Error(liveVoicePublicErrorMessage(event.code)),
      );
    if (event.type === "transcript" && event.text.trim()) {
      const transcript = [
        ...this.state.transcript,
        { speaker: event.role, text: event.text, final: true },
      ].slice(-MAX_TRANSCRIPT_ENTRIES);
      this.setState({ ...this.state, transcript });
    }
  }

  private acceptSessionStatus(
    operation: number,
    previous: LiveVoiceSession,
    session: LiveVoiceSession,
  ): void {
    if (!this.isCurrentLease(operation, previous) || !sessionMatchesLease(session, previous))
      return;
    if (!identityMatchesTarget(session, this.target!)) return;
    this.identity = session;
    this.setState({ ...this.state, sessionStatus: session.status, lease: session });
    if (
      session.status === "prepared" &&
      session.providerSessionId &&
      session.plannerNativeThreadId
    ) {
      this.resolvePrepared?.(session);
      this.resolvePrepared = null;
      this.rejectPrepared = null;
    } else if (
      session.status === "failed" ||
      session.status === "closed" ||
      session.status === "unknown"
    ) {
      const error = new Error("Live voice preparation is still pending. Try again shortly.");
      if (this.rejectPrepared) this.rejectPrepared(error);
      else void this.failAndStop(operation, previous, error);
      this.resolvePrepared = null;
      this.rejectPrepared = null;
    }
  }

  private waitForAnswer(operation: number, lease: LiveVoiceLease): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!this.isCurrentLease(operation, lease))
        return reject(new Error("Live session changed during startup."));
      this.answer = resolve;
      this.rejectAnswer = reject;
    });
  }

  private resolveRtcReadyIfReady(): void {
    if (this.channelIsOpen && this.peerIsConnected && this.remoteMediaReady) {
      this.resolveRtcReady?.();
      const lease = this.identity;
      if (lease) this.updateReadyPhase(this.operation, lease);
    }
  }

  private updateReadyPhase(operation: number, lease: LiveVoiceLease): void {
    if (
      !this.isCurrentLease(operation, lease) ||
      !this.remoteDescriptionReady ||
      !this.channelIsOpen ||
      !this.peerIsConnected ||
      !this.remoteMediaReady
    )
      return;
    this.clearStartTimer();
    this.cancelReconnectTimer?.();
    this.cancelReconnectTimer = null;
    this.setState({
      ...this.state,
      phase: this.playbackBlocked ? "playback-blocked" : "live",
      error: this.playbackBlocked ? "Allow audio playback to hear Live responses." : null,
    });
  }

  private async tryPlayback(operation: number, lease: LiveVoiceLease): Promise<void> {
    if (!this.isCurrentLease(operation, lease) || !this.audio || !this.remoteMediaReady) return;
    try {
      await this.audio.play();
      if (this.isCurrentLease(operation, lease)) {
        this.playbackBlocked = false;
        this.updateReadyPhase(operation, lease);
      }
    } catch {
      if (this.isCurrentLease(operation, lease)) {
        this.playbackBlocked = true;
        this.updateReadyPhase(operation, lease);
      }
    }
  }

  private async failAndStop(operation: number, lease: LiveVoiceLease, error: Error): Promise<void> {
    if (!this.isCurrentLease(operation, lease)) return;
    ++this.operation;
    this.setState({ ...this.state, phase: "error", error: error.message });
    this.abortController?.abort();
    this.rejectAnswer?.(error);
    this.rejectPrepared?.(error);
    this.rejectSubscriptionReady?.(error);
    this.rejectRtcReady?.(error);
    await this.release(lease, this.microphoneOwnership);
    await this.stopLease(lease);
  }

  private isCurrentTarget(operation: number, target: LiveVoiceTarget): boolean {
    return (
      operation === this.operation &&
      this.target !== null &&
      this.target.environmentId === target.environmentId &&
      this.target.threadId === target.threadId &&
      this.target.providerInstanceId === target.providerInstanceId &&
      this.target.provider === target.provider
    );
  }

  private isCurrentLease(operation: number, lease: LiveVoiceLease): boolean {
    return (
      operation === this.operation &&
      this.identity !== null &&
      this.identity.leaseId === lease.leaseId &&
      this.identity.generation === lease.generation &&
      identityMatchesTarget(this.identity, this.target!)
    );
  }

  private async stopLease(lease: LiveVoiceLease): Promise<void> {
    const key = `${lease.leaseId}:${lease.generation}`;
    const existing = this.stopRequests.get(key);
    if (existing) return existing;
    let clientRequestId = this.stopRequestIds.get(key);
    if (!clientRequestId) {
      clientRequestId = this.dependencies.createRequestId();
      this.stopRequestIds.set(key, clientRequestId);
    }
    const stopping = this.dependencies.signaling
      .stop({
        leaseId: lease.leaseId,
        generation: lease.generation,
        clientRequestId,
      })
      .then(() => undefined)
      .catch(() => undefined);
    this.stopRequests.set(key, stopping);
    await stopping;
  }

  private async release(
    lease: LiveVoiceLease | null,
    microphoneOwnership: MicrophoneOwnership | null,
  ): Promise<void> {
    this.clearStartTimer();
    this.cancelReconnectTimer?.();
    this.cancelReconnectTimer = null;
    this.abortController?.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.answer = null;
    this.rejectAnswer = null;
    this.resolvePrepared = null;
    this.rejectPrepared = null;
    this.resolveRtcReady = null;
    this.rejectRtcReady = null;
    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onclose = null;
      this.channel.close();
    }
    this.channel = null;
    if (this.peer) {
      this.peer.ontrack = null;
      this.peer.onconnectionstatechange = null;
      this.peer.close();
    }
    this.peer = null;
    stopTracks(this.stream);
    this.stream = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
      this.audio = null;
    }
    this.channelIsOpen = false;
    this.peerIsConnected = false;
    this.remoteMediaReady = false;
    this.remoteDescriptionReady = false;
    this.playbackBlocked = false;
    this.resolveSubscriptionReady = null;
    this.rejectSubscriptionReady = null;
    this.releaseMicrophoneIfReady(microphoneOwnership);
    if (
      lease &&
      this.identity &&
      this.identity.leaseId === lease.leaseId &&
      this.identity.generation === lease.generation
    )
      this.identity = null;
    if (
      lease &&
      this.state.lease?.leaseId === lease.leaseId &&
      this.state.lease.generation === lease.generation
    ) {
      this.setState({ ...this.state, lease: null });
    }
    if (!lease) this.target = null;
  }

  private clearStartTimer(): void {
    this.cancelStartTimer?.();
    this.cancelStartTimer = null;
  }

  private releaseMicrophoneIfReady(microphoneOwnership: MicrophoneOwnership | null): void {
    if (!microphoneOwnership || microphoneOwnership.mediaRequestPending) return;
    microphoneOwnership.release();
    if (this.microphoneOwnership === microphoneOwnership) this.microphoneOwnership = null;
  }

  private setState(state: LiveVoiceState): void {
    this.state = state;
    this.dependencies.onStateChange(state);
  }
}

export function isLiveVoiceSupported(scope: {
  readonly provider: string;
  readonly setupMode: string;
  readonly RTCPeerConnection?: unknown;
  readonly getUserMedia?: unknown;
}): boolean {
  return (
    scope.provider === "codex" &&
    (scope.setupMode === "managed" || scope.setupMode === "existing") &&
    typeof scope.RTCPeerConnection === "function" &&
    typeof scope.getUserMedia === "function"
  );
}
