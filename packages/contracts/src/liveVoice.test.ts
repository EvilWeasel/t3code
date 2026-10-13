import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  LiveVoiceGeneration,
  LiveVoiceSession,
  LiveVoicePrepareInput,
  LiveVoiceStartInput,
  LiveVoiceSubscribeInput,
} from "./liveVoice.ts";
import { WS_METHODS } from "./rpc.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { AuthOrchestrationOperateScope } from "./auth.ts";

describe("subscription Codex Live contracts", () => {
  it("bounds offer size and requires a positive lease generation", () => {
    expect(
      Schema.decodeUnknownSync(LiveVoiceStartInput)({
        leaseId: "lease-1",
        generation: 1,
        offerSdp: "v=0",
        clientRequestId: "request-1",
      }).generation,
    ).toBe(1);
    expect(() =>
      Schema.decodeUnknownSync(LiveVoiceStartInput)({
        leaseId: "lease-1",
        generation: 0,
        offerSdp: "v=0",
        clientRequestId: "request-1",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(LiveVoiceGeneration)(Number.MAX_SAFE_INTEGER + 1),
    ).toThrow();
  });

  it("represents preparation and recovery without fabricated provider identities", () => {
    expect(
      Schema.decodeUnknownSync(LiveVoiceSession)({
        leaseId: "lease-1",
        generation: 1,
        environmentId: "env-1",
        threadId: "thread-1",
        providerInstanceId: "codex-default",
        providerSessionId: null,
        plannerNativeThreadId: null,
        status: "preparing",
      }).plannerNativeThreadId,
    ).toBeNull();
  });

  it("keeps client signaling free of provider credentials and arbitrary targets", () => {
    const input = Schema.decodeUnknownSync(LiveVoicePrepareInput)({
      threadId: "thread-1",
      clientRequestId: "request-1",
    });
    expect(input.threadId).toBe("thread-1");
    expect(
      Schema.decodeUnknownSync(LiveVoicePrepareInput)({
        threadId: "thread-1",
        clientRequestId: "request-1",
        provider: "claude",
        token: "secret",
      }),
    ).toEqual(input);
    expect(clientRpcRequiredScopes(WS_METHODS.liveVoicePrepare, input)).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.liveVoiceStart, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.liveVoiceStop, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.liveVoiceStatus, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(clientRpcRequiredScopes(WS_METHODS.liveVoiceSubscribe, {})).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(
      Schema.decodeUnknownSync(LiveVoiceSubscribeInput)({ leaseId: "lease-1", generation: 1 })
        .generation,
    ).toBe(1);
  });
});
