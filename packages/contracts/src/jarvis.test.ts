import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  JarvisCapabilityJobRequest,
  JarvisCapabilityObserveRequest,
  JarvisSubmitCapability,
} from "./jarvis.ts";

// Byte-identical Rust serde_json golden from signed checkpoint 18bb46c813.
// SHA-256 b1564548784fa4473c2e75d80dfc53e4af60837327dda9ca853ef01922d397ee.
const submitGolden =
  '{"schema":"jarvis.v1","kind":"submit_capability","requestId":"bridge-request-1","conversationId":"conversation-1","clientMessageId":"message-1","invocation":{"engineSessionId":"engine-1","capabilityId":"browser.fill","operationId":"fill","registrationRevision":"browser-1","arguments":{"text":"bounded example"},"target":{"targetId":"field-1","targetKind":"browser_input","surfaceId":"owned-tab-1","generation":"1","observedContextId":"context-1","observedObservationId":"observation-1"}}}';

describe("canonical Jarvis data boundary", () => {
  it("round-trips the canonical Rust submit bytes without replacing retained target identity", () => {
    const codec = Schema.fromJsonString(JarvisSubmitCapability);
    const request = Schema.decodeUnknownSync(codec)(submitGolden);
    expect(Schema.encodeSync(codec)(request)).toBe(submitGolden);
    expect(request.invocation.target.observedObservationId).toBe("observation-1");
    expect(request.invocation.registrationRevision).toBe("browser-1");
  });

  it("permits only engine and optional cursor for initial observation", () => {
    const decode = Schema.decodeUnknownSync(JarvisCapabilityObserveRequest);
    expect(decode({ engineSessionId: "engine-1" })).toEqual({ engineSessionId: "engine-1" });
    expect(decode({ engineSessionId: "engine-1", cursor: "retained-cursor" }).cursor).toBe(
      "retained-cursor",
    );
    for (const field of ["tabId", "endpoint", "target", "windowId"]) {
      expect(() => decode({ engineSessionId: "engine-1", [field]: "model-controlled" })).toThrow();
    }
  });

  it("rejects omitted observation identity and unknown invocation authority fields", () => {
    const submit = Schema.decodeUnknownSync(Schema.fromJsonString(JarvisSubmitCapability))(
      submitGolden,
    );
    const decode = Schema.decodeUnknownSync(JarvisCapabilityJobRequest);
    const { observedContextId: _context, ...unbound } = submit.invocation.target;
    expect(() => decode({ ...submit.invocation, target: unbound })).toThrow();
    expect(() => decode({ ...submit.invocation, endpoint: "http://untrusted" })).toThrow();
    expect(() =>
      decode({
        ...submit.invocation,
        target: { ...submit.invocation.target, windowId: "untrusted" },
      }),
    ).toThrow();
  });
});
