// @effect-diagnostics nodeBuiltinImport:off -- Profile selection must finish synchronously before Electron auth and userData bootstrap.
import * as Fs from "node:fs";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";

interface WindowsProfileInput {
  readonly homeDirectory: string;
  readonly appDataDirectory?: string | undefined;
  readonly explicitHome?: string | undefined;
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

function readHome(bindingPath: string): string | undefined {
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
    !isAbsoluteWindowsHome(value.t3Home)
  ) {
    throw new Error(
      "Saved Windows desktop profile is invalid; use an explicit T3CODE_HOME to recover",
    );
  }
  return value.t3Home;
}

/** Called only by the packaged Windows fork, before auth/database bootstrap.
 * Explicit launch configuration wins, but never silently changes an existing
 * default binding belonging to a different profile. No global environment is set. */
export function resolveWindowsProfileHome(input: WindowsProfileInput): string {
  const bindingPath = windowsProfileBindingPath(input);
  const explicitHome = input.explicitHome?.trim();
  if (!explicitHome) {
    // A corrupt binding fails closed instead of opening a new, empty profile.
    return readHome(bindingPath) ?? Path.win32.join(input.homeDirectory, ".t3-weasel");
  }
  if (!isAbsoluteWindowsHome(explicitHome)) {
    throw new Error("Windows T3CODE_HOME must be an absolute path");
  }
  if (Fs.existsSync(bindingPath)) return explicitHome;

  Fs.mkdirSync(Path.dirname(bindingPath), { recursive: true, mode: 0o700 });
  const temporary = `${bindingPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    Fs.writeFileSync(
      temporary,
      JSON.stringify({ schemaVersion: 1, profile: "weasel", t3Home: explicitHome }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    try {
      // Atomic, create-only publication. A concurrent first launch keeps its binding.
      Fs.linkSync(temporary, bindingPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    Fs.rmSync(temporary, { force: true });
  }
  return explicitHome;
}
