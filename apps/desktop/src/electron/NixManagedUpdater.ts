import { compareSemverVersions } from "@t3tools/shared/semver";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";

export interface NixUpdaterOptions {
  command: string;
  launcher: string;
  currentVersion: string;
  run?: (args: readonly string[], channel: string) => Promise<string>;
  relaunch: (launcher: string) => void;
}

/** Adapter for immutable Store installs. The helper imports a CI-built closure;
 * preparation never switches the running version and activation never builds. */
export class NixManagedUpdater extends EventEmitter {
  channel = "nightly";
  allowDowngrade = false;
  allowPrerelease = true;
  autoDownload = false;
  autoInstallOnAppQuit = false;
  fullChangelog = false;
  disableDifferentialDownload = true;
  private available: string | undefined;
  private prepared: string | undefined;
  private readonly run: NonNullable<NixUpdaterOptions["run"]>;

  constructor(private readonly options: NixUpdaterOptions) {
    super();
    if (!isAbsolute(options.command) || !isAbsolute(options.launcher)) {
      throw new Error("Nix updater and stable launcher must be absolute paths");
    }
    this.run =
      options.run ??
      ((args, channel) =>
        new Promise((resolve, reject) => {
          execFile(
            options.command,
            [...args],
            {
              env: { ...process.env, T3_WEASEL_CHANNEL: channel },
              timeout: 30 * 60 * 1_000,
              maxBuffer: 1024 * 1024,
            },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
          );
        }));
  }

  setFeedURL(_options: unknown): void {
    // The package pins the release repository; renderer URLs cannot override it.
  }

  private get releaseChannel(): string {
    if (this.channel === "latest") return "stable";
    if (this.channel === "nightly") return "nightly";
    throw new Error("Unsupported Nix release channel");
  }

  async checkForUpdates(): Promise<void> {
    this.emit("checking-for-update");
    const value: unknown = JSON.parse(await this.run(["--check"], this.releaseChannel));
    if (
      !value ||
      typeof value !== "object" ||
      !("available" in value) ||
      typeof value.available !== "string" ||
      !/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(value.available)
    ) {
      throw new Error("Invalid Nix release metadata");
    }
    const version = value.available;
    const difference = compareSemverVersions(version, this.options.currentVersion);
    const available = difference > 0 || (difference < 0 && this.allowDowngrade);
    this.available = available ? version : undefined;
    this.prepared = undefined;
    this.emit(available ? "update-available" : "update-not-available", { version });
  }

  async downloadUpdate(): Promise<void> {
    const version = this.available;
    if (!version) throw new Error("Check for a Nix release before preparing an update");
    await this.run(["--prepare", version], this.releaseChannel);
    this.prepared = version;
    this.emit("download-progress", { percent: 100 });
    this.emit("update-downloaded", { version });
  }

  async quitAndInstall(_isSilent: boolean, isForceRunAfter: boolean): Promise<void> {
    if (!this.prepared) throw new Error("No verified Nix update is prepared");
    // Check before changing current: never strand the user on an unusable launcher.
    if (!isForceRunAfter) throw new Error("Nix desktop updates require relaunch");
    await access(this.options.launcher, constants.X_OK);
    await this.run(["--activate", this.prepared], this.releaseChannel);
    this.options.relaunch(this.options.launcher);
  }
}
