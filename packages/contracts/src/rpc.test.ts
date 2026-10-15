import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as RpcSchema from "effect/rpc/RpcSchema";
import { AgentObservatoryNativeRosterPage } from "./agentObservatory.ts";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import {
  WsRpcGroup,
  WsSubscribeServerConfigRpc,
  WS_METHODS,
  AgentObservatoryReadError,
} from "./rpc.ts";

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

describe("registered observatory read JSON codecs", () => {
  const methods = [
    WS_METHODS.agentObservatorySubscribe,
    WS_METHODS.agentObservatoryReadNativeRoster,
    WS_METHODS.agentObservatorySubscribeNativeRoster,
  ] as const;
  const registered = (method: (typeof methods)[number]) => {
    const rpc = WsRpcGroup.requests.get(method);
    if (!rpc) throw new Error("Observatory read RPC missing");
    return rpc;
  };
  const roster = { threadIds: ["thread:b", "thread:a"], limit: 200 };
  const cursor = {
    environmentId: "destination",
    threadIds: ["thread:a", "thread:b"],
    throughSequence: 8,
    afterId: "child:a",
  };

  it("retains explicit selectors and the unary cursor through registered JSON payload codecs", () => {
    for (const method of methods) {
      const codec = Schema.toCodecJson(registered(method).payloadSchema);
      const input =
        method === WS_METHODS.agentObservatorySubscribe
          ? { threadId: "thread:a" }
          : method === WS_METHODS.agentObservatoryReadNativeRoster
            ? { ...roster, cursor }
            : roster;
      expect(Schema.encodeSync(codec)(Schema.decodeUnknownSync(codec)(input))).toEqual(input);
    }
    expect(
      [...WsRpcGroup.requests.keys()].filter((tag) => tag.startsWith("agentObservatory.")),
    ).toEqual(methods);
  });

  it("strictly rejects destination/owner/write extras and a cursor on the first-page subscription", () => {
    for (const method of methods) {
      const decode = Schema.decodeUnknownExit(Schema.toCodecJson(registered(method).payloadSchema));
      const input =
        method === WS_METHODS.agentObservatorySubscribe ? { threadId: "thread:a" } : roster;
      for (const extra of [
        { environmentId: "spoof" },
        { owner: {} },
        { publish: true },
        { authorized: true },
      ])
        expect(Exit.isFailure(decode({ ...input, ...extra }))).toBe(true);
    }
    const decode = Schema.decodeUnknownExit(
      Schema.toCodecJson(
        registered(WS_METHODS.agentObservatorySubscribeNativeRoster).payloadSchema,
      ),
    );
    expect(Exit.isFailure(decode({ ...roster, cursor }))).toBe(true);
  });

  it("enforces unique bounded thread selectors and integer limits on both roster registrations", () => {
    for (const method of [
      WS_METHODS.agentObservatoryReadNativeRoster,
      WS_METHODS.agentObservatorySubscribeNativeRoster,
    ] as const) {
      const decode = Schema.decodeUnknownExit(Schema.toCodecJson(registered(method).payloadSchema));
      for (const limit of [0, -1, 201, 1.5])
        expect(Exit.isFailure(decode({ ...roster, limit }))).toBe(true);
      for (const limit of [1, 200]) expect(Exit.isSuccess(decode({ ...roster, limit }))).toBe(true);
      expect(Exit.isFailure(decode({ ...roster, threadIds: ["same", "same"] }))).toBe(true);
      expect(
        Exit.isFailure(
          decode({ ...roster, threadIds: Array.from({ length: 129 }, (_, n) => `thread:${n}`) }),
        ),
      ).toBe(true);
      expect(Exit.isSuccess(decode({ threadIds: [], limit: 1 }))).toBe(true);
    }
  });

  it("roundtrips roster UTC timestamps and the fixed refusal through actual unary and stream element codecs", () => {
    const encoded = {
      environmentId: "destination",
      threadIds: ["thread:a"],
      throughSequence: 9,
      source: "canonical-subagent-index",
      coverage: "recorded-current-only",
      status: "complete",
      agents: [
        {
          id: "child:a",
          threadId: "thread:a",
          runId: "run:a",
          parentNodeId: "root:a",
          origin: "provider_native",
          driver: "codex",
          providerInstanceId: "codex",
          providerThreadId: "native:a",
          childThreadId: null,
          status: "running",
          title: "Bounded title",
          titleTruncated: false,
          updatedAt: "2026-10-16T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    };
    for (const method of [
      WS_METHODS.agentObservatoryReadNativeRoster,
      WS_METHODS.agentObservatorySubscribeNativeRoster,
    ] as const) {
      const rpc = registered(method);
      const stream = RpcSchema.getStreamSchemas(rpc.successSchema);
      const codec = Schema.toCodecJson(
        Option.isSome(stream) ? stream.value.success : rpc.successSchema,
      );
      const decoded = Schema.decodeUnknownSync(codec)(encoded);
      const typed = Schema.decodeUnknownSync(AgentObservatoryNativeRosterPage)(decoded);
      expect(DateTime.formatIso(typed.agents[0]!.updatedAt)).toBe(encoded.agents[0]!.updatedAt);
      expect(Schema.encodeSync(codec)(decoded)).toEqual(encoded);
      const withPrivateExtras = {
        ...encoded,
        agents: [
          {
            ...encoded.agents[0]!,
            prompt: "synthetic-private-prompt",
            result: "synthetic-private-result",
            progress: "synthetic-private-progress",
          },
        ],
      };
      expect(Schema.encodeSync(codec)(Schema.decodeUnknownSync(codec)(withPrivateExtras))).toEqual(
        encoded,
      );
      const errorCodec = Schema.toCodecJson(
        Option.isSome(stream) ? stream.value.error : rpc.errorSchema,
      );
      const refusal = new AgentObservatoryReadError({
        message: "Agent observatory data is unavailable.",
      });
      expect(Schema.encodeSync(errorCodec)(refusal)).toEqual({
        _tag: "AgentObservatoryReadError",
        message: "Agent observatory data is unavailable.",
      });
      expect(
        Exit.isFailure(
          Schema.decodeUnknownExit(errorCodec)({
            _tag: "AgentObservatoryReadError",
            message: "private cause",
          }),
        ),
      ).toBe(true);
    }
    const rpc = registered(WS_METHODS.agentObservatorySubscribe);
    const stream = Option.getOrThrow(RpcSchema.getStreamSchemas(rpc.successSchema));
    const codec = Schema.toCodecJson(stream.success);
    const offline = {
      environmentId: "destination",
      threadId: "thread:a",
      status: "offline",
      throughSequence: 0,
      snapshot: null,
    };
    expect(Schema.encodeSync(codec)(Schema.decodeUnknownSync(codec)(offline))).toEqual(offline);
  });
});
