import { describe, expect, it } from "vite-plus/test";
import { AuthOrchestrationReadScope, AuthSettingsWriteScope } from "./auth.ts";
import { CLIENT_GUARDED_RPC_SCOPES, clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

describe("observatory read destination permissions", () => {
  it("uses the exact read grant for all selected destinations without introducing publish authority", () => {
    for (const method of [
      WS_METHODS.agentObservatorySubscribe,
      WS_METHODS.agentObservatoryReadNativeRoster,
      WS_METHODS.agentObservatorySubscribeNativeRoster,
    ]) {
      expect(CLIENT_GUARDED_RPC_SCOPES[method]).toBe(AuthOrchestrationReadScope);
      for (const threadId of ["thread:a", "thread:b"])
        expect(
          clientRpcRequiredScopes(method, { threadId, threadIds: [threadId], limit: 1 }),
        ).toEqual([AuthOrchestrationReadScope]);
    }
    expect(
      Object.values(WS_METHODS).some(
        (method) => method.startsWith("agentObservatory.") && /publish|update|write/.test(method),
      ),
    ).toBe(false);
  });
});

describe("baseline guarded RPC compatibility", () => {
  it("retains the existing settings-write gate independently of observatory read access", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.serverRunStorageCleanup, {})).toEqual([
      AuthSettingsWriteScope,
    ]);
    expect(CLIENT_GUARDED_RPC_SCOPES[WS_METHODS.serverRunStorageCleanup]).toBe(
      AuthSettingsWriteScope,
    );
  });
});
