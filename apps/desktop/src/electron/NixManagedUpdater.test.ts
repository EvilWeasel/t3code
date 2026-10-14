import { describe, expect, it, vi } from "vite-plus/test";
import { NixManagedUpdater } from "./NixManagedUpdater.ts";

const version = "0.0.47-nightly.20261014.16";
function fixture() {
  const calls: Array<{ args: readonly string[]; channel: string }> = [];
  const relaunch = vi.fn();
  const run = vi.fn(async (args: readonly string[], channel: string) => {
    calls.push({ args, channel });
    return JSON.stringify({ available: version, updateAvailable: true });
  });
  const updater = new NixManagedUpdater({
    command: "/nix/store/test/libexec/update",
    launcher: process.execPath,
    currentVersion: "0.0.47-nightly.20261014.15",
    run,
    relaunch,
  });
  return { updater, calls, run, relaunch };
}

describe("NixManagedUpdater", () => {
  it("prepares the checked version without activation and relaunches only after activation", async () => {
    const { updater, calls, relaunch } = fixture();
    const events: unknown[] = [];
    updater.on("update-available", (info) => events.push(info));
    updater.on("update-downloaded", (info) => events.push(info));
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    expect(events).toEqual([{ version }, { version }]);
    expect(calls).toEqual([
      { args: ["--check"], channel: "nightly" },
      { args: ["--prepare", version], channel: "nightly" },
    ]);
    expect(relaunch).not.toHaveBeenCalled();
    await updater.quitAndInstall(true, true);
    expect(calls.at(-1)).toEqual({ args: ["--activate", version], channel: "nightly" });
    expect(relaunch).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledWith(process.execPath);
  });

  it("keeps failed imports from becoming downloaded updates or quitting", async () => {
    const { updater, run, relaunch } = fixture();
    const downloaded = vi.fn();
    updater.on("update-downloaded", downloaded);
    await updater.checkForUpdates();
    run.mockRejectedValueOnce(new Error("Store import rejected"));
    await expect(updater.downloadUpdate()).rejects.toThrow("Store import rejected");
    await expect(updater.quitAndInstall(true, true)).rejects.toThrow("No verified Nix update");
    expect(downloaded).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("does not quit or relaunch after an activation failure", async () => {
    const { updater, run, relaunch } = fixture();
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    run.mockRejectedValueOnce(new Error("activation failed"));
    await expect(updater.quitAndInstall(true, true)).rejects.toThrow("activation failed");
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("rejects unsafe release metadata and unprepared installs", async () => {
    const { updater, run } = fixture();
    run.mockResolvedValueOnce(JSON.stringify({ available: "../../outside" }));
    await expect(updater.checkForUpdates()).rejects.toThrow("Invalid Nix release metadata");
    await expect(updater.downloadUpdate()).rejects.toThrow("Check for a Nix release");
    await expect(updater.quitAndInstall(true, true)).rejects.toThrow("No verified Nix update");
  });

  it("reports the current version as up to date and maps the stable channel", async () => {
    const { updater, calls, run } = fixture();
    updater.channel = "latest";
    run.mockResolvedValueOnce(JSON.stringify({ available: "0.0.47-nightly.20261014.15" }));
    const noUpdate = vi.fn();
    updater.on("update-not-available", noUpdate);
    await updater.checkForUpdates();
    expect(noUpdate).toHaveBeenCalledOnce();
    expect(calls).toEqual([]); // This overridden fake never calls a command.
    expect(run).toHaveBeenCalledWith(["--check"], "stable");
  });

  it("does not silently downgrade unless the selected channel permits it", async () => {
    const { updater, run } = fixture();
    run.mockResolvedValue(JSON.stringify({ available: "0.0.47-nightly.20261013.1" }));
    const available = vi.fn();
    updater.on("update-available", available);
    await updater.checkForUpdates();
    expect(available).not.toHaveBeenCalled();
    await expect(updater.downloadUpdate()).rejects.toThrow("Check for a Nix release");
    updater.allowDowngrade = true;
    await updater.checkForUpdates();
    expect(available).toHaveBeenCalledOnce();
  });

  it("refuses non-relaunch installation before changing the selected Store root", async () => {
    const { updater, calls } = fixture();
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    await expect(updater.quitAndInstall(true, false)).rejects.toThrow("require relaunch");
    expect(calls).toHaveLength(2);
  });
});
