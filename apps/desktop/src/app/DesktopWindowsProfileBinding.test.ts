// @effect-diagnostics nodeBuiltinImport:off - Tests the synchronous pre-bootstrap filesystem boundary.
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import {
  resolveWindowsProfileHome,
  resolveWindowsProfileBinding,
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
  it.each([3775, 3773])("retains the verified port %s across a cold shortcut launch", (port) => {
    const { input, bindingPath } = fixture();
    const t3Home = "C:\\Users\\User\\.t3-morrowbyte-windows";
    resolveWindowsProfileHome({ ...input, explicitHome: t3Home });
    expect(resolveWindowsProfileBinding({ ...input, explicitBackendPort: String(port) }))
      .toEqual({ t3Home, backendPort: port });
    expect(resolveWindowsProfileBinding(input)).toEqual({ t3Home, backendPort: port });
    expect(JSON.parse(Fs.readFileSync(bindingPath, "utf8")).schemaVersion).toBe(1);
    expect(Fs.readdirSync(Path.dirname(bindingPath))).toEqual(["desktop-profile.json"]);
  });

  it("does not borrow or change another home's port for an explicit override", () => {
    const { input, bindingPath } = fixture();
    resolveWindowsProfileBinding({ ...input, explicitHome: "D:\\first", explicitBackendPort: "3775" });
    const before = Fs.readFileSync(bindingPath, "utf8");
    expect(resolveWindowsProfileBinding({ ...input, explicitHome: "D:\\second" }))
      .toEqual({ t3Home: "D:\\second", backendPort: undefined });
    expect(resolveWindowsProfileBinding({ ...input, explicitHome: "D:\\second", explicitBackendPort: "3773" }))
      .toEqual({ t3Home: "D:\\second", backendPort: 3773 });
    expect(Fs.readFileSync(bindingPath, "utf8")).toBe(before);
  });

  it("does not silently persist a default port for an old home-only binding", () => {
    const { input, bindingPath } = fixture();
    resolveWindowsProfileHome({ ...input, explicitHome: "D:\\first" });
    const before = Fs.readFileSync(bindingPath, "utf8");
    expect(resolveWindowsProfileBinding(input).backendPort).toBeUndefined();
    expect(Fs.readFileSync(bindingPath, "utf8")).toBe(before);
  });

  it("keeps an existing port when a one-off explicit port overrides it", () => {
    const { input } = fixture();
    resolveWindowsProfileBinding({ ...input, explicitHome: "D:\\first", explicitBackendPort: "3775" });
    expect(resolveWindowsProfileBinding({ ...input, explicitBackendPort: "9000" }).backendPort).toBe(9000);
    expect(resolveWindowsProfileBinding(input).backendPort).toBe(3775);
  });

  it("rejects invalid saved or explicit ports before selecting a backend", () => {
    const { input, write } = fixture();
    for (const port of [0, -1, 65536, 1.5, "3775", null]) {
      write({ schemaVersion: 1, profile: "weasel", t3Home: "D:\\first", backendPort: port });
      expect(() => resolveWindowsProfileBinding(input)).toThrow("Saved Windows desktop profile is invalid");
    }
    for (const port of ["0", "-1", "65536", "1.5", "1e3", "invalid"]) {
      expect(() => resolveWindowsProfileBinding({ ...input, explicitBackendPort: port }))
        .toThrow("Windows T3CODE_PORT must be a valid TCP port");
    }
  });

  it("preserves another writer's binding while its upgrade lock is held", () => {
    const { input, bindingPath } = fixture();
    resolveWindowsProfileHome({ ...input, explicitHome: "D:\\first" });
    const before = Fs.readFileSync(bindingPath, "utf8");
    Fs.writeFileSync(`${bindingPath}.lock`, "other writer", { flag: "wx" });
    expect(resolveWindowsProfileBinding({ ...input, explicitBackendPort: "3775" }).backendPort).toBe(3775);
    expect(Fs.readFileSync(bindingPath, "utf8")).toBe(before);
    expect(Fs.readFileSync(`${bindingPath}.lock`, "utf8")).toBe("other writer");
  });

});
