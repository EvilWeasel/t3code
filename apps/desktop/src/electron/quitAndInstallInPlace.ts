// @effect-diagnostics-next-line nodeBuiltinImport:off - The native updater boundary uses the current executable path synchronously.
import { win32 } from "node:path";

interface UpdaterInstaller {
  installDirectory?: string;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void | Promise<void>;
}

/** NSIS otherwise chooses its registry/default destination. Extracted deployments
 * have no registered destination; keep their stable launchers pointing at the
 * updated executable instead of leaving an obsolete copy behind. */
export function quitAndInstallInPlace(
  updater: UpdaterInstaller,
  input: {
    readonly platform: NodeJS.Platform;
    readonly isPackaged: boolean;
    readonly executable: string;
    readonly isSilent: boolean;
    readonly isForceRunAfter: boolean;
  },
): void | Promise<void> {
  if (input.platform === "win32" && input.isPackaged) {
    if (!win32.isAbsolute(input.executable) || !/\.exe$/i.test(input.executable)) {
      throw new Error("Cannot preserve the current Windows installation directory");
    }
    // Public NsisUpdater API in electron-updater 6.8.9; emitted as its final /D argument.
    updater.installDirectory = win32.dirname(input.executable);
  }
  return updater.quitAndInstall(input.isSilent, input.isForceRunAfter);
}
