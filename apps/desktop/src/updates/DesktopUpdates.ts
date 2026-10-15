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
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  const qualification = yield* Effect.serviceOption(DesktopUpdateInstallQualification);

  const appUpdateYmlConfigRef = yield* Ref.make<Option.Option<AppUpdateYmlConfig>>(Option.none());
  const activeUpdateActionRef = yield* Ref.make<Option.Option<UpdateAction>>(Option.none());
  const finishedUpdateActions = yield* PubSub.unbounded<UpdateAction>();
  const updaterConfiguredRef = yield* Ref.make(false);
  const clientOnlyInstallRef = yield* Ref.make(false);
  const recoveryInstancesRef = yield* Ref.make<ReadonlyArray<DesktopBackendPool.DesktopBackendInstance> | null>(null);
  const recoveryOutcomesRef = yield* Ref.make<ReadonlyArray<{ readonly instanceId: string; readonly status: "ready" | "held" | "superseded" }>>([]);
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

  const setState = (state: DesktopUpdateState): Effect.Effect<void> =>
    stateMutex
      .withPermits(1)(
        Ref.set(updateStateRef, state).pipe(Effect.andThen(PubSub.publish(stateChanges, state))),
      )
      .pipe(Effect.andThen(emitState));

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

  const resetInstallAction = Effect.all(
    [
      finishUpdateAction("install"),
      Ref.set(desktopState.quitting, false),
      Ref.set(clientOnlyInstallRef, false),
      Ref.set(recoveryInstancesRef, null),
      Ref.set(recoveryOutcomesRef, []),
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
      const recoveryMessage = held.length === 0 ? message : `${message} Recovery remains held for app-owned backends: ${held.slice(0, 128).map((outcome) => outcome.instanceId.slice(0, 128)).join(", ")}. No committed peer was reopened.`;
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
        yield* Ref.set(recoveryOutcomesRef, (owned?.instances ?? []).map((instance) => ({ instanceId: instance.id, status: "held" as const })));
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
              ? resetInstallAction.pipe(Effect.as({ accepted: false, completed: false, failed: false }))
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
    if (Option.isNone(qualification)) return refusedInstall;
    const runtimeQualification = qualification.value;
    const state = yield* Ref.get(updateStateRef);
    const holdPool = pool.withUpdateInventory;
    const holdRenderers = electronWindow.withUpdateRenderers;
    const inventory = electronWindow.updateInventory;
    if (Option.isSome(yield* Ref.get(activeUpdateActionRef)) || state.status !== "downloaded" || state.downloadedVersion === null ||
      (expectedVersion !== undefined && state.downloadedVersion !== expectedVersion) ||
      (trigger === "automatic" && state.notAppliedVersion === state.downloadedVersion) ||
      holdPool === undefined || holdRenderers === undefined || inventory === undefined ||
      (yield* Ref.get(desktopState.quitting))) return refusedInstall;
    const targetVersion = state.downloadedVersion;
    if (compareSemverVersions(targetVersion, state.currentVersion) <= 0) return refusedInstall;
    let recovery: { readonly message: string; readonly preserveInstallRecord: boolean } | undefined;
    let recoveryHook: OwnedBackendInstallAdmission["deferRecovery"] | undefined;
    const result = yield* holdPool((instances) => holdRenderers(Effect.scoped(Effect.gen(function* () {
      const admissionGeneration = yield* Ref.modify(admissionSequence, (value) => [value + 1, value + 1]);
      const generation = `${targetVersion}:${yield* Clock.currentTimeMillis}:${admissionGeneration}`;
      const expiresAt = (yield* Clock.currentTimeMillis) + 30_000;
      const reservation = yield* runtimeQualification.acquireRuntimeReservation({ generation, targetVersion, expiresAt });
      if (Option.isNone(reservation) || !reservation.value.isValid()) return refusedInstall;
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
        if (snapshot === undefined) return false;
        const inactive = !snapshot.desiredRunning && !snapshot.ready && Option.isNone(snapshot.activePid) && !snapshot.restartScheduled;
        if (inactive) return true;
        if (!snapshot.desiredRunning || !snapshot.ready || Option.isNone(snapshot.activePid) || snapshot.restartScheduled ||
          instance.prepareUpdate === undefined || instance.stopForUpdate === undefined) return false;
        const proof = yield* instance.prepareUpdate({ requestId: generation, targetVersion, admissionGeneration, expiresAt });
        if (Option.isNone(proof)) return false;
        prepared.push({ instance, proof: proof.value });
        return true;
      }), { concurrency: "unbounded" });
      if (!preparation.every(Boolean) || !runtime.isValid()) return refusedInstall;
      const expected = yield* inventory;
      if (expected.some((renderer) => renderer.audible !== false)) return refusedInstall;
      for (const phase of ["prepare", "validate"] as const) {
        if (!runtime.isValid()) return refusedInstall;
        const lease = { generation, targetVersion, expiresAt, phase };
        const signal = yield* Deferred.make<boolean>();
        yield* Ref.set(pendingReadiness, { lease, senders: new Set(expected.map((item) => item.id)), signal });
        yield* updateState((current) => ({ ...current, installLease: lease }));
        if (expected.length > 0) {
          const ready = yield* Deferred.await(signal).pipe(Effect.timeoutOption(Duration.seconds(5)));
          if (Option.isNone(ready) || !ready.value) return refusedInstall;
        }
      }
      const currentInventory = yield* inventory;
      const sameInventory = expected.length === currentInventory.length && expected.every((renderer, index) => {
        const current = currentInventory[index];
        return current !== undefined && renderer.id === current.id && renderer.generation === current.generation && renderer.audible === current.audible;
      });
      const validPrepared = yield* Effect.forEach(prepared, ({ proof }) => proof.isValid);
      if (!sameInventory || !validPrepared.every(Boolean) || !runtime.isValid() || (yield* Clock.currentTimeMillis) >= expiresAt - 5_000) return refusedInstall;
      const committed = yield* Effect.forEach(prepared, ({ proof }) => proof.commit, { concurrency: "unbounded" });
      if (!committed.every(Boolean) || !runtime.isValid() ||
        (yield* Clock.currentTimeMillis) >= expiresAt - 5_000 || !runtime.tryCommit()) return refusedInstall;
      yield* updateState((current) => ({ ...current, installLease: { generation, targetVersion, expiresAt, phase: "commit" } }));
      const completions = yield* PubSub.subscribe(finishedUpdateActions);
      const owned: OwnedBackendInstallAdmission = {
        instances: prepared.map(({ instance, proof }) => ({ ...instance, start: proof.recover.pipe(
          Effect.flatMap((status) => Ref.update(recoveryOutcomesRef, (outcomes) => outcomes.map((outcome) => outcome.instanceId === instance.id ? { ...outcome, status } : outcome))),
        ) })),
        stopping: () => stopping,
        deferRecovery: (message, preserveInstallRecord = false) => Effect.sync(() => { recovery = { message, preserveInstallRecord }; }),
        stopAll: Effect.gen(function* () {
          const valid = yield* Effect.forEach(prepared, ({ proof }) => proof.isValid);
          if (!runtime.isValid() || !valid.every(Boolean) || (yield* Clock.currentTimeMillis) >= expiresAt - 5_000) return false;
          // Irreversible batch admission: no peer may be aborted/opened once
          // the first canonical shutdown can begin. Later failure is recovery.
          stopping = prepared.length > 0;
          const stopped = yield* Effect.forEach(prepared, ({ instance, proof }) => instance.stopForUpdate?.(proof) ?? Effect.succeed(false), { concurrency: "unbounded" });
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
    return Option.getOrElse(result, () => refusedInstall);
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
