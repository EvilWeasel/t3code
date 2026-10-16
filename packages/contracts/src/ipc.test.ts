import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema, MainRendererDiagnosticsReason } from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("MainRendererDiagnosticsReason", () => {
  const decode = Schema.decodeUnknownSync(MainRendererDiagnosticsReason);

  it.each([
    "Select a Codex provider signed in with ChatGPT to use Live voice.",
    "Sign in to this Codex installation with ChatGPT to use Live voice.",
    "Select a managed Codex provider to use Live voice.",
    "This Codex provider uses an existing installation. Live voice requires managed setup.",
  ])("accepts current and older renderer qualification reasons: %s", (reason) => {
    expect(decode(reason)).toBe(reason);
  });

  it("rejects arbitrary provider or credential details", () => {
    expect(() => decode("private provider diagnostic")).toThrow();
  });
});
