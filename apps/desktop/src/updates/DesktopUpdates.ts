import {
  DESKTOP_UPDATE_RESTART_MARKER_FILE,
  DesktopUpdateChannelSchema,
  type DesktopRuntimeInfo,
  type DesktopUpdateActionResult,
  type DesktopUpdateChannel,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
  type DesktopUpdateReadiness,
  type DesktopUpdateInstallLease,
} from "@t3tools/contracts";
import { errorTag } from "@t3tools/shared/observability";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";
import { isReleasedDesktopVersionForChannel } from "./updateChannels.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
  resolveNotAppliedInstallVersion,
} from "./updateMachine.ts";

const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
const AUTO_UPDATE_POLL_INTERVAL = "4 minutes";
const PREPARED_INSTALL_CHECK_WAIT = Duration.seconds(90);

type UpdateAction = "check" | "download" | "install" | "install-recovery" | "channel";

interface DesktopPreparedUpdateInstallResult extends DesktopUpdateActionResult {
  readonly failed: boolean;
}

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;

const UpdateInfo = Schema.Struct({
  version: Schema.String,
  // Left unvalidated on purpose: a malformed release-notes payload must never
  // fail the decode and block the update state transition. The shape is
  // validated defensively in normalizeDesktopUpdateReleaseNotes.
  releaseNotes: Schema.optional(Schema.Unknown),
});

const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
});
/** Saved in the runtime folder before an install quits the app, read on the next start. */
export const DESKTOP_UPDATE_INSTALL_RECORD_FILE = "desktop-update-install.json";
const DesktopUpdateInstallRecord = Schema.fromJsonString(
  Schema.Struct({ fromVersion: Schema.String, targetVersion: Schema.String }),
);
const decodeInstallRecord = Schema.decodeUnknownEffect(DesktopUpdateInstallRecord);
const encodeInstallRecord = Schema.encodeEffect(DesktopUpdateInstallRecord);

// This file is historical metadata only. It never carries admission authority.
export const DESKTOP_UPDATE_DEFER_RECORD_PREFIX = "desktop-update-deferred-";
const DEFER_RECORD_MAX_BYTES = 16_384;
const deferEncoder = new TextEncoder();
const encodeDeferOrigin = Schema.encodeEffect(Schema.fromJsonString(Schema.Tuple([
  Schema.Literal("desktop-update-defer"), Schema.Literal(1), Schema.String, Schema.Boolean, Schema.NullOr(Schema.String),
])));
const deferText = (bytes: number) => Schema.String.check(Schema.makeFilter(
  (text) => text.length > 0 && deferEncoder.encode(text).length <= bytes && !/[\u0000-\u001f\u007f]/.test(text),
  { expected: `bounded update metadata (${bytes} UTF-8 bytes)` },
));
const DeferReason = Schema.Literals(["runtime-busy", "runtime-unknown", "peer-unsupported", "peer-disconnected", "stale-proof", "expired-proof", "renderer-refused", "storage-unavailable", "recovery-held"]);
type DeferReason = typeof DeferReason.Type;
const DeferPeer = Schema.Struct({
  instanceId: deferText(256),
  status: Schema.Literals(["ready", "held", "superseded"]),
  shutdown: Schema.Literals(["not-started", "unconfirmed", "stopped"]),
});
const DeferRecord = Schema.Struct({
  version: Schema.Literal(1), profileKey: Schema.String.check(Schema.makeFilter((value) => /^[a-f0-9]{64}$/.test(value))),
  profile: Schema.NullOr(deferText(64)), attemptId: deferText(512),
  observedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  runningVersion: deferText(128), targetVersion: deferText(128), channel: DesktopUpdateChannelSchema,
  phase: Schema.Literals(["deferred", "recovery-held"]), reason: DeferReason,
  stopState: Schema.Literals(["not-started", "may-have-started"]),
  peers: Schema.Array(DeferPeer).check(Schema.isMaxLength(32)),
});
type DeferRecord = typeof DeferRecord.Type;
type DeferAttempt = Pick<DeferRecord, "profileKey" | "profile" | "attemptId" | "observedAt" | "runningVersion" | "targetVersion" | "channel"> & { readonly admissionGeneration: number };
const DeferJson = Schema.fromJsonString(DeferRecord);
const decodeDeferRecord = Schema.decodeUnknownEffect(DeferJson, { onExcessProperty: "error" });
const encodeDeferRecord = Schema.encodeEffect(DeferJson);
const sameDeferMeaning = (a: DeferRecord, b: DeferRecord) => a.profileKey === b.profileKey && a.profile === b.profile &&
  a.runningVersion === b.runningVersion && a.targetVersion === b.targetVersion && a.channel === b.channel &&
  a.phase === b.phase && a.reason === b.reason && a.stopState === b.stopState && a.peers.length === b.peers.length &&
  a.peers.every((peer, index) => { const other = b.peers[index]; return other !== undefined && peer.instanceId === other.instanceId && peer.status === other.status && peer.shutdown === other.shutdown; });
const deferMessage = (record: DeferRecord) => `Recorded update deferral for ${record.targetVersion}: ${record.reason} (${DateTime.formatIso(DateTime.makeUnsafe(record.observedAt))}).${record.peers.length === 0 ? "" : ` Peers: ${record.peers.map((peer) => `${peer.instanceId}=${peer.shutdown}/${peer.status}`).join(", ")}.`}`;

const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);
const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);
const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(DownloadProgressInfo);

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export class DesktopUpdateActionInProgressError extends Schema.TaggedError<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  {
    action: Schema.Literals(["check", "download", "install", "channel"]),
    requestedChannel: DesktopUpdateChannelSchema,
  },
) {
  override get message(): string {
    return `Cannot change the desktop update channel to ${this.requestedChannel} while an update ${this.action} action is in progress.`;
  }
}

export class DesktopUpdateChannelPersistenceError extends Schema.TaggedError<DesktopUpdateChannelPersistenceError>()(
  "DesktopUpdateChannelPersistenceError",
  {
    channel: DesktopUpdateChannelSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist the ${this.channel} desktop update channel.`;
  }
}

export class DesktopUpdatePollerError extends Schema.TaggedError<DesktopUpdatePollerError>()(
  "DesktopUpdatePollerError",
  {
    poller: Schema.Literals(["startup", "poll"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.poller} poller failed.`;
  }
}

