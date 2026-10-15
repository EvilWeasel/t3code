import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WsRpcGroup, WsSubscribeServerConfigRpc } from "./rpc.ts";

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const oldServerPayload = Schema.Struct({});
    const decoded = Schema.decodeExit(oldServerPayload)({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = Schema.decodeSync(WsSubscribeServerConfigRpc.payloadSchema)({
      environmentThemes: true,
    });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = Schema.decodeSync(WsSubscribeServerConfigRpc.payloadSchema)({});
    expect(decoded).toEqual({});
  });
});

describe("WebSocket RPC contracts", () => {
  it("exposes only the V2 orchestration transport surface", () => {
    const methods = [...WsRpcGroup.requests.keys()];

    expect(methods).toEqual(expect.arrayContaining(Object.values(ORCHESTRATION_V2_WS_METHODS)));
    expect(methods.filter((method) => method.startsWith("orchestrationV1."))).toEqual([]);
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });
});

describe("registered trace diagnostics serialization boundary", () => {
  const rpc = WsRpcGroup.requests.get("server.getTraceDiagnostics");
  if (rpc === undefined) throw new Error("trace diagnostics RPC is not registered");
  const codec = Schema.toCodecJson(rpc.payloadSchema);
  const decode = Schema.decodeUnknownExit(codec);
  const input = {
    mainRendererSnapshot: {
      requestId: "read",
      requestNonce: "nonce",
      optIn: true,
      expiresAtMs: 5_000,
      target: {
        environmentId: "24efa85c-862c-4de4-9b5e-aaaa041e28a4",
        threadId: "7cd05d6b-5e09-4691-a664-0b56c6283f12",
        providerInstanceId: "codex",
      },
    },
  } as const;
  it("preserves default trace and the typed explicit selector through the actual JSON codec", () => {
    expect(Schema.decodeUnknownSync(codec)({})).toEqual({});
    const decoded = Schema.decodeUnknownSync(codec)(input);
    expect(decoded).toEqual(input);
    expect(Schema.encodeSync(codec)(decoded)).toEqual(input);
  });
  it("rejects raw extras before destination struct stripping", () => {
    expect(Exit.isFailure(decode({ rawSettings: "refused" }))).toBe(true);
    expect(Exit.isFailure(decode({ ...input, rawSettings: "refused" }))).toBe(true);
    expect(
      Exit.isFailure(
        decode({ mainRendererSnapshot: { ...input.mainRendererSnapshot, rawSettings: "refused" } }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decode({
          mainRendererSnapshot: {
            ...input.mainRendererSnapshot,
            target: { ...input.mainRendererSnapshot.target, rawSettings: "refused" },
          },
        }),
      ),
    ).toBe(true);
  });
  it("leaves another registered RPC's legacy decoding unchanged", () => {
    const legacy = Schema.toCodecJson(WsSubscribeServerConfigRpc.payloadSchema);
    expect(
      Schema.decodeUnknownSync(legacy)({ environmentThemes: true, legacyExtra: "ignored" }),
    ).toEqual({ environmentThemes: true });
  });
});
