import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
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
    const unary = registered(WS_METHODS.agentObservatoryReadNativeRoster);
    if (unary._tag !== WS_METHODS.agentObservatoryReadNativeRoster)
      throw new Error("Unexpected observatory roster registration");
    const rosterStream = registered(WS_METHODS.agentObservatorySubscribeNativeRoster);
    if (rosterStream._tag !== WS_METHODS.agentObservatorySubscribeNativeRoster)
      throw new Error("Unexpected observatory roster subscription registration");
    const overviewStream = registered(WS_METHODS.agentObservatorySubscribe);
    if (overviewStream._tag !== WS_METHODS.agentObservatorySubscribe)
      throw new Error("Unexpected observatory subscription registration");
    for (const codec of [
      Schema.toCodecJson(unary.successSchema),
      Schema.toCodecJson(rosterStream.successSchema.success),
    ]) {
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
    }
    for (const errorCodec of [
      Schema.toCodecJson(unary.errorSchema),
      Schema.toCodecJson(rosterStream.successSchema.error),
      Schema.toCodecJson(overviewStream.successSchema.error),
    ]) {
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
    const codec = Schema.toCodecJson(overviewStream.successSchema.success);
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

describe("native preparation registered JSON codecs", () => {
  it("keeps the exact selected expectation optional, bounded and private-extra free", () => {
    const rpc = WsRpcGroup.requests.get(WS_METHODS.liveVoicePrepare);
    if (rpc?._tag !== WS_METHODS.liveVoicePrepare) throw new Error("Missing native prepare RPC");
    const codec = Schema.toCodecJson(rpc.payloadSchema);
    const decode = Schema.decodeUnknownSync(codec);
    const legacy = { threadId: "native-thread", clientRequestId: "native-request" };
    const nativePreparation = {
      providerInstanceId: "codex-personal",
      configurationId: "factory-1",
    };
    expect(Schema.encodeSync(codec)(decode(legacy))).toEqual(legacy);
    expect(
      Schema.encodeSync(codec)(
        decode({
          ...legacy,
          nativePreparation: {
            ...nativePreparation,
            token: "synthetic-private",
            accountId: "private",
          },
        }),
      ),
    ).toEqual({ ...legacy, nativePreparation });
    for (const configurationId of ["", "x".repeat(129)]) {
      expect(
        Exit.isFailure(
          Schema.decodeUnknownExit(codec)({
            ...legacy,
            nativePreparation: { ...nativePreparation, configurationId },
          }),
        ),
      ).toBe(true);
    }
  });

  it("carries native provenance through all four registered config response codecs", () => {
    const get = WsRpcGroup.requests.get(WS_METHODS.serverGetConfig);
    if (get?._tag !== WS_METHODS.serverGetConfig) throw new Error("Missing config RPC");
    const refresh = WsRpcGroup.requests.get(WS_METHODS.serverRefreshProviders);
    if (refresh?._tag !== WS_METHODS.serverRefreshProviders) throw new Error("Missing refresh RPC");
    const update = WsRpcGroup.requests.get(WS_METHODS.serverUpdateProvider);
    if (update?._tag !== WS_METHODS.serverUpdateProvider) throw new Error("Missing update RPC");
    const stream = WsRpcGroup.requests.get(WS_METHODS.subscribeServerConfig);
    if (stream?._tag !== WS_METHODS.subscribeServerConfig) throw new Error("Missing config stream");
    const native = {
      configurationId: "factory-1",
      setupMode: "existing",
      accountSource: "native-account-read",
      transport: "codex-webrtc-v3",
    };
    for (const provenance of [undefined, native]) {
      const provider = {
        instanceId: "codex-personal",
        driver: "codex",
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated", type: "chatgpt" },
        checkedAt: "2026-10-16T00:00:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
        ...(provenance === undefined
          ? {}
          : {
              nativeLiveVoicePreparation: { ...provenance, token: "synthetic-private" },
            }),
      };
      const config = {
        environment: {
          environmentId: "native-env",
          label: "Synthetic",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "synthetic",
          capabilities: {},
        },
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: [],
          sessionMethods: [],
          sessionCookieName: "synthetic",
        },
        cwd: "/synthetic",
        keybindingsConfigPath: "/synthetic/keybindings",
        keybindings: [],
        issues: [],
        providers: [provider],
        availableEditors: [],
        settings: {},
        observability: {
          logsDirectoryPath: "/synthetic/logs",
          localTracingEnabled: false,
          otlpTracesEnabled: false,
          otlpMetricsEnabled: false,
        },
      };
      const getCodec = Schema.toCodecJson(get.successSchema);
      const refreshCodec = Schema.toCodecJson(refresh.successSchema);
      const updateCodec = Schema.toCodecJson(update.successSchema);
      const decodedGet = Schema.decodeUnknownSync(getCodec)(config);
      const decodedRefresh = Schema.decodeUnknownSync(refreshCodec)({ providers: [provider] });
      const decodedUpdate = Schema.decodeUnknownSync(updateCodec)({ providers: [provider] });
      for (const result of [decodedGet, decodedRefresh, decodedUpdate]) {
        expect(result.providers).toHaveLength(1);
        expect(result.providers[0]?.nativeLiveVoicePreparation).toEqual(provenance);
      }
      for (const encoded of [
        Schema.encodeSync(getCodec)(decodedGet),
        Schema.encodeSync(refreshCodec)(decodedRefresh),
        Schema.encodeSync(updateCodec)(decodedUpdate),
      ]) {
        expect(encoded.providers).toHaveLength(1);
        expect(encoded.providers[0]?.nativeLiveVoicePreparation).toEqual(provenance);
      }
      const streamCodec = Schema.toCodecJson(stream.successSchema.success);
      const event = Schema.decodeUnknownSync(streamCodec)({
        version: 1,
        type: "providerStatuses",
        payload: { providers: [provider] },
      });
      if (event.type !== "providerStatuses") throw new Error("Wrong config event");
      expect(event.payload.providers[0]?.nativeLiveVoicePreparation).toEqual(provenance);
      expect(Schema.encodeSync(streamCodec)(event)).toEqual({
        version: 1,
        type: "providerStatuses",
        payload: {
          providers: Schema.encodeSync(refreshCodec)(
            Schema.decodeUnknownSync(refreshCodec)({ providers: [provider] }),
          ).providers,
        },
      });
    }
  });
});
