import { describe, it, expect } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DesktopBackendUpdateBinding,
  DesktopBackendUpdateRequest,
  DesktopBackendUpdateResponse,
  DesktopHostTelemetryMessage,
  DesktopTelemetryControlMessage,
} from "./resourceTelemetry.ts";
const context = {
  environmentId: "env",
  bootId: "boot",
  requestId: "update",
  targetVersion: "25",
  admissionGeneration: 1,
  expiresAt: 20000,
};
describe("owned backend update FD", () => {
  it("roundtrips every request/ack through existing directional envelopes", () => {
    for (const type of [
      "prepareBackendUpdate",
      "abortBackendUpdate",
      "commitBackendUpdate",
    ] as const) {
      const message = { version: 1, type, context };
      expect(Schema.decodeUnknownSync(DesktopHostTelemetryMessage)(message)).toEqual(message);
    }
    for (const type of [
      "backendUpdatePrepared",
      "backendUpdateCommitted",
      "backendUpdateAborted",
      "backendUpdateRefused",
      "backendUpdateRevoked",
    ] as const) {
      const message = { version: 1, type, context, persistedRunIds: ["run"], reason: "ready" };
      expect(Schema.decodeUnknownSync(DesktopTelemetryControlMessage)(message)).toEqual(message);
    }
    expect(
      Schema.decodeUnknownSync(DesktopBackendUpdateResponse)({
        version: 1,
        type: "backendUpdateHello",
        environmentId: "env",
        bootId: "boot",
      }),
    ).toMatchObject({ bootId: "boot" });
  });
  it("rejects missing incarnation, extra authority/secret fields, unbounded proof and invalid generation", () => {
    const decode = Schema.decodeUnknownSync(DesktopBackendUpdateRequest);
    for (const field of ["bootId", "requestId", "environmentId", "expiresAt"]) {
      const c = { ...context };
      Reflect.deleteProperty(c, field);
      expect(() => decode({ version: 1, type: "prepareBackendUpdate", context: c })).toThrow();
    }
    for (const field of ["token", "provider", "credentials", "force"]) {
      expect(() =>
        decode({
          version: 1,
          type: "prepareBackendUpdate",
          context: { ...context, [field]: "forbidden" },
        }),
      ).toThrow();
      expect(() =>
        decode({ version: 1, type: "prepareBackendUpdate", context, [field]: true }),
      ).toThrow();
    }
    for (const admissionGeneration of [-1, NaN, Infinity, 1.5])
      expect(() =>
        Schema.decodeUnknownSync(DesktopBackendUpdateBinding)({ ...context, admissionGeneration }),
      ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(DesktopBackendUpdateResponse)({
        version: 1,
        type: "backendUpdatePrepared",
        context,
        persistedRunIds: Array.from({ length: 129 }, () => "run"),
        reason: "ready",
      }),
    ).toThrow();
  });
});
