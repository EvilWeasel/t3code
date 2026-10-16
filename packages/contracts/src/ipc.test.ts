import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { DesktopEnvironmentBootstrapSchema, MainRendererDiagnosticsReadResult } from "./ipc.ts";

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

describe("closed unsupported diagnostics", () => {
  const decode = Schema.decodeUnknownOption(MainRendererDiagnosticsReadResult);
  const unsupported = { status: "unavailable", reason: "unsupported" };
  it("preserves old-peer absence and accepts internal site-only or complete WS provenance", () => {
    expect(Option.getOrThrow(decode(unsupported))).toEqual(unsupported);
    for (const unsupportedDiagnostic of [
      { site: "main-metadata" },
      { site: "local-capability", route: "local", handlerAvailable: true },
      { site: "ws-fd-method-missing", route: "fd", handlerAvailable: false },
    ]) {
      expect(Option.getOrThrow(decode({ ...unsupported, unsupportedDiagnostic }))).toEqual({
        ...unsupported,
        unsupportedDiagnostic,
      });
    }
  });
  it.each([
    { site: "unknown-site" },
    { site: "main-metadata", message: "forbidden text" },
    { site: "main-metadata", route: "local" },
    { site: "main-metadata", handlerAvailable: true },
    { site: "main-metadata", route: "remote", handlerAvailable: true },
    { site: "main-metadata", route: "fd", handlerAvailable: true, nonce: "forbidden" },
  ])("rejects unbounded or half-provenance metadata %#", (unsupportedDiagnostic) => {
    expect(Option.isNone(decode({ ...unsupported, unsupportedDiagnostic }))).toBe(true);
  });
  it.each([
    "off",
    "busy",
    "target-mismatch",
    "expired",
    "clock-anomaly",
    "timeout",
    "not-main",
    "context-changed",
    "source-closed",
    "invalid-response",
  ])("does not accept attribution on %s", (reason) => {
    expect(Option.isSome(decode({ status: "unavailable", reason }))).toBe(true);
    expect(
      Option.isNone(
        decode({ status: "unavailable", reason, unsupportedDiagnostic: { site: "main-metadata" } }),
      ),
    ).toBe(true);
  });
});

it("ready diagnostics reject unsupported attribution without changing the ready shape", () => {
  const target = {
    environmentId: "24efa85c-862c-4de4-9b5e-aaaa041e28a4",
    threadId: "7cd05d6b-5e09-4691-a664-0b56c6283f12",
    providerInstanceId: "codex",
  };
  const ready = {
    status: "ready",
    appVersion: "test",
    observedAtMs: 1,
    expiresAtMs: 2,
    response: {
      binding: {
        version: 1,
        requestSequence: 1,
        requestId: "request",
        requestNonce: "nonce",
        target,
        mainSession: "session",
        windowId: 1,
        frameProcessId: 1,
        frameRoutingId: 1,
        navigationGeneration: 1,
        expiresAtMs: 2,
      },
      rendererEpoch: 1,
      revision: 1,
      result: {
        status: "ready",
        gate: {
          ...target,
          phase: "idle",
          targetPresent: true,
          active: false,
          busy: false,
          webRtcAvailable: true,
          microphoneApiAvailable: true,
          canStart: false,
          reason: null,
          facts: null,
          prepareFailure: null,
        },
      },
    },
  };
  const decode = Schema.decodeUnknownOption(MainRendererDiagnosticsReadResult);
  expect(Option.getOrThrow(decode(ready))).toEqual(ready);
  expect(
    Option.isNone(decode({ ...ready, unsupportedDiagnostic: { site: "main-metadata" } })),
  ).toBe(true);
});
