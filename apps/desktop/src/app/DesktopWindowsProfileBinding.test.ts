// @effect-diagnostics nodeBuiltinImport:off - Tests the synchronous pre-bootstrap filesystem boundary.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import {
  resolveWindowsProfileHome,
  windowsProfileBindingPath,
} from "./DesktopWindowsProfileBinding.ts";

const directories: string[] = [];
function fixture() {
  const appDataDirectory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "t3-windows-binding-"));
  directories.push(appDataDirectory);
  const input = { homeDirectory: "C:\\Users\\User", appDataDirectory };
  const bindingPath = windowsProfileBindingPath(input);
  const write = (value: unknown) => {
    Fs.mkdirSync(Path.dirname(bindingPath), { recursive: true });
    Fs.writeFileSync(bindingPath, typeof value === "string" ? value : JSON.stringify(value));
  };
  return { input, bindingPath, write };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    Fs.rmSync(directory, { recursive: true, force: true });
});

describe("Windows packaged profile binding", () => {
  it("retains an explicit migrated home for later shortcut launches without environment", () => {
    const { input, bindingPath } = fixture();
    const t3Home = "C:\\Users\\User\\.t3-morrowbyte-windows";
    expect(resolveWindowsProfileHome({ ...input, explicitHome: t3Home })).toBe(t3Home);
    expect(JSON.parse(Fs.readFileSync(bindingPath, "utf8"))).toEqual({
      schemaVersion: 1,
      profile: "weasel",
      t3Home,
    });
    expect(resolveWindowsProfileHome(input)).toBe(t3Home);
    expect(Fs.readdirSync(Path.dirname(bindingPath))).toEqual(["desktop-profile.json"]);
  });

  it("keeps the normal default when no binding exists, without writing a default binding", () => {
    const { input, bindingPath } = fixture();
    expect(resolveWindowsProfileHome(input)).toBe("C:\\Users\\User\\.t3-weasel");
    expect(Fs.existsSync(bindingPath)).toBe(false);
  });

  it("honors explicit overrides without overwriting a different existing binding", () => {
    const { input, bindingPath } = fixture();
    const first = "D:\\profiles\\first";
    resolveWindowsProfileHome({ ...input, explicitHome: first });
    const before = Fs.readFileSync(bindingPath, "utf8");
    expect(resolveWindowsProfileHome({ ...input, explicitHome: "D:\\profiles\\second" })).toBe(
      "D:\\profiles\\second",
    );
    expect(Fs.readFileSync(bindingPath, "utf8")).toBe(before);
    expect(resolveWindowsProfileHome(input)).toBe(first);
  });

  it("fails before bootstrap for malformed or nonabsolute saved bindings", () => {
    const { input, write } = fixture();
    for (const value of [
      "not-json",
      { schemaVersion: 1, profile: "weasel", t3Home: "relative" },
      { schemaVersion: 1, profile: "weasel", t3Home: "\\drive-dependent" },
      { schemaVersion: 1, profile: "other", t3Home: "D:\\profiles\\other" },
      { schemaVersion: 2, profile: "weasel", t3Home: "D:\\profiles\\other" },
    ]) {
      write(value);
      expect(() => resolveWindowsProfileHome(input)).toThrow(
        "Saved Windows desktop profile is invalid",
      );
    }
  });

  it("allows an explicit recovery home while preserving an invalid binding for inspection", () => {
    const { input, bindingPath, write } = fixture();
    write("broken original");
    expect(resolveWindowsProfileHome({ ...input, explicitHome: "D:\\recovery" })).toBe(
      "D:\\recovery",
    );
    expect(Fs.readFileSync(bindingPath, "utf8")).toBe("broken original");
  });

  it("does not persist a relative explicit home", () => {
    const { input, bindingPath } = fixture();
    expect(() => resolveWindowsProfileHome({ ...input, explicitHome: "relative" })).toThrow(
      "absolute path",
    );
    expect(Fs.existsSync(bindingPath)).toBe(false);
  });
});
