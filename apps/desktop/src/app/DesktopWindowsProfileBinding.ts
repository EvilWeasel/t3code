// @effect-diagnostics nodeBuiltinImport:off -- Profile selection must finish synchronously before Electron auth and userData bootstrap.
import * as Fs from "node:fs";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";

interface WindowsProfileInput {
  readonly homeDirectory: string;
  readonly appDataDirectory?: string | undefined;
  readonly explicitHome?: string | undefined;
  readonly explicitBackendPort?: string | undefined;
}

/** Outside the installation and Electron's version/profile-specific userData.
 * NSIS may replace executables and shortcuts; it must not choose another T3 home. */
export function windowsProfileBindingPath(input: WindowsProfileInput): string {
  return Path.join(
    input.appDataDirectory?.trim() || Path.win32.join(input.homeDirectory, "AppData", "Roaming"),
    "morrowbyte-t3",
    "desktop-profile.json",
  );
}

function isAbsoluteWindowsHome(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    Path.win32.isAbsolute(value) &&
    // A rooted path without a drive (\\profile) depends on the current drive.
    /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value)
  );
}

interface WindowsProfileBinding {
  readonly t3Home: string;
  readonly backendPort?: number | undefined;
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
}

function readBinding(bindingPath: string): (WindowsProfileBinding & { readonly serialized: string }) | undefined {
  let raw: string;
  try {
    if (Fs.statSync(bindingPath).size > 16_384)
      throw new Error("Saved desktop profile is too large");
    raw = Fs.readFileSync(bindingPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot read saved Windows desktop profile", { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      "Saved Windows desktop profile is invalid; use an explicit T3CODE_HOME to recover",
    );
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("profile" in value) ||
    value.profile !== "weasel" ||
    !("t3Home" in value) ||
    !isAbsoluteWindowsHome(value.t3Home) ||
    ("backendPort" in value && !validPort(value.backendPort))
  ) {
    throw new Error(
      "Saved Windows desktop profile is invalid; use an explicit T3CODE_HOME to recover",
    );
  }
  return {
    serialized: raw,
    t3Home: value.t3Home,
    backendPort: "backendPort" in value ? (value.backendPort as number) : undefined,
  };
}

/** Called only by the packaged Windows fork, before auth/database bootstrap.
 * Explicit launch configuration wins, but never silently changes an existing
 * default binding belonging to a different profile. No global environment is set. */
export function resolveWindowsProfileBinding(input: WindowsProfileInput): WindowsProfileBinding {
  const bindingPath = windowsProfileBindingPath(input);
  const explicitHome = input.explicitHome?.trim() || undefined;
  const portText = input.explicitBackendPort?.trim();
  const explicitPort = portText ? Number(portText) : undefined;
  if (portText && (!/^\d+$/.test(portText) || !validPort(explicitPort))) {
    throw new Error("Windows T3CODE_PORT must be a valid TCP port");
  }
  if (explicitHome && !isAbsoluteWindowsHome(explicitHome)) {
    throw new Error("Windows T3CODE_HOME must be an absolute path");
  }

  let saved: ReturnType<typeof readBinding>;
  try {
    saved = readBinding(bindingPath);
  } catch (error) {
    // An explicit recovery launch must not destroy the invalid original record.
    if (!explicitHome) throw error;
    return { t3Home: explicitHome, backendPort: explicitPort };
  }
  const sameHome = saved && (!explicitHome ||
    Path.win32.normalize(saved.t3Home).toLowerCase() ===
      Path.win32.normalize(explicitHome).toLowerCase());
  const selected = {
    t3Home: explicitHome ?? saved?.t3Home ?? Path.win32.join(input.homeDirectory, ".t3-weasel"),
    backendPort: explicitPort ?? (sameHome ? saved?.backendPort : undefined),
  };
  const addPort = sameHome && saved.backendPort === undefined && explicitPort !== undefined;
  if ((!saved && explicitHome) || addPort) {
    Fs.mkdirSync(Path.dirname(bindingPath), { recursive: true, mode: 0o700 });
    const lockPath = `${bindingPath}.lock`;
    let lock: number | undefined;
    if (addPort) {
      try {
        lock = Fs.openSync(lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return selected;
        throw error;
      }
    }
    const temporary = `${bindingPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      Fs.writeFileSync(temporary, JSON.stringify({
        schemaVersion: 1, profile: "weasel", t3Home: saved?.t3Home ?? selected.t3Home,
        ...(selected.backendPort === undefined ? {} : { backendPort: selected.backendPort }),
      }) + "\n", { flag: "wx", mode: 0o600 });
      if (addPort) {
        // Upgrade only the unchanged matching-home record; retain concurrent choices.
        if (Fs.readFileSync(bindingPath, "utf8") === saved?.serialized) Fs.renameSync(temporary, bindingPath);
      } else {
        try {
          Fs.linkSync(temporary, bindingPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
    } finally {
      Fs.rmSync(temporary, { force: true });
      if (lock !== undefined) {
        Fs.closeSync(lock);
        Fs.rmSync(lockPath, { force: true });
      }
    }
  }
  return selected;
}

export function resolveWindowsProfileHome(input: WindowsProfileInput): string {
  return resolveWindowsProfileBinding(input).t3Home;
}