export class DesktopUpdateEventHandlingError extends Schema.TaggedError<DesktopUpdateEventHandlingError>()(
  "DesktopUpdateEventHandlingError",
  {
    event: Schema.Literals(["update-available", "download-progress", "update-downloaded"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to handle desktop update ${this.event} event.`;
  }
}

export class DesktopUpdaterReportedError extends Schema.TaggedError<DesktopUpdaterReportedError>()(
  "DesktopUpdaterReportedError",
  {
    operation: Schema.Literals(["check", "download", "install", "channel", "background"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop updater ${this.operation} operation reported an error.`;
  }
}

export class DesktopUpdateUnexpectedActionError extends Schema.TaggedError<DesktopUpdateUnexpectedActionError>()(
  "DesktopUpdateUnexpectedActionError",
  {
    action: Schema.Literals(["download", "install"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.action} action failed unexpectedly.`;
  }
}

export type DesktopUpdateConfigureError = never;

interface OwnedBackendInstallAdmission {
  readonly attempt: DeferAttempt;
  readonly instances: ReadonlyArray<DesktopBackendPool.DesktopBackendInstance>;
  readonly stopAll: Effect.Effect<boolean>;
  readonly stopping: () => boolean;
  readonly deferRecovery: (message: string, preserveInstallRecord?: boolean) => Effect.Effect<void>;
}

export interface DesktopUpdateRuntimeReservation {
  /** Must inspect the live reservation, including revocation and expiry. */
  readonly isValid: () => boolean;
  /** Synchronously revalidate and enter commit while all creation/activity gates remain held. */
  readonly tryCommit: () => boolean;
}

/** Production supplies no qualification until complete activity, native creation
 * and backend continuation admission have been independently qualified.
 * Verified background preparation remains independent of installation. */
export class DesktopUpdateInstallQualification extends Context.Service<
  DesktopUpdateInstallQualification,
  {
    /** Acquired before inventory. The provider releases on scope exit, including interruption.
     * A token is evidence only while every participating runtime gate remains held. */
    readonly acquireRuntimeReservation: (request: {
      readonly generation: string;
      readonly targetVersion: string;
      readonly expiresAt: number;
    }) => Effect.Effect<Option.Option<DesktopUpdateRuntimeReservation>, never, Scope.Scope>;
  }
>()("@t3tools/desktop/updates/DesktopUpdates/DesktopUpdateInstallQualification") {}

export const DesktopUpdateSetChannelError = Schema.Union([
  DesktopUpdateActionInProgressError,
  DesktopUpdateChannelPersistenceError,
]);
export type DesktopUpdateSetChannelError = typeof DesktopUpdateSetChannelError.Type;

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    /** True while a check, download, install, or channel change holds the
        updater's single action reservation. */
    readonly isActionActive: Effect.Effect<boolean>;
    /** True only while an install owns the updater action reservation. */
    readonly isInstallActive: Effect.Effect<boolean>;
    /** Current state plus a stream of every later state change. */
    readonly subscribe: Effect.Effect<
      {
        readonly latest: DesktopUpdateState;
        readonly changes: Stream.Stream<DesktopUpdateState>;
      },
      never,
      Scope.Scope
    >;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly configure: Effect.Effect<void, DesktopUpdateConfigureError, Scope.Scope>;
    readonly setChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
    readonly check: (reason: string) => Effect.Effect<DesktopUpdateCheckResult>;
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
    readonly installPrepared: (
      expectedVersion: string,
    ) => Effect.Effect<DesktopPreparedUpdateInstallResult>;
    readonly acknowledgeReadiness?: (senderId: number, readiness: DesktopUpdateReadiness) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/updates/DesktopUpdates") {}

const {
  logInfo: logUpdaterInfo,
  logWarning: logUpdaterWarning,
  logError: logUpdaterError,
} = DesktopObservability.makeComponentLogger("desktop-updater");

function redactMessage(message: string): string {
  // Updater HTTP errors append response bodies and headers after the first line.
  return (message.split(/[\r\n]/, 1)[0] ?? "")
    .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted credential]")
    .replace(
      /\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=].*$/gi,
      "[redacted header]",
    )
    .replace(
      /\b[\w-]*(?:token|password|secret|credential|api[_-]?key)[\w-]*\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "[redacted credential]",
    )
    .slice(0, 512);
}

function summarizeCause(cause: unknown, depth: number): string {
  if (depth >= 3) return "[truncated cause]";
  if (Cause.isCause(cause)) {
    return cause.reasons
      .slice(0, 3)
      .map((reason) =>
        reason._tag === "Fail"
          ? summarizeCause(reason.error, depth + 1)
          : reason._tag === "Die"
            ? summarizeCause(reason.defect, depth + 1)
            : "Interrupted",
      )
      .join("; ");
  }
  if (typeof cause === "string") return redactMessage(cause);
  if (typeof cause !== "object" || cause === null) return errorTag(cause);

  const error = cause as {
    readonly message?: unknown;
    readonly code?: unknown;
    readonly cause?: unknown;
  };
  const code =
    typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
      ? ` [${error.code}]`
      : "";
  const message = typeof error.message === "string" ? `: ${redactMessage(error.message)}` : "";
  const nested =
    error.cause === undefined ? "" : `; caused by ${summarizeCause(error.cause, depth + 1)}`;
  return `${errorTag(cause)}${code}${message}${nested}`;
}

/** Log a bounded cause summary without stacks, response payloads, or request credentials. */
export function describeUpdateErrorCause(cause: unknown): string {
  try {
    return summarizeCause(cause, 0).slice(0, 1024);
  } catch {
    return "UnknownError";
  }
}

function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }

  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => (config.provider ? Option.some(config) : Option.none())),
    Effect.orElseSucceed(() => Option.none<AppUpdateYmlConfig>()),
  );
}

function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  enabled: boolean,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): DesktopUpdateState {
  return {
    ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, channel),
    enabled,
    status: enabled ? "idle" : "disabled",
  };
}

function getCanRetryFromState(state: DesktopUpdateState): boolean {
  return state.availableVersion !== null || state.downloadedVersion !== null;
}

function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number,
): boolean {
  if (currentState.status !== "downloading") {
    return true;
  }

  const currentPercent = currentState.downloadPercent;
  if (currentPercent === null) {
    return true;
  }

  const previousStep = Math.floor(currentPercent / 10);
  const nextStep = Math.floor(nextPercent / 10);
  return nextStep !== previousStep || nextPercent === 100;
}

function getAutoUpdateDisabledReason(args: {
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  isDebPackage: boolean;
  isNixPackage: boolean;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
}): string | null {
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates require the morrowbyte/t3code release feed or a managed Nix package.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage && !args.isDebPackage && !args.isNixPackage) {
    return "Automatic updates on Linux require an AppImage, .deb, or managed Nix package.";
  }
  return null;
}

function isArm64HostRunningIntelBuild(runtimeInfo: DesktopRuntimeInfo): boolean {
  return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const desktopState = yield* DesktopState.DesktopState;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const crypto = yield* Crypto.Crypto;
  const qualification = yield* Effect.serviceOption(DesktopUpdateInstallQualification);

  const appUpdateYmlConfigRef = yield* Ref.make<Option.Option<AppUpdateYmlConfig>>(Option.none());
  const activeUpdateActionRef = yield* Ref.make<Option.Option<UpdateAction>>(Option.none());
  const finishedUpdateActions = yield* PubSub.unbounded<UpdateAction>();
  const updaterConfiguredRef = yield* Ref.make(false);
  const clientOnlyInstallRef = yield* Ref.make(false);
  const recoveryInstancesRef = yield* Ref.make<ReadonlyArray<DesktopBackendPool.DesktopBackendInstance> | null>(null);
  const recoveryOutcomesRef = yield* Ref.make<ReadonlyArray<{ readonly instanceId: string; readonly status: "ready" | "held" | "superseded"; readonly shutdown: "not-started" | "unconfirmed" | "stopped" }>>([]);
  const deferStorageMutex = yield* Semaphore.make(1);
  const deferWriterRef = yield* Ref.make(Option.none<string>());
  const latestDeferAttemptRef = yield* Ref.make(Option.none<DeferAttempt>());
  const recoveryAttemptRef = yield* Ref.make(Option.none<DeferAttempt>());
  const recoveryStoppingRef = yield* Ref.make(false);
  const lastDeferRecordRef = yield* Ref.make(Option.none<DeferRecord>());
  const deferUnavailableRef = yield* Ref.make(false);
  // Only matching canonical profile inputs can name a scope. Include the SDK
  // origin: development/production can share T3 home but use different locks.
  const deferScope = yield* Effect.gen(function* () {
    if (!Option.isOption(environment.profileId) || !Option.isOption(config.desktopProfile) ||
      typeof environment.stateDir !== "string" || !environment.path.isAbsolute(environment.stateDir) ||
      typeof environment.isDevelopment !== "boolean" ||
      typeof environment.appDataDirectory !== "string" || !environment.path.isAbsolute(environment.appDataDirectory)) return Option.none<{ profileKey: string; profile: string | null; path: string }>();
    if (environment.isDevelopment !== Option.isSome(config.devServerUrl)) return Option.none();
    if (typeof environment.homeDirectory !== "string" || !environment.path.isAbsolute(environment.homeDirectory)) return Option.none();
    const expectedAppData = environment.platform === "win32"
      ? Option.getOrElse(config.appDataDirectory, () => environment.path.join(environment.homeDirectory, "AppData", "Roaming"))
      : environment.platform === "darwin" ? environment.path.join(environment.homeDirectory, "Library", "Application Support")
      : Option.getOrElse(config.xdgConfigHome, () => environment.path.join(environment.homeDirectory, ".config"));
    if (expectedAppData !== environment.appDataDirectory) return Option.none();
    const profile = Option.getOrNull(environment.profileId);
    if (profile !== Option.getOrNull(config.desktopProfile) || (profile !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(profile))) return Option.none();
    const serializedOrigin = yield* encodeDeferOrigin(["desktop-update-defer", 1, environment.appDataDirectory, environment.isDevelopment, profile]).pipe(Effect.option);
    if (Option.isNone(serializedOrigin)) return Option.none();
    const origin = deferEncoder.encode(serializedOrigin.value);
    const digest = yield* crypto.digest("SHA-256", origin).pipe(Effect.option);
    if (Option.isNone(digest) || digest.value.length !== 32) return Option.none();
    const profileKey = Array.from(digest.value, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (!/^[a-f0-9]{64}$/.test(profileKey)) return Option.none();
    return Option.some({ profileKey, profile, path: environment.path.join(environment.stateDir, `${DESKTOP_UPDATE_DEFER_RECORD_PREFIX}${profileKey}.json`) });
  });
  const heldRecoveryRef = yield* Ref.make<OwnedBackendInstallAdmission["deferRecovery"] | null>(null);
  const admissionSequence = yield* Ref.make(0);
  const pendingReadiness = yield* Ref.make<{
    readonly lease: DesktopUpdateInstallLease;
    readonly senders: ReadonlySet<number>;
    readonly signal: Deferred.Deferred<boolean>;
  } | null>(null);
  const lastLoggedDownloadMilestoneRef = yield* Ref.make(-1);
  const notAppliedVersionRef = yield* Ref.make(Option.none<string>());
  const updateStateRef = yield* Ref.make<DesktopUpdateState>(
    createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      environment.defaultDesktopSettings.updateChannel,
    ),
  );

  const stateChanges = yield* PubSub.sliding<DesktopUpdateState>(16);
  // Makes ref writes + publishes atomic against subscribe, so a snapshot
  // never overlaps with the first change a subscriber receives.
  const stateMutex = yield* Semaphore.make(1);

  const emitState = Ref.get(updateStateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
  );

  const decorateDeferState = (state: DesktopUpdateState) => Effect.gen(function* () {
    if (state.errorContext !== null || (state.status !== "idle" && state.status !== "downloaded")) return state;
    if (yield* Ref.get(deferUnavailableRef)) return { ...state, message: "Update outcome storage is unavailable; automatic installation remains deferred." };
    const record = yield* Ref.get(lastDeferRecordRef);
    return Option.isSome(record) && (state.status === "idle" || state.downloadedVersion === record.value.targetVersion)
      ? { ...state, message: deferMessage(record.value) } : state;
  });
  const setState = (state: DesktopUpdateState): Effect.Effect<void> =>
    decorateDeferState(state).pipe(Effect.flatMap((state) => stateMutex
      .withPermits(1)(
        Ref.set(updateStateRef, state).pipe(Effect.andThen(PubSub.publish(stateChanges, state))),
      )
      .pipe(Effect.andThen(emitState))));

  const updateState = (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ): Effect.Effect<DesktopUpdateState> =>
    Ref.get(updateStateRef).pipe(
      Effect.flatMap((state) => {
        const nextState = f(state);
        return setState(nextState).pipe(Effect.as(nextState));
      }),
    );

  const readAppUpdateYml = fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<AppUpdateYmlConfig>()),
        onSome: parseAppUpdateYml,
      }),
    ),
  );

  // The .deb carries electron-builder's resources/package-type marker.
  // electron-updater reads the same file and installs updates with dpkg.
  const isDebPackage =
    environment.platform === "linux" && environment.isPackaged
      ? yield* fileSystem
          .readFileString(environment.path.join(environment.resourcesPath, "package-type"))
          .pipe(
            Effect.map((packageType) => packageType.trim() === "deb"),
            Effect.orElseSucceed(() => false),
          )
      : false;

  const isNixPackage = environment.platform === "linux" && Option.isSome(config.nixUpdaterPath);

  const hasUpdateFeedConfig = Ref.get(appUpdateYmlConfigRef).pipe(
    Effect.map(
      (appUpdateYmlConfig) =>
        (Option.isSome(appUpdateYmlConfig) &&
          appUpdateYmlConfig.value.provider === "github" &&
          appUpdateYmlConfig.value.owner === "morrowbyte" &&
          appUpdateYmlConfig.value.repo === "t3code" &&
          (appUpdateYmlConfig.value.protocol === undefined ||
            appUpdateYmlConfig.value.protocol === "https") &&
          appUpdateYmlConfig.value.pathPrefix === undefined &&
          (appUpdateYmlConfig.value.host === undefined ||
            appUpdateYmlConfig.value.host === "github.com")) ||
        config.mockUpdates || isNixPackage,
    ),
  );

  const resolveDisabledReason = Effect.gen(function* () {
    const hasFeedConfig = yield* hasUpdateFeedConfig;
    return Option.fromNullishOr(
      getAutoUpdateDisabledReason({
        isDevelopment: environment.isDevelopment,
        isPackaged: environment.isPackaged,
        platform: environment.platform,
        appImage: Option.getOrUndefined(config.appImagePath),
        isDebPackage,
        isNixPackage,
        disabledByEnv: config.disableAutoUpdate,
        hasUpdateFeedConfig: hasFeedConfig,
      }),
    );
  });

  const activeUpdateAction = Ref.get(activeUpdateActionRef);

  const tryStartUpdateAction = (action: UpdateAction): Effect.Effect<boolean> =>
    Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) ? [false, activeAction] : [true, Option.some(action)],
    );

  const tryStartChannelChange = Ref.modify(activeUpdateActionRef, (activeAction) =>
    Option.isSome(activeAction)
      ? [activeAction, activeAction]
      : [Option.none<UpdateAction>(), Option.some<UpdateAction>("channel")],
  );

  const finishUpdateAction = (action: UpdateAction): Effect.Effect<void> =>
    Ref.modify(activeUpdateActionRef, (activeAction) => {
      const finished = Option.isSome(activeAction) && activeAction.value === action;
      return [finished, finished ? Option.none() : activeAction] as const;
    }).pipe(
      Effect.flatMap((finished) =>
        finished ? PubSub.publish(finishedUpdateActions, action).pipe(Effect.asVoid) : Effect.void,
      ),
    );

  const applyAutoUpdaterChannel = Effect.fn("desktop.updates.applyAutoUpdaterChannel")(function* (
    channel: DesktopUpdateChannel,
  ) {
    yield* Effect.annotateCurrentSpan({ channel });
    const allowsPrerelease = channel === "nightly";
    yield* electronUpdater.setChannel(channel);
    yield* electronUpdater.setAllowPrerelease(allowsPrerelease);
    yield* electronUpdater.setAllowDowngrade(allowsPrerelease);
    yield* electronUpdater.setFullChangelog(allowsPrerelease);
    yield* logUpdaterInfo("using update channel", {
      channel,
      allowPrerelease: allowsPrerelease,
      allowDowngrade: allowsPrerelease,
      fullChangelog: allowsPrerelease,
    });
  });

  const shouldEnableAutoUpdates = resolveDisabledReason.pipe(Effect.map(Option.isNone));

  const checkForUpdates = Effect.fn("desktop.updates.checkForUpdates")(function* (
    reason: string,
    actionReservation: "acquire" | "held" = "acquire",
  ) {
    yield* Effect.annotateCurrentSpan({ reason });
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!(yield* Ref.get(updaterConfiguredRef))) return false;

    const state = yield* Ref.get(updateStateRef);
    if (state.status === "downloading") {
      yield* logUpdaterInfo("skipping update check while update is active", {
        reason,
        status: state.status,
      });
      return false;
    }

    if (actionReservation === "acquire" && !(yield* tryStartUpdateAction("check"))) return false;

    const check = Effect.gen(function* () {
      const checkedAt = yield* currentIsoTimestamp;
      yield* setState(reduceDesktopUpdateStateOnCheckStart(state, checkedAt));
      yield* logUpdaterInfo("checking for updates", { reason });

      return yield* electronUpdater.checkForUpdates.pipe(
        Effect.as(true),
        Effect.catchTags({
          ElectronUpdaterCheckForUpdatesError: Effect.fn(
            "desktop.updates.handleCheckForUpdatesFailure",
          )(function* (error) {
            const failedAt = yield* currentIsoTimestamp;
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnCheckFailure(current, error.message, failedAt),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              cause: describeUpdateErrorCause(error.cause),
              channel: error.channel,
            });
            return true;
          }),
        }),
      );
    });

    return yield* actionReservation === "held"
      ? check
      : check.pipe(
          Effect.onInterrupt(() => setState(state)),
          Effect.ensuring(finishUpdateAction("check")),
        );
  });

  const downloadAvailableUpdate = Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    if (!(yield* Ref.get(updaterConfiguredRef)) || state.status !== "available") {
      return { accepted: false, completed: false };
    }

    if (!(yield* tryStartUpdateAction("download"))) {
      return { accepted: false, completed: false };
    }

    return yield* Effect.gen(function* () {
      yield* setState(reduceDesktopUpdateStateOnDownloadStart(state));
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );
      yield* logUpdaterInfo("downloading update");
      yield* electronUpdater.downloadUpdate;
      return { accepted: true, completed: true };
    }).pipe(
      Effect.catchTags({
        ElectronUpdaterDownloadUpdateError: Effect.fn("desktop.updates.handleDownloadFailure")(
          function* (error) {
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
            );
            yield* logUpdaterError(error.message, {
              errorTag: error._tag,
              cause: describeUpdateErrorCause(error.cause),
              channel: error.channel,
            });
            return { accepted: true, completed: false };
          },
        ),
      }),
      Effect.onInterrupt(() =>
        updateState((current) => (current.status === "downloading" ? state : current)).pipe(
          Effect.asVoid,
        ),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const error = new DesktopUpdateUnexpectedActionError({ action: "download", cause });
        return Effect.gen(function* () {
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
          );
          yield* logUpdaterError(error.message, {
            errorTag: error._tag,
            cause: describeUpdateErrorCause(error.cause),
            action: error.action,
          });
          return { accepted: true, completed: false };
        });
      }),
      Effect.ensuring(finishUpdateAction("download")),
    );
  }).pipe(Effect.withSpan("desktop.updates.downloadAvailableUpdate"));

  // Tells the primary backend that the coming stop is an update restart, so it
  // keeps its managed tunnel for the backend the updated app starts. Best
  // effort: without the marker the backend only re-provisions its tunnel.
  const updateRestartMarkerDir = environment.path.join(environment.baseDir, "runtime");
  const updateRestartMarkerPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_RESTART_MARKER_FILE,
  );
  const writeUpdateRestartMarker = fileSystem
    .makeDirectory(updateRestartMarkerDir, { recursive: true })
    .pipe(
      Effect.andThen(fileSystem.writeFileString(updateRestartMarkerPath, "")),
      Effect.catch((error) =>
        logUpdaterWarning("Could not write the update restart marker.", { errorTag: error._tag }),
      ),
    );

  // A failed or interrupted install brings no updated backend, so a later
  // quit must release the tunnel.
  const removeUpdateRestartMarker = fileSystem
    .remove(updateRestartMarkerPath, { force: true })
    .pipe(Effect.ignore);

  // Records the version an install hands to the OS installer, so the next
  // start can tell whether it applied. Best effort, like the restart marker.
  const installRecordPath = environment.path.join(
    updateRestartMarkerDir,
    DESKTOP_UPDATE_INSTALL_RECORD_FILE,
  );
  const writeInstallRecord = (targetVersion: string) =>
    fileSystem.makeDirectory(updateRestartMarkerDir, { recursive: true }).pipe(
      Effect.andThen(encodeInstallRecord({ fromVersion: environment.appVersion, targetVersion })),
      Effect.flatMap((text) => fileSystem.writeFileString(installRecordPath, text)),
      Effect.andThen(fileSystem.readFileString(installRecordPath)),
      Effect.flatMap(decodeInstallRecord),
      Effect.map((record) => record.fromVersion === environment.appVersion && record.targetVersion === targetVersion),
      Effect.catch((error) => logUpdaterWarning("Could not verify the update install record.", { errorTag: error._tag }).pipe(Effect.as(false))),
    );
  const removeInstallRecord = fileSystem
    .remove(installRecordPath, { force: true })
    .pipe(Effect.ignore);

  // Reads the record of the last install. Returns the version it did not
  // apply, when the app came back on the version it installed from. That
  // record stays through later starts, until the version changes or a new
  // install replaces it, so no restart forgets the failed version.
  const readNotAppliedInstallVersion = fileSystem.readFileString(installRecordPath).pipe(
    Effect.flatMap(decodeInstallRecord),
    Effect.option,
    Effect.map((record) =>
      Option.flatMap(record, (value) =>
        Option.fromNullishOr(resolveNotAppliedInstallVersion(value, environment.appVersion)),
      ),
    ),
    Effect.tap((notAppliedVersion) =>
      Option.isNone(notAppliedVersion) ? removeInstallRecord : Effect.void,
    ),
  );

  const baseUpdateState = (channel: DesktopUpdateChannel, enabled: boolean) =>
    Ref.get(notAppliedVersionRef).pipe(
      Effect.map((notAppliedVersion) => ({
        ...createBaseUpdateState(channel, enabled, environment),
        ...Option.match(notAppliedVersion, {
          onNone: () => ({}),
          onSome: (version) => ({ notAppliedVersion: version }),
        }),
      })),
    );

  const metadataUnavailable = Effect.all([
    Ref.set(deferUnavailableRef, true), Ref.set(lastDeferRecordRef, Option.none()),
  ], { discard: true });
  const boundedMetadata = (path: string) => Effect.scoped(Effect.gen(function* () {
    const file = yield* fileSystem.open(path, { flag: "r" });
    const info = yield* file.stat;
    if (info.type !== "File" || info.size <= 0n || info.size > BigInt(DEFER_RECORD_MAX_BYTES)) return yield* Effect.fail("invalid-metadata" as const);
    const bytes = yield* file.readAlloc(DEFER_RECORD_MAX_BYTES + 1);
    if (Option.isNone(bytes) || bytes.value.length !== Number(info.size) || bytes.value.length > DEFER_RECORD_MAX_BYTES) return yield* Effect.fail("invalid-metadata" as const);
    return yield* Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.value), catch: () => "invalid-metadata" as const });
  }));
  const readDeferRecord: Effect.Effect<{ readonly kind: "missing" | "unavailable" } | { readonly kind: "record"; readonly record: DeferRecord }> = Effect.suspend(() => {
    if (Option.isNone(deferScope)) return Effect.succeed({ kind: "unavailable" as const });
    const scope = deferScope.value;
    return boundedMetadata(scope.path).pipe(
      Effect.flatMap(decodeDeferRecord),
      Effect.flatMap((record) => Clock.currentTimeMillis.pipe(Effect.map((now) => record.profileKey === scope.profileKey && record.profile === scope.profile &&
        record.observedAt <= now + 60_000 && new Set(record.peers.map((peer) => peer.instanceId)).size === record.peers.length
          ? { kind: "record" as const, record } : { kind: "unavailable" as const }))),
      Effect.catch((error) => Effect.succeed(PlatformError.isPlatformError(error) && error.reason._tag === "NotFound"
        ? { kind: "missing" as const } : { kind: "unavailable" as const })),
    );
  });
  const refreshDeferRecord = Effect.gen(function* () {
    const stored = yield* readDeferRecord;
    if (stored.kind === "unavailable") { yield* metadataUnavailable; return false; }
    yield* Ref.set(deferUnavailableRef, false);
    yield* Ref.set(lastDeferRecordRef, stored.kind === "record" ? Option.some(stored.record) : Option.none());
    return true;
  });
  const beginDeferAttempt = (state: DesktopUpdateState) => deferStorageMutex.withPermits(1)(stateMutex.withPermits(1)(Effect.gen(function* () {
    const current = yield* Ref.get(updateStateRef);
    if (Option.isSome(yield* Ref.get(activeUpdateActionRef)) || current.downloadedVersion !== state.downloadedVersion || current.channel !== state.channel) return Option.none<DeferAttempt>();
    const writer = yield* Ref.get(deferWriterRef);
    if (Option.isNone(deferScope) || Option.isNone(writer) || state.downloadedVersion === null) {
      yield* metadataUnavailable;
      return Option.none<DeferAttempt>();
    }
    const sequence = yield* Ref.modify(admissionSequence, (value) => [value + 1, value + 1]);
    const attempt: DeferAttempt = { profileKey: deferScope.value.profileKey, profile: deferScope.value.profile,
      attemptId: `${writer.value}:${sequence}`, admissionGeneration: sequence, observedAt: yield* Clock.currentTimeMillis,
      runningVersion: environment.appVersion, targetVersion: state.downloadedVersion, channel: state.channel };
    yield* Ref.set(latestDeferAttemptRef, Option.some(attempt));
    return Option.some(attempt);
  })));
  const ownsDeferAttempt = (attempt: DeferAttempt) => Ref.get(latestDeferAttemptRef).pipe(Effect.map((owner) => Option.isSome(owner) && owner.value === attempt));
  // The only writer. Claiming a newer attempt uses this SAME lane, so it cannot
  // race between an older writer's ownership check and awaited atomic rename.
  const storeDeferRecord = (attempt: DeferAttempt, reason: DeferReason, peers: DeferRecord["peers"] = [], afterStop = false, probeOnly = false) =>
    deferStorageMutex.withPermits(1)(Effect.scoped(Effect.gen(function* () {
      if (!(yield* ownsDeferAttempt(attempt))) return "superseded" as const;
      if (Option.isNone(deferScope) || !(yield* refreshDeferRecord)) return "unavailable" as const;
      const { admissionGeneration: _generation, ...metadata } = attempt;
      const record: DeferRecord = { version: 1, ...metadata, reason, phase: afterStop || reason === "recovery-held" ? "recovery-held" : "deferred",
        stopState: afterStop ? "may-have-started" : "not-started",
        peers: peers.toSorted((a, b) => a.instanceId === b.instanceId ? 0 : a.instanceId < b.instanceId ? -1 : 1) };
      const text = yield* encodeDeferRecord(record);
      if (deferEncoder.encode(text).length > DEFER_RECORD_MAX_BYTES || new Set(record.peers.map((peer) => peer.instanceId)).size !== record.peers.length) return yield* Effect.fail("invalid-metadata" as const);
      const prior = yield* Ref.get(lastDeferRecordRef);
      if (!probeOnly && Option.isSome(prior) && sameDeferMeaning(prior.value, record)) return "stored" as const;
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true, mode: 0o700 });
      const temporary = yield* fileSystem.makeTempFileScoped({ directory: environment.stateDir, prefix: `.${DESKTOP_UPDATE_DEFER_RECORD_PREFIX}` });
      yield* fileSystem.chmod(temporary, 0o600);
      yield* Effect.scoped(Effect.gen(function* () {
        const file = yield* fileSystem.open(temporary, { flag: "w", mode: 0o600 });
        yield* file.writeAll(deferEncoder.encode(text));
        yield* file.sync;
      }));
      const staged = yield* boundedMetadata(temporary);
      const decoded = yield* decodeDeferRecord(staged);
      if (staged !== text || decoded.attemptId !== attempt.attemptId || decoded.profileKey !== attempt.profileKey) return yield* Effect.fail("invalid-metadata" as const);
      if (probeOnly) {
        // Exercise the atomic rename/readback boundary using ONLY owned temps;
        // the existing completed record is never replaced by a provisional probe.
        const destination = yield* fileSystem.makeTempFileScoped({ directory: environment.stateDir, prefix: `.${DESKTOP_UPDATE_DEFER_RECORD_PREFIX}` });
        yield* fileSystem.rename(temporary, destination);
        if ((yield* boundedMetadata(destination)) !== text) return yield* Effect.fail("invalid-metadata" as const);
        return "stored" as const;
      }
      yield* fileSystem.rename(temporary, deferScope.value.path);
      const published = yield* boundedMetadata(deferScope.value.path);
      if (published !== text) return yield* Effect.fail("invalid-metadata" as const);
      const verified = yield* decodeDeferRecord(published);
      yield* Ref.set(lastDeferRecordRef, Option.some(verified));
      yield* Ref.set(deferUnavailableRef, false);
      return "stored" as const;
    })).pipe(Effect.catch(() => metadataUnavailable.pipe(Effect.as("unavailable" as const))), Effect.uninterruptible));
  const deferInstall = (attempt: DeferAttempt, reason: DeferReason, peers: DeferRecord["peers"] = []) => storeDeferRecord(attempt, reason, peers).pipe(
    Effect.tap((result) => result === "superseded" ? Effect.void : updateState((state) => state).pipe(Effect.asVoid)),
    Effect.as({ accepted: false, completed: false, failed: false }),
  );

  const resetInstallAction = Effect.all(
    [
      finishUpdateAction("install"),
      Ref.set(desktopState.quitting, false),
      Ref.set(clientOnlyInstallRef, false),
      Ref.set(recoveryInstancesRef, null),
      Ref.set(recoveryOutcomesRef, []),
      Ref.set(recoveryAttemptRef, Option.none()),
      Ref.set(recoveryStoppingRef, false),
      Ref.set(heldRecoveryRef, null),
      removeUpdateRestartMarker,
      removeInstallRecord,
    ],
    { discard: true },
  );

  const recoverFailedInstall = Effect.fn("desktop.updates.recoverFailedInstall")(function* (
    message: string,
    preserveInstallRecord = false,
  ) {
    const heldRecovery = yield* Ref.get(heldRecoveryRef);
    if (heldRecovery !== null) {
      yield* heldRecovery(message, preserveInstallRecord);
      yield* PubSub.publish(finishedUpdateActions, "install-recovery");
      return;
    }
    const ownsRecovery = yield* Ref.modify(activeUpdateActionRef, (activeAction) =>
      Option.isSome(activeAction) && activeAction.value === "install"
        ? ([true, Option.some<UpdateAction>("install-recovery")] as const)
        : ([false, activeAction] as const),
    );
    if (!ownsRecovery) return;

    yield* Ref.set(desktopState.quitting, false);
    yield* removeUpdateRestartMarker;
    if (!preserveInstallRecord) yield* removeInstallRecord;
    yield* Effect.gen(function* () {
      const recoveryInstances = yield* Ref.get(recoveryInstancesRef);
      const instances = recoveryInstances ?? ((yield* Ref.get(clientOnlyInstallRef)) ? [] : yield* pool.list);
      const restartExit = yield* Effect.forEach(instances, (instance) => instance.start, {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.exit);
      const outcomes = yield* Ref.get(recoveryOutcomesRef);
      const held = outcomes.filter((outcome) => outcome.status === "held");
      const attempt = yield* Ref.get(recoveryAttemptRef);
      const afterStop = yield* Ref.get(recoveryStoppingRef);
      const persisted = Option.isNone(attempt) ? "stored" as const : yield* storeDeferRecord(attempt.value, "recovery-held", [...outcomes], afterStop);
      const storageMessage = persisted === "unavailable" ? (afterStop
        ? " Deferred outcome storage is unavailable after shutdown admission; stopped/unconfirmed peer outcomes remain in this running session."
        : " Deferred outcome storage is unavailable during install recovery; no owned backend shutdown began.") : "";
      const shutdownMessage = outcomes.length === 0 ? "" : ` Shutdown outcomes: ${outcomes.map((peer) => `${peer.instanceId.slice(0, 128)}=${peer.shutdown}`).join(", ")}.`;
      const recoveryMessage = held.length === 0 ? message + storageMessage + shutdownMessage : `${message} Recovery remains held for app-owned backends: ${held.slice(0, 128).map((outcome) => outcome.instanceId.slice(0, 128)).join(", ")}. No committed peer was reopened.${storageMessage}${shutdownMessage}`;
      yield* updateState((current) => reduceDesktopUpdateStateOnInstallFailure(current, recoveryMessage));
      if (Exit.isFailure(restartExit)) {
        yield* logUpdaterError("Desktop update install recovery could not restart every backend.");
      }
    }).pipe(
      Effect.catchCause(() =>
        logUpdaterError("Desktop update install recovery failed unexpectedly."),
      ),
      Effect.ensuring(finishUpdateAction("install-recovery")),
    );
  });

  const installDownloadedUpdate = (expectedVersion?: string, clientOnly = false, runtime?: DesktopUpdateRuntimeReservation, owned?: OwnedBackendInstallAdmission) =>
    Effect.scoped(
      Effect.gen(function* () {
        const actionCompletions = yield* PubSub.subscribe(finishedUpdateActions);
        let admission: "admitted" | "refused" | "wait-for-check" = "wait-for-check";
        while (admission === "wait-for-check") {
          admission = yield* stateMutex.withPermits(1)(
            Effect.gen(function* () {
              const state = yield* Ref.get(updateStateRef);
              const activeAction = yield* Ref.get(activeUpdateActionRef);
              if (owned !== undefined && !(yield* ownsDeferAttempt(owned.attempt))) return "refused" as const;
              const hasExpectedDownload =
                state.downloadedVersion !== null &&
                (expectedVersion === undefined || state.downloadedVersion === expectedVersion);
              if (runtime !== undefined && (state.installLease?.phase !== "commit" ||
                state.installLease.targetVersion !== expectedVersion ||
                (yield* Clock.currentTimeMillis) >= state.installLease.expiresAt - 5_000)) return "refused" as const;
              if (
                (yield* Ref.get(desktopState.quitting)) ||
                !(yield* Ref.get(updaterConfiguredRef)) ||
                !hasExpectedDownload
              ) {
                return "refused" as const;
              }
              if (Option.isSome(activeAction)) {
                return !clientOnly && activeAction.value === "check" && expectedVersion !== undefined
                  ? ("wait-for-check" as const)
                  : ("refused" as const);
              }
              const hasInstallableDownload =
                state.status === "downloaded" ||
                (!clientOnly && state.status === "error" &&
                  (state.errorContext === null || state.errorContext === "install"));
              if (!hasInstallableDownload) return "refused" as const;
              return (yield* tryStartUpdateAction("install"))
                ? ("admitted" as const)
                : ("refused" as const);
            }),
          );
          if (admission === "wait-for-check") {
            const finishedAction = yield* PubSub.take(actionCompletions).pipe(
              Effect.timeoutOption(PREPARED_INSTALL_CHECK_WAIT),
            );
            if (Option.isNone(finishedAction)) {
              admission = "refused";
            }
          }
        }
        if (admission === "refused") {
          return { accepted: false, completed: false, failed: false };
        }

        yield* Ref.set(clientOnlyInstallRef, clientOnly);
        yield* Ref.set(recoveryInstancesRef, owned?.instances ?? null);
        yield* Ref.set(recoveryOutcomesRef, (owned?.instances ?? []).map((instance) => ({ instanceId: instance.id, status: "held" as const, shutdown: "not-started" as const })));
        yield* Ref.set(recoveryAttemptRef, owned === undefined ? Option.none() : Option.some(owned.attempt));
        yield* Ref.set(recoveryStoppingRef, false);
        yield* Ref.set(heldRecoveryRef, owned?.deferRecovery ?? null);
        yield* Ref.set(desktopState.quitting, true);

        const recover = (message: string, preserveInstallRecord = false) => owned === undefined
          ? recoverFailedInstall(message, preserveInstallRecord)
          : owned.deferRecovery(message, preserveInstallRecord);
        return yield* Effect.gen(function* () {
          if (!clientOnly) yield* writeUpdateRestartMarker;
          const { downloadedVersion } = yield* Ref.get(updateStateRef);
          const recordVerified = downloadedVersion !== null && (yield* writeInstallRecord(downloadedVersion));
          if (runtime !== undefined && !recordVerified) {
            if (owned !== undefined) yield* deferInstall(owned.attempt, "storage-unavailable");
            yield* resetInstallAction;
            return { accepted: false, completed: false, failed: false };
          }
          // Stop every backend in the pool, not just the primary. With
          // parallel WSL + Windows backends, leaving the WSL instance up
          // means quitAndInstall's app.quit() exits before the pool's
          // scope cascade has a chance to run its stop finalizer, so the
          // WSL child gets hard-killed by the OS instead of receiving
          // SIGTERM + grace. Stops run concurrently with the same 5s
          // budget the primary had on its own.
          if (owned !== undefined) {
            if (!(yield* owned.stopAll)) {
              if (owned.stopping()) {
                yield* recover("Prepared backend shutdown did not complete; installation was deferred.");
                return { accepted: true, completed: false, failed: true };
              }
              yield* resetInstallAction;
              return { accepted: false, completed: false, failed: false };
            }
          } else {
            const instances = clientOnly ? [] : yield* pool.list;
            yield* Effect.forEach(instances, (instance) => instance.stop({ timeout: Duration.seconds(5) }), { concurrency: "unbounded" });
          }
          yield* electronUpdater.quitAndInstall({
            isSilent: true,
            isForceRunAfter: true,
            ...(runtime === undefined ? {} : { beforeInstall: () => runtime.isValid() }),
          });
          return { accepted: true, completed: false, failed: false };
        }).pipe(
          Effect.catchTags({
            ElectronUpdaterNixActivationAdmissionError: (error) => recover(error.message, true).pipe(
              Effect.as({ accepted: true, completed: false, failed: true }),
            ),
            ElectronUpdaterInstallAdmissionError: () => (clientOnly || (owned !== undefined && !owned.stopping()))
              ? resetInstallAction.pipe(Effect.andThen(owned === undefined ? Effect.void : deferInstall(owned.attempt, "stale-proof")), Effect.as({ accepted: false, completed: false, failed: false }))
              : recover("Desktop update admission was revoked before installation.").pipe(
                Effect.as({ accepted: true, completed: false, failed: true }),
              ),
            ElectronUpdaterQuitAndInstallError: Effect.fn("desktop.updates.handleInstallFailure")(
              function* (error) {
                yield* recover(error.message);
                yield* logUpdaterError(error.message, {
                  errorTag: error._tag,
                  cause: describeUpdateErrorCause(error.cause),
                  channel: error.channel,
                  isSilent: error.isSilent,
                  isForceRunAfter: error.isForceRunAfter,
                });
                return { accepted: true, completed: false, failed: true };
              },
            ),
          }),
          Effect.onInterrupt(() => owned?.stopping() ? recover("Desktop update was interrupted after backend shutdown began.") : resetInstallAction),
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause)) {
                return yield* Effect.failCause(cause);
              }
              const error = new DesktopUpdateUnexpectedActionError({ action: "install", cause });
              yield* recover(error.message);
              yield* logUpdaterError(error.message, {
                errorTag: error._tag,
                cause: describeUpdateErrorCause(error.cause),
                action: error.action,
              });
              return { accepted: true, completed: false, failed: true };
            }),
          ),
        );
      }),
    ).pipe(Effect.withSpan("desktop.updates.installDownloadedUpdate"));

  const installWithExpectedVersion = Effect.fn("desktop.updates.install")(function* (
    expectedVersion?: string,
  ) {
    if (yield* Ref.get(desktopState.quitting)) {
      return {
        accepted: false,
        completed: false,
        failed: false,
        state: yield* Ref.get(updateStateRef),
      };
    }
    const result = yield* (Option.isSome(qualification)
      ? attemptAdmittedInstall(expectedVersion, "manual")
      : installDownloadedUpdate(expectedVersion));
    return {
      accepted: result.accepted,
      completed: result.completed,
      failed: result.failed,
      state: yield* Ref.get(updateStateRef),
    };
  });

  const refusedInstall = { accepted: false, completed: false, failed: false };
  const attemptAdmittedInstall = (expectedVersion?: string, trigger: "automatic" | "manual" = "automatic") => Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    const holdPool = pool.withUpdateInventory;
    const holdRenderers = electronWindow.withUpdateRenderers;
    const inventory = electronWindow.updateInventory;
    if (Option.isSome(yield* Ref.get(activeUpdateActionRef)) || state.status !== "downloaded" || state.downloadedVersion === null ||
      (expectedVersion !== undefined && state.downloadedVersion !== expectedVersion) ||
      (trigger === "automatic" && state.notAppliedVersion === state.downloadedVersion) ||
      (yield* Ref.get(desktopState.quitting))) return refusedInstall;
    const targetVersion = state.downloadedVersion;
    if (compareSemverVersions(targetVersion, state.currentVersion) <= 0) return refusedInstall;
    const captured = yield* beginDeferAttempt(state);
    if (Option.isNone(captured)) { yield* updateState((current) => current); return refusedInstall; }
    const attempt = captured.value;
    if (Option.isNone(qualification) || holdPool === undefined || holdRenderers === undefined || inventory === undefined) return yield* deferInstall(attempt, "runtime-unknown");
    const runtimeQualification = qualification.value;
    let recovery: { readonly message: string; readonly preserveInstallRecord: boolean } | undefined;
    let recoveryHook: OwnedBackendInstallAdmission["deferRecovery"] | undefined;
    const result = yield* holdPool((instances) => holdRenderers(Effect.scoped(Effect.gen(function* () {
      const admissionGeneration = attempt.admissionGeneration;
      const generation = attempt.attemptId;
      const expiresAt = (yield* Clock.currentTimeMillis) + 30_000;
      const reservation = yield* runtimeQualification.acquireRuntimeReservation({ generation, targetVersion, expiresAt });
      if (Option.isNone(reservation) || !reservation.value.isValid()) return yield* deferInstall(attempt, "runtime-unknown");
      const runtime = reservation.value;
      const prepared: Array<{ instance: DesktopBackendPool.DesktopBackendInstance; proof: DesktopBackendPool.DesktopBackendUpdateProof }> = [];
      let stopping = false;
      yield* Effect.addFinalizer(() => stopping ? Effect.void : Effect.forEach(prepared, ({ proof }) => proof.abort, { concurrency: "unbounded" }).pipe(
        Effect.flatMap((aborted) => aborted.every(Boolean) ? Effect.void : logUpdaterWarning("Some backend update holds could not be released; no backend was stopped.")),
      ));
      const snapshots = yield* Effect.forEach(instances, (instance) => instance.snapshot);
      // Pool instances are app-owned. Externally managed services are never in
      // this inventory and are never shutdown targets for a client update.
      const preparation = yield* Effect.forEach(instances, (instance, index) => Effect.gen(function* () {
        const snapshot = snapshots[index];
        if (snapshot === undefined) return "runtime-unknown" as const;
        const inactive = !snapshot.desiredRunning && !snapshot.ready && Option.isNone(snapshot.activePid) && !snapshot.restartScheduled;
        if (inactive) return "ready" as const;
        if (!snapshot.desiredRunning || !snapshot.ready || Option.isNone(snapshot.activePid) || snapshot.restartScheduled) return "runtime-busy" as const;
        if (instance.prepareUpdate === undefined || instance.stopForUpdate === undefined) return "peer-unsupported" as const;
        const proof = yield* instance.prepareUpdate({ requestId: generation, targetVersion, admissionGeneration, expiresAt });
        if (Option.isNone(proof)) return "runtime-unknown" as const;
        prepared.push({ instance, proof: proof.value });
        return "ready" as const;
      }), { concurrency: "unbounded" });
      const refusal = preparation.find((result) => result !== "ready");
      if (refusal !== undefined) return yield* deferInstall(attempt, refusal, instances.flatMap((instance, index) => preparation[index] === "ready" ? [] : [{ instanceId: instance.id, status: "held" as const, shutdown: "not-started" as const }]));
      if (!runtime.isValid()) return yield* deferInstall(attempt, "stale-proof");
      const expected = yield* inventory;
      if (expected.some((renderer) => renderer.audible !== false)) return yield* deferInstall(attempt, "runtime-busy");
      for (const phase of ["prepare", "validate"] as const) {
        if (!runtime.isValid()) return yield* deferInstall(attempt, "stale-proof");
        const lease = { generation, targetVersion, expiresAt, phase };
        const signal = yield* Deferred.make<boolean>();
        yield* Ref.set(pendingReadiness, { lease, senders: new Set(expected.map((item) => item.id)), signal });
        yield* updateState((current) => ({ ...current, installLease: lease }));
        if (expected.length > 0) {
          const ready = yield* Deferred.await(signal).pipe(Effect.timeoutOption(Duration.seconds(5)));
          if (Option.isNone(ready) || !ready.value) return yield* deferInstall(attempt, "renderer-refused");
        }
      }
      const currentInventory = yield* inventory;
      const sameInventory = expected.length === currentInventory.length && expected.every((renderer, index) => {
        const current = currentInventory[index];
        return current !== undefined && renderer.id === current.id && renderer.generation === current.generation && renderer.audible === current.audible;
      });
      const validPrepared = yield* Effect.forEach(prepared, ({ proof }) => proof.isValid);
      if ((yield* Clock.currentTimeMillis) >= expiresAt - 5_000) return yield* deferInstall(attempt, "expired-proof");
      if (!sameInventory || !validPrepared.every(Boolean) || !runtime.isValid()) return yield* deferInstall(attempt, "stale-proof");
      const committed = yield* Effect.forEach(prepared, ({ proof }) => proof.commit, { concurrency: "unbounded" });
      if ((yield* Clock.currentTimeMillis) >= expiresAt - 5_000) return yield* deferInstall(attempt, "expired-proof");
      if (!committed.every(Boolean) || !runtime.isValid() || !runtime.tryCommit()) return yield* deferInstall(attempt, "stale-proof");
      yield* updateState((current) => ({ ...current, installLease: { generation, targetVersion, expiresAt, phase: "commit" } }));
      // Verify worst-case final capacity and atomic storage BEFORE touching
      // the canonical from/target install record, restart marker or any process.
      const worst = prepared.map(({ instance }) => ({ instanceId: instance.id, status: "superseded" as const, shutdown: "unconfirmed" as const }));
      if ((yield* storeDeferRecord(attempt, "storage-unavailable", worst, true, true)) !== "stored") return refusedInstall;
      const completions = yield* PubSub.subscribe(finishedUpdateActions);
      const owned: OwnedBackendInstallAdmission = {
        attempt,
        instances: prepared.map(({ instance, proof }) => ({ ...instance, start: proof.recover.pipe(
          Effect.flatMap((status) => Ref.update(recoveryOutcomesRef, (outcomes) => outcomes.map((outcome) => outcome.instanceId === instance.id ? { ...outcome, status } : outcome))),
        ) })),
        stopping: () => stopping,
        deferRecovery: (message, preserveInstallRecord = false) => Effect.sync(() => { recovery = { message, preserveInstallRecord }; }),
        stopAll: Effect.gen(function* () {
          if (!(yield* ownsDeferAttempt(attempt))) return false;
          const valid = yield* Effect.forEach(prepared, ({ proof }) => proof.isValid);
          if (!runtime.isValid() || !valid.every(Boolean) || (yield* Clock.currentTimeMillis) >= expiresAt - 5_000) return false;
          // Irreversible batch admission: no peer may be aborted/opened once
          // the first canonical shutdown can begin. Later failure is recovery.
          stopping = prepared.length > 0;
          yield* Ref.set(recoveryStoppingRef, stopping);
          const stopped = yield* Effect.forEach(prepared, ({ instance, proof }) => Effect.gen(function* () {
            yield* Ref.update(recoveryOutcomesRef, (outcomes) => outcomes.map((peer) => peer.instanceId === instance.id ? { ...peer, shutdown: "unconfirmed" as const } : peer));
            const result = yield* (instance.stopForUpdate?.(proof) ?? Effect.succeed(false));
            if (result) yield* Ref.update(recoveryOutcomesRef, (outcomes) => outcomes.map((peer) => peer.instanceId === instance.id ? { ...peer, shutdown: "stopped" as const } : peer));
            return result;
          }), { concurrency: "unbounded" });
          return stopped.every(Boolean);
        }),
      };
      recoveryHook = owned.deferRecovery;
      const installed = yield* installDownloadedUpdate(targetVersion, prepared.length === 0, runtime, owned);
      if (installed.accepted && !installed.failed) {
        while ((yield* PubSub.take(completions)) !== "install-recovery") { /* Hold until exit or recovery. */ }
      }
      return installed;
    }))).pipe(Effect.ensuring(Effect.gen(function* () {
      yield* Ref.set(pendingReadiness, null);
      yield* updateState(({ installLease: _lease, ...current }) => current);
    })))).pipe(Effect.onExit(() => Ref.update(heldRecoveryRef, (current) => current === recoveryHook ? null : current).pipe(
      Effect.andThen(Effect.suspend(() => recovery === undefined ? Effect.void : recoverFailedInstall(recovery.message, recovery.preserveInstallRecord))),
    )));
    return Option.isNone(result) ? yield* deferInstall(attempt, "runtime-busy") : result.value;
  }).pipe(Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) :
    logUpdaterWarning("Update admission could not be verified; update remains prepared.").pipe(Effect.as(refusedInstall))));

  const startUpdatePollers: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* Effect.sleep("1 minute").pipe(
      Effect.andThen(attemptAdmittedInstall()), Effect.forever, Effect.forkScoped,
    );
    // Keep Electron's implicit download/install hooks disabled. The same action
    // reservation and failure handling serve manual and background downloads;
    // installation still requires a separately admitted safe restart window.
    const checkAndPrepare = (reason: string) =>
      checkForUpdates(reason).pipe(
        Effect.flatMap((checked) =>
          checked ? downloadAvailableUpdate.pipe(Effect.asVoid) : Effect.void,
        ),
      );
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(checkAndPrepare("startup")),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "startup", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
    yield* Effect.sleep(AUTO_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(checkAndPrepare("poll")),
      Effect.forever,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "poll", cause });
        return logUpdaterError(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.updates.startPollers"));

  const handleUpdateAvailable = Effect.fn("desktop.updates.handleUpdateAvailable")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateAvailable")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          if (!isReleasedDesktopVersionForChannel(info.version, state.channel)) {
            yield* logUpdaterInfo("ignoring update that does not match selected channel", {
              version: info.version,
              channel: state.channel,
            });
            const checkedAt = yield* currentIsoTimestamp;
            yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
            yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
            return;
          }

          const checkedAt = yield* currentIsoTimestamp;
          const { releaseNotes, omittedReleaseCount } = normalizeDesktopUpdateReleaseNotes(
            info.releaseNotes,
            info.version,
            state.channel,
          );
          yield* setState(
            reduceDesktopUpdateStateOnUpdateAvailable(
              state,
              info.version,
              checkedAt,
              releaseNotes,
              omittedReleaseCount,
            ),
          );
          yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
          yield* logUpdaterInfo("update available", {
            version: info.version,
            releaseNoteGroups: releaseNotes.length,
            omittedReleaseCount,
          });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-available", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateNotAvailable = Effect.gen(function* () {
    const checkedAt = yield* currentIsoTimestamp;
    const state = yield* Ref.get(updateStateRef);
    yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
    yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
    yield* logUpdaterInfo("no updates available");
  }).pipe(Effect.withSpan("desktop.updates.handleUpdateNotAvailable"));

  const handleUpdaterError = Effect.fn("desktop.updates.handleUpdaterError")(function* (
    cause: unknown,
  ) {
    const activeAction = yield* activeUpdateAction;
    const error = new DesktopUpdaterReportedError({
      operation: Option.match(activeAction, {
        onNone: () => "background" as const,
        onSome: (action) => (action === "install-recovery" ? "install" : action),
      }),
      cause,
    });
    if (Option.isSome(activeAction) && activeAction.value === "install") {
      yield* recoverFailedInstall(error.message);
      yield* logUpdaterError(error.message, {
        errorTag: error._tag,
        cause: describeUpdateErrorCause(error.cause),
        operation: error.operation,
      });
      return;
    }

    if (Option.isNone(activeAction)) {
      const checkedAt = yield* currentIsoTimestamp;
      yield* updateState((current) => ({
        ...current,
        status: "error",
        message: error.message,
        checkedAt,
        downloadPercent: null,
        errorContext: current.errorContext,
        canRetry: getCanRetryFromState(current),
      }));
    }

    yield* logUpdaterError(error.message, {
      errorTag: error._tag,
      cause: describeUpdateErrorCause(error.cause),
      operation: error.operation,
    });
  });

  const handleDownloadProgress = Effect.fn("desktop.updates.handleDownloadProgress")(function* (
    raw: unknown,
  ) {
    yield* decodeDownloadProgressInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyDownloadProgress")(function* (progress) {
          const state = yield* Ref.get(updateStateRef);
          const percent = Math.floor(progress.percent);
          if (shouldBroadcastDownloadProgress(state, progress.percent) || state.message !== null) {
            yield* setState(reduceDesktopUpdateStateOnDownloadProgress(state, progress.percent));
          }
          const milestone = percent - (percent % 10);
          const lastLoggedMilestone = yield* Ref.get(lastLoggedDownloadMilestoneRef);
          if (milestone > lastLoggedMilestone) {
            yield* Ref.set(lastLoggedDownloadMilestoneRef, milestone);
            yield* logUpdaterInfo("download progress", { percent });
          }
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "download-progress", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateDownloaded = Effect.fn("desktop.updates.handleUpdateDownloaded")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateDownloaded")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          if (
            !isReleasedDesktopVersionForChannel(info.version, state.channel) ||
            (state.availableVersion !== null && state.availableVersion !== info.version)
          ) {
            yield* logUpdaterWarning("ignoring downloaded update outside the selected release train", {
              channel: state.channel,
            });
            return;
          }
          yield* setState(reduceDesktopUpdateStateOnDownloadComplete(state, info.version));
          yield* logUpdaterInfo("update downloaded", { version: info.version });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-downloaded", cause });
        return logUpdaterWarning(error.message, {
          errorTag: error._tag,
          cause: describeUpdateErrorCause(error.cause),
          event: error.event,
        });
      }),
    );
  });

  return DesktopUpdates.of({
    acknowledgeReadiness: (senderId, readiness) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const completed = yield* Ref.modify(pendingReadiness, (pending) => {
        if (pending === null || now >= pending.lease.expiresAt ||
          pending.lease.generation !== readiness.lease.generation ||
          pending.lease.targetVersion !== readiness.lease.targetVersion ||
          pending.lease.expiresAt !== readiness.lease.expiresAt ||
          pending.lease.phase !== readiness.lease.phase ||
          !pending.senders.has(senderId)) return [null, pending] as const;
        const senders = new Set(pending.senders);
        senders.delete(senderId);
        return [
          !readiness.ready || senders.size === 0 ? { signal: pending.signal, ready: readiness.ready } : null,
          { ...pending, senders },
        ] as const;
      });
      if (completed !== null) yield* Deferred.succeed(completed.signal, completed.ready);
      return completed !== null;
    }),
    getState: Ref.get(updateStateRef),
    isActionActive: activeUpdateAction.pipe(Effect.map(Option.isSome)),
    isInstallActive: activeUpdateAction.pipe(
      Effect.map((action) => Option.isSome(action) && action.value === "install"),
    ),
    subscribe: stateMutex.withPermits(1)(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(stateChanges);
        const latest = yield* Ref.get(updateStateRef);
        return { latest, changes: Stream.fromSubscription(subscription) };
      }),
    ),
    emitState,
    disabledReason: resolveDisabledReason,
    configure: Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runEffect = (effect: Effect.Effect<void>) => {
        void Effect.runPromiseWith(context)(effect);
      };

      yield* Ref.set(deferWriterRef, yield* crypto.randomUUIDv4.pipe(Effect.option));
      yield* deferStorageMutex.withPermits(1)(refreshDeferRecord);
      const appUpdateYmlConfig = yield* readAppUpdateYml;
      yield* Ref.set(appUpdateYmlConfigRef, appUpdateYmlConfig);

      const notAppliedVersion = yield* readNotAppliedInstallVersion;
      yield* Ref.set(notAppliedVersionRef, notAppliedVersion);
      if (Option.isSome(notAppliedVersion)) {
        yield* logUpdaterWarning("the last update install did not apply", {
          version: environment.appVersion,
          targetVersion: notAppliedVersion.value,
        });
      }

      if (config.mockUpdates) {
        yield* electronUpdater.setFeedURL({
          provider: "generic",
          url: `http://localhost:${config.mockUpdateServerPort}`,
        } as ElectronUpdater.ElectronUpdaterFeedUrl);
      }

      const settings = yield* desktopSettings.get;
      const enabled = yield* shouldEnableAutoUpdates;
      yield* setState(yield* baseUpdateState(settings.updateChannel, enabled));
      if (!enabled) {
        return;
      }
      yield* Ref.set(updaterConfiguredRef, true);

      yield* electronUpdater.setAutoDownload(false);
      yield* electronUpdater.setAutoInstallOnAppQuit(false);
      yield* applyAutoUpdaterChannel(settings.updateChannel);
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );

      if (isArm64HostRunningIntelBuild(environment.runtimeInfo)) {
        yield* logUpdaterInfo(
          "Apple Silicon host detected while running Intel build; updates will switch to arm64 packages",
        );
      }

      yield* electronUpdater.on("checking-for-update", () => {
        runEffect(
          logUpdaterInfo("looking for updates").pipe(
            Effect.withSpan("desktop.updates.handleCheckingForUpdate"),
          ),
        );
      });
      yield* electronUpdater.on("update-available", (info: unknown) => {
        runEffect(handleUpdateAvailable(info));
      });
      yield* electronUpdater.on("update-not-available", () => {
        runEffect(handleUpdateNotAvailable);
      });
      yield* electronUpdater.on("error", (error: unknown) => {
        runEffect(handleUpdaterError(error));
      });
      yield* electronUpdater.on("download-progress", (progress: unknown) => {
        runEffect(handleDownloadProgress(progress));
      });
      yield* electronUpdater.on("update-downloaded", (info: unknown) => {
        runEffect(handleUpdateDownloaded(info));
      });

      yield* startUpdatePollers;
    }).pipe(Effect.withSpan("desktop.updates.configure")),
    setChannel: Effect.fn("desktop.updates.setChannel")(function* (
      nextChannel: DesktopUpdateChannel,
    ) {
      yield* Effect.annotateCurrentSpan({ channel: nextChannel });
      const activeAction = yield* tryStartChannelChange;
      if (Option.isSome(activeAction)) {
        return yield* new DesktopUpdateActionInProgressError({
          action: activeAction.value === "install-recovery" ? "install" : activeAction.value,
          requestedChannel: nextChannel,
        });
      }

      return yield* Effect.gen(function* () {
        const state = yield* Ref.get(updateStateRef);
        if (nextChannel === state.channel) {
          return state;
        }

        yield* desktopSettings
          .setUpdateChannel(nextChannel)
          .pipe(
            Effect.mapError(
              (cause) => new DesktopUpdateChannelPersistenceError({ channel: nextChannel, cause }),
            ),
          );

        const enabled = yield* shouldEnableAutoUpdates;
        yield* setState(yield* baseUpdateState(nextChannel, enabled));

        if (!enabled || !(yield* Ref.get(updaterConfiguredRef))) {
          return yield* Ref.get(updateStateRef);
        }

        yield* applyAutoUpdaterChannel(nextChannel);
        const allowDowngrade = yield* electronUpdater.allowDowngrade;
        yield* electronUpdater.setAllowDowngrade(true);
        yield* checkForUpdates("channel-change", "held").pipe(
          Effect.ensuring(electronUpdater.setAllowDowngrade(allowDowngrade).pipe(Effect.ignore)),
        );
        return yield* Ref.get(updateStateRef);
      }).pipe(Effect.ensuring(finishUpdateAction("channel")));
    }),
    check: Effect.fn("desktop.updates.check")(function* (reason: string) {
      yield* Effect.annotateCurrentSpan({ reason });
      if (!(yield* Ref.get(updaterConfiguredRef))) {
        return {
          checked: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const checked = yield* checkForUpdates(reason);
      return {
        checked,
        state: yield* Ref.get(updateStateRef),
      };
    }),
    download: Effect.gen(function* () {
      const result = yield* downloadAvailableUpdate;
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.download")),
    install: installWithExpectedVersion().pipe(
      Effect.map(({ accepted, completed, state }) => ({ accepted, completed, state })),
    ),
    installPrepared: (expectedVersion) => installWithExpectedVersion(expectedVersion),
  });
});

export const layer = Layer.effect(DesktopUpdates, make);
