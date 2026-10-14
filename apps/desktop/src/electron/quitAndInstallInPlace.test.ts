import { describe, expect, it, vi } from "vite-plus/test";
import { quitAndInstallInPlace } from "./quitAndInstallInPlace.ts";

const input = {
  platform: "win32" as const,
  isPackaged: true,
  executable:
    "C:\\Users\\User\\AppData\\Local\\Programs\\morrowbyte-t3-release15\\T3 Code (Weasel Nightly).exe",
  isSilent: true,
  isForceRunAfter: true,
};

describe("native installer destination", () => {
  it("passes the actual extracted installation directory to NSIS before it starts", async () => {
    let observed: string | undefined;
    const updater = {
      installDirectory: "C:\\wrong-default",
      quitAndInstall: vi.fn(async () => {
        observed = updater.installDirectory;
      }),
    };
    await quitAndInstallInPlace(updater, input);
    expect(observed).toBe("C:\\Users\\User\\AppData\\Local\\Programs\\morrowbyte-t3-release15");
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("also preserves an already registered custom path with spaces", () => {
    const updater = { installDirectory: undefined as string | undefined, quitAndInstall: vi.fn() };
    quitAndInstallInPlace(updater, { ...input, executable: "D:\\Apps with spaces\\T3\\t3.exe" });
    expect(updater.installDirectory).toBe("D:\\Apps with spaces\\T3");
  });

  it.each(["linux", "darwin"] as const)("leaves %s installation behavior unchanged", (platform) => {
    const updater = { installDirectory: "/existing", quitAndInstall: vi.fn() };
    quitAndInstallInPlace(updater, { ...input, platform, executable: "/bin/t3" });
    expect(updater.installDirectory).toBe("/existing");
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("does not set a destination for a Windows development process", () => {
    const updater = { installDirectory: undefined as string | undefined, quitAndInstall: vi.fn() };
    quitAndInstallInPlace(updater, { ...input, isPackaged: false });
    expect(updater.installDirectory).toBeUndefined();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("rejects an invalid Windows executable before dispatching the installer", () => {
    const updater = { quitAndInstall: vi.fn() };
    expect(() => quitAndInstallInPlace(updater, { ...input, executable: "relative.exe" })).toThrow(
      "installation directory",
    );
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("preserves asynchronous installer failures for the typed updater error boundary", async () => {
    const updater = {
      quitAndInstall: vi.fn(async () => {
        throw new Error("install failed");
      }),
    };
    await expect(quitAndInstallInPlace(updater, input)).rejects.toThrow("install failed");
  });
});
