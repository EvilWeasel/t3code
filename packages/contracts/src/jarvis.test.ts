import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  JarvisCapabilityJobRequest,
  JarvisCapabilityObserveRequest,
  JarvisSubmitCapability,
  JarvisNativeRequest,
  JarvisNativeResponse,
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

// Canonical serde_json transport golden from signed candidate 72e964b9cc.
// SHA-256 d1ff85bcd48e321aeee930a1955c6ac81b9af339905f31ce9ba5b4074ca3fbd0.
const observeRpcGolden =
  '{"jsonrpc":"2.0","id":"rpc-1","method":"jarvis.observe","params":{"binding":{"engineSessionId":"engine-1","origin":{"environmentId":"environment-1","projectId":"project-1","parentThreadId":"parent-1","parentRunId":"run-1","parentRootNodeId":"root-1","taskId":"task-1","childThreadId":"child-1","childRunId":"child-run-1","childRootNodeId":"child-root-1"}},"query":{"engineSessionId":"engine-1"}}}';

describe("canonical Jarvis native transport", () => {
  it("round-trips Rust JSON-RPC bytes with the actual separate child root binding", () => {
    const codec = Schema.fromJsonString(JarvisNativeRequest);
    const request = Schema.decodeUnknownSync(codec)(observeRpcGolden);
    expect(Schema.encodeSync(codec)(request)).toBe(observeRpcGolden);
    expect(request.params.binding.origin.childRootNodeId).toBe("child-root-1");
    expect(request.params.binding.origin.childRootNodeId).not.toBe(
      request.params.binding.origin.taskId,
    );
  });
  it("rejects caller-chosen methods, numeric IDs and missing actual child roots", () => {
    const decode = Schema.decodeUnknownSync(JarvisNativeRequest);
    const request = Schema.decodeUnknownSync(Schema.fromJsonString(JarvisNativeRequest))(
      observeRpcGolden,
    );
    expect(() => decode({ ...request, method: "jarvis.launch_shell" })).toThrow();
    expect(() => decode({ ...request, id: 1 })).toThrow();
    const { childRootNodeId: _childRoot, ...origin } = request.params.binding.origin;
    expect(() =>
      decode({
        ...request,
        params: { ...request.params, binding: { ...request.params.binding, origin } },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(JarvisNativeResponse)({ jsonrpc: "2.0", id: 1, result: {} }),
    ).toThrow();
  });
});
