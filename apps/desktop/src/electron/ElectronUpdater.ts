import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { autoUpdater as electronAutoUpdater } from "electron-updater";
import * as Electron from "electron";
import { NixManagedUpdater, NixUpdateAdmissionError } from "./NixManagedUpdater.ts";
import { quitAndInstallInPlace } from "./quitAndInstallInPlace.ts";

let updaterInstance: typeof electronAutoUpdater | NixManagedUpdater | undefined;
function currentUpdater() {
  return (updaterInstance ??=
    process.platform === "linux" && process.env.T3CODE_NIX_UPDATER
      ? new NixManagedUpdater({
          command: process.env.T3CODE_NIX_UPDATER,
          launcher: process.env.T3CODE_NIX_LAUNCHER ?? "",
          currentVersion: Electron.app.getVersion(),
          relaunch: (launcher) => {
            Electron.app.relaunch({ execPath: launcher, args: process.argv.slice(1) });
            Electron.autoUpdater.emit("before-quit-for-update");
            Electron.app.quit();
          },
        })
      : electronAutoUpdater);
}

type AutoUpdater = typeof electronAutoUpdater;

export type ElectronUpdaterFeedUrl = Parameters<AutoUpdater["setFeedURL"]>[0];

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export class ElectronUpdaterInstallAdmissionError extends Schema.TaggedError<ElectronUpdaterInstallAdmissionError>()(
  "ElectronUpdaterInstallAdmissionError",
  { reason: Schema.Literals(["refused", "probe-failed"]) },
) {
  override get message(): string {
    return "Desktop update admission is no longer valid.";
  }
}

export class ElectronUpdaterNixActivationAdmissionError extends Schema.TaggedError<ElectronUpdaterNixActivationAdmissionError>()(
  "ElectronUpdaterNixActivationAdmissionError",
  { selectedVersion: Schema.String, runningVersion: Schema.String },
) {
  override get message(): string {
    return "Nix closure activated; the running desktop was retained after update admission was revoked.";
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
  ElectronUpdaterInstallAdmissionError,
  ElectronUpdaterNixActivationAdmissionError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
      readonly beforeInstall?: () => boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError | ElectronUpdaterInstallAdmissionError | ElectronUpdaterNixActivationAdmissionError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronUpdater") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = ElectronUpdater.of({
  setFeedURL: (options) =>
    Effect.suspend(() => {
      currentUpdater().setFeedURL(options);
      return Effect.void;
    }),
  setAutoDownload: (value) =>
    Effect.suspend(() => {
      currentUpdater().autoDownload = value;
      return Effect.void;
    }),
  setAutoInstallOnAppQuit: (value) =>
    Effect.suspend(() => {
      currentUpdater().autoInstallOnAppQuit = value;
      return Effect.void;
    }),
  setChannel: (channel) =>
    Effect.suspend(() => {
      currentUpdater().channel = channel;
      return Effect.void;
    }),
  setAllowPrerelease: (value) =>
    Effect.suspend(() => {
      currentUpdater().allowPrerelease = value;
      return Effect.void;
    }),
  allowDowngrade: Effect.sync(() => currentUpdater().allowDowngrade),
  setAllowDowngrade: (value) =>
    Effect.suspend(() => {
      currentUpdater().allowDowngrade = value;
      return Effect.void;
    }),
  setFullChangelog: (value) =>
    Effect.suspend(() => {
      currentUpdater().fullChangelog = value;
      return Effect.void;
    }),
  setDisableDifferentialDownload: (value) =>
    Effect.suspend(() => {
      currentUpdater().disableDifferentialDownload = value;
      return Effect.void;
    }),
  checkForUpdates: Effect.suspend(() => {
    const channel = currentUpdater().channel;
    return Effect.tryPromise({
      try: async () => {
        await currentUpdater().checkForUpdates();
      },
      catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  downloadUpdate: Effect.suspend(() => {
    const channel = currentUpdater().channel;
    return Effect.tryPromise({
      try: async () => {
        await currentUpdater().downloadUpdate();
      },
      catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  quitAndInstall: ({ isSilent, isForceRunAfter, beforeInstall }) =>
    Effect.suspend(() => {
      const channel = currentUpdater().channel;
      return Effect.tryPromise({
        try: async () => {
          if (beforeInstall !== undefined) {
            let admitted: boolean;
            try { admitted = beforeInstall(); }
            catch { throw new ElectronUpdaterInstallAdmissionError({ reason: "probe-failed" }); }
            if (!admitted) throw new ElectronUpdaterInstallAdmissionError({ reason: "refused" });
          }
          // Nix revalidates this same held token across its activation awaits.
          const updater = currentUpdater();
          if (updater instanceof NixManagedUpdater) {
            await updater.quitAndInstall(isSilent, isForceRunAfter, beforeInstall);
            return;
          }
          // No await between the live guard and the canonical native invocation.
          await quitAndInstallInPlace(updater, {
            platform: process.platform,
            isPackaged: Electron.app.isPackaged,
            executable: process.execPath,
            isSilent,
            isForceRunAfter,
          });
        },
        catch: (cause) => cause instanceof ElectronUpdaterInstallAdmissionError ? cause :
          cause instanceof NixUpdateAdmissionError
            ? cause.selectedVersion === null
              ? new ElectronUpdaterInstallAdmissionError({ reason: "refused" })
              : new ElectronUpdaterNixActivationAdmissionError({ selectedVersion: cause.selectedVersion, runningVersion: cause.runningVersion })
            : new ElectronUpdaterQuitAndInstallError({
            channel,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      });
    }),
  on: (eventName, listener) => {
    const eventTarget = currentUpdater() as unknown as {
      on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
      removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
    };
    const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
    return Effect.acquireRelease(
      Effect.sync(() => {
        eventTarget.on(eventName, untypedListener);
      }),
      () =>
        Effect.sync(() => {
          eventTarget.removeListener(eventName, untypedListener);
        }),
    ).pipe(Effect.asVoid);
  },
});

export const layer = Layer.succeed(ElectronUpdater, make);
