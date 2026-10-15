import { describe, expect, it, vi } from "vite-plus/test";
import { NixManagedUpdater, NixUpdateAdmissionError, type NixUpdaterOptions } from "./NixManagedUpdater.ts";

const version = "0.0.47-nightly.20261014.16";
function fixture(options: Partial<NixUpdaterOptions> = {}) {
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
    ...options,
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

  it.each(["revoked", "expired"] as const)("refuses activation when proof is %s during launcher access", async (reason) => {
    let finishAccess: () => void = () => { throw new Error("access not started"); };
    let accessStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { accessStarted = resolve; });
    const accessLauncher = () => new Promise<void>((resolve) => { finishAccess = resolve; accessStarted(); });
    let valid = true;
    let now = 100;
    const { updater, calls, relaunch } = fixture({ accessLauncher });
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    const installing = updater.quitAndInstall(true, true, () => valid && now < 200);
    const rejected = expect(installing).rejects.toMatchObject({ selectedVersion: null });
    await started;
    if (reason === "revoked") valid = false; else now = 200;
    finishAccess();
    await rejected;
    expect(calls.some(({ args }) => args[0] === "--activate")).toBe(false);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("retains the running desktop and reports selected-version divergence after activation loses proof", async () => {
    let finishActivation: () => void = () => { throw new Error("activation not started"); };
    let activationStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { activationStarted = resolve; });
    let valid = true;
    const { updater, run, relaunch } = fixture({ accessLauncher: async () => {} });
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    run.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishActivation = resolve; activationStarted(); });
      return "";
    });
    const installing = updater.quitAndInstall(true, true, () => valid);
    const rejected = expect(installing).rejects.toMatchObject({
      selectedVersion: version, runningVersion: "0.0.47-nightly.20261014.15",
    });
    await started;
    valid = false;
    finishActivation();
    await rejected;
    expect(relaunch).not.toHaveBeenCalled();
    expect(run.mock.calls.at(-1)?.[0]).toEqual(["--activate", version]);
  });

  it("treats a throwing live probe as refusal before any activation", async () => {
    const { updater, calls, relaunch } = fixture();
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    await expect(updater.quitAndInstall(true, true, () => { throw new Error("unknown"); }))
      .rejects.toBeInstanceOf(NixUpdateAdmissionError);
    expect(calls.some(({ args }) => args[0] === "--activate")).toBe(false);
    expect(relaunch).not.toHaveBeenCalled();
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

  it("keeps an already prepared release installable after a background check", async () => {
    const { updater, calls, relaunch } = fixture();
    await updater.checkForUpdates();
    await updater.downloadUpdate();
    await updater.checkForUpdates();
    await updater.quitAndInstall(true, true);
    expect(calls.at(-1)).toEqual({ args: ["--activate", version], channel: "nightly" });
    expect(relaunch).toHaveBeenCalledOnce();
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
