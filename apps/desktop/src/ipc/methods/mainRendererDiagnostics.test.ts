import { describe, it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Events from "node:events";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  DesktopHostTelemetryHello,
  PositiveInt,
  MainRendererDiagnosticsRequest,
  MainRendererDiagnosticsResponse,
  type MainRendererDiagnosticsReadInput,
  type MainRendererDiagnosticsRequest as Request,
  type MainRendererDiagnosticsResponse as Response,
} from "@t3tools/contracts";
import type * as Electron from "electron";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import {
  make,
  MainRendererDiagnostics,
  respond as respondMethod,
  invalidate as invalidateMethod,
} from "./mainRendererDiagnostics.ts";

const target = {
  environmentId: "24efa85c-862c-4de4-9b5e-aaaa041e28a4",
  threadId: "7cd05d6b-5e09-4691-a664-0b56c6283f12",
  providerInstanceId: "codex",
} as const;
const sender = { sender: { id: 70 }, senderFrame: { processId: 11, routingId: 12, parent: null } };
function response(binding: Request): Response {
  return {
    binding,
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
        reason: "Waiting for this environment's provider settings.",
        facts: null,
        prepareFailure: null,
      },
    },
  };
}
const fixture = Effect.gen(function* () {
  const requests = yield* Queue.unbounded<Request>();
  const events = new Events.EventEmitter();
  const wc = Object.assign(events, {
    id: 70,
    isDestroyed: () => false,
    mainFrame: { processId: 11, routingId: 12 },
    send: (_channel: string, input: Request) => {
      Queue.offerUnsafe(requests, input);
    },
  });
  // Only the native Electron boundary is replaced; request/nonce/cache logic is actual service.
  const window = {
    id: 7,
    webContents: wc,
    isDestroyed: () => false,
  } as unknown as Electron.BrowserWindow;
  const current = yield* Ref.make(Option.some(window));
  let beforeMetadata: Effect.Effect<void> = Effect.void;
  let beforeMain: Effect.Effect<void> = Effect.void;
  const service = yield* make().pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ElectronWindow.ElectronWindow)({
          main: Effect.suspend(() => beforeMain).pipe(Effect.andThen(Ref.get(current))),
        }),
        Layer.mock(ElectronApp.ElectronApp)({
          metadata: Effect.suspend(() => beforeMetadata).pipe(
            Effect.as({
              appVersion: "0.0.47-nightly.20261015.28",
              appPath: "/fixture",
              isPackaged: true,
              resourcesPath: "/fixture",
              runningUnderArm64Translation: false,
            }),
          ),
        }),
      ),
    ),
  );
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const input: MainRendererDiagnosticsReadInput = {
    requestId: "read-1",
    requestNonce: "caller-1",
    target,
    optIn: true,
    expiresAtMs: now + 5_000,
  };
  return {
    service,
    requests,
    wc,
    current,
    input,
    setMetadataWait: (effect: Effect.Effect<void>) => {
      beforeMetadata = Effect.suspend(() => {
        beforeMetadata = Effect.void;
        return effect;
      });
    },
    setMainWait: (effect: Effect.Effect<void>) => {
      beforeMain = Effect.suspend(() => {
        beforeMain = Effect.void;
        return effect;
      });
    },
  };
});

describe("passive main renderer diagnostics", () => {
  it.effect(
    "attests actual Main/frame and version, refuses subframe/wrong sender, replay and concurrent request",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const read = yield* f.service
          .read("attempt-A", () => true, f.input)
          .pipe(Effect.forkScoped);
        const request = yield* Queue.take(f.requests);
        assert.equal(request.windowId, 7);
        assert.equal(request.requestSequence, 1);
        assert.notEqual(request.requestNonce, f.input.requestNonce);
        assert.deepEqual(yield* f.service.read("attempt-B", () => true, f.input), {
          status: "unavailable",
          reason: "busy",
        });
        assert.equal(
          yield* f.service.respond(response(request), { ...sender, sender: { id: 71 } }),
          false,
        );
        assert.equal(
          yield* f.service.respond(response(request), {
            ...sender,
            senderFrame: { ...sender.senderFrame, parent: {} },
          }),
          false,
        );
        assert.equal(yield* f.service.respond(response(request), sender), true);
        assert.equal(yield* f.service.respond(response(request), sender), false);
        const result = yield* Fiber.join(read);
        assert.equal(result.status, "ready");
        if (result.status === "ready")
          assert.equal(result.appVersion, "0.0.47-nightly.20261015.28");
      }).pipe(Effect.scoped),
  );

  it.effect("old reply and invalidation cannot disturb a newer issued sequence", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const a = yield* f.service.read("A", () => true, f.input).pipe(Effect.forkScoped);
      const ar = yield* Queue.take(f.requests);
      yield* f.service.cancelSource("A");
      assert.equal((yield* Fiber.join(a)).status, "unavailable");
      const b = yield* f.service
        .read("B", () => true, { ...f.input, requestId: "read-2" })
        .pipe(Effect.forkScoped);
      const br = yield* Queue.take(f.requests);
      assert.equal(br.mainSession, ar.mainSession);
      assert.equal(br.requestSequence, ar.requestSequence + 1);
      assert.equal(yield* f.service.respond(response(ar), sender), false);
      assert.equal(
        yield* f.service.invalidate({ binding: ar, rendererEpoch: 1, revision: 1 }, sender),
        false,
      );
      assert.equal(yield* f.service.respond(response(br), sender), true);
      assert.equal((yield* Fiber.join(b)).status, "ready");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "retains navigation generation between requests without resetting session sequence",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.service.read("A", () => true, f.input).pipe(Effect.forkScoped);
        const a = yield* Queue.take(f.requests);
        yield* f.service.respond(response(a), sender);
        assert.equal((yield* Fiber.join(first)).status, "ready");
        f.wc.emit("did-start-navigation", {}, "", false, true);
        const second = yield* f.service.read("A", () => true, f.input).pipe(Effect.forkScoped);
        const b = yield* Queue.take(f.requests);
        assert.equal(b.mainSession, a.mainSession);
        assert.equal(b.requestSequence, a.requestSequence + 1);
        assert.equal(b.navigationGeneration, a.navigationGeneration + 1);
        const mismatched = response(b);
        if (mismatched.result.status !== "ready")
          return assert.fail("Expected owned ready fixture");
        assert.equal(
          yield* f.service.respond(
            {
              ...mismatched,
              result: {
                status: "ready",
                gate: { ...mismatched.result.gate, providerInstanceId: null },
              },
            },
            sender,
          ),
          false,
        );
        assert.equal((yield* Fiber.join(second)).status, "unavailable");
      }).pipe(Effect.scoped),
  );

  for (const oldOperation of ["respond", "invalidate"] as const) {
    it.effect(`delayed old ${oldOperation} cannot invalidate the replacement pending request`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* f.service.read("A", () => true, f.input).pipe(Effect.forkScoped);
        const a = yield* Queue.take(f.requests);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const pause = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        if (oldOperation === "respond") f.setMetadataWait(pause);
        else f.setMainWait(pause);
        const old = yield* (
          oldOperation === "respond"
            ? f.service.respond(response(a), sender)
            : f.service.invalidate({ binding: a, rendererEpoch: 1, revision: 1 }, sender)
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("2 seconds");
        assert.equal((yield* Fiber.join(first)).status, "unavailable");
        f.setMetadataWait(Effect.void);
        f.setMainWait(Effect.void);
        const second = yield* f.service
          .read("B", () => true, { ...f.input, requestId: "replacement" })
          .pipe(Effect.forkScoped);
        const b = yield* Queue.take(f.requests);
        yield* Deferred.succeed(release, undefined);
        assert.equal(yield* Fiber.join(old), false);
        assert.equal(yield* f.service.respond(response(b), sender), true);
        assert.equal((yield* Fiber.join(second)).status, "ready");
      }).pipe(Effect.scoped),
    );
  }

  for (const boundary of [
    "navigation",
    "crash",
    "source-close",
    "replacement",
    "expiry",
  ] as const) {
    it.effect(`refuses a reply after ${boundary}`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let alive = true;
        const read = yield* f.service.read("A", () => alive, f.input).pipe(Effect.forkScoped);
        const request = yield* Queue.take(f.requests);
        if (boundary === "navigation") f.wc.emit("did-start-navigation", {}, "", false, true);
        if (boundary === "crash") f.wc.emit("render-process-gone");
        if (boundary === "source-close") {
          alive = false;
          yield* f.service.cancelSource("A");
        }
        if (boundary === "replacement") {
          yield* Ref.set(f.current, Option.none());
          yield* f.service.cancelSource("A");
        }
        if (boundary === "expiry") yield* TestClock.adjust("2 seconds");
        assert.equal(yield* f.service.respond(response(request), sender), false);
        assert.equal((yield* Fiber.join(read)).status, "unavailable");
      }).pipe(Effect.scoped),
    );
  }

  it("explicit strict diagnostic decoder rejects foreign scope, raw fields, invalid enum, absent sequence and oversized nonce", () => {
    const binding = {
      version: 1,
      requestSequence: 1,
      requestId: "request",
      requestNonce: "nonce",
      target,
      mainSession: "session",
      windowId: 7,
      frameProcessId: 11,
      frameRoutingId: 12,
      navigationGeneration: 0,
      expiresAtMs: 2_000,
    } as const;
    const decode = Schema.decodeUnknownOption(MainRendererDiagnosticsRequest, {
      onExcessProperty: "error",
    });
    assert.equal(Option.isSome(decode(binding)), true);
    assert.equal(Option.isNone(decode({ ...binding, requestSequence: 0 })), true);
    assert.equal(Option.isNone(decode({ ...binding, requestNonce: "a".repeat(129) })), true);
    assert.equal(
      Option.isNone(decode({ ...binding, target: { ...target, threadId: "other" } })),
      true,
    );
    assert.equal(Option.isNone(decode({ ...binding, rawSettings: "must-never-cross" })), true);
    const ready = response(binding);
    assert.equal(ready.result.status, "ready");
    const gate = ready.result.status === "ready" ? ready.result.gate : undefined;
    assert.equal(
      Option.isNone(
        Schema.decodeUnknownOption(MainRendererDiagnosticsResponse)({
          ...ready,
          result: { status: "ready", gate: { ...gate, phase: "invented" } },
        }),
      ),
      true,
    );
  });

  it.effect(
    "actual diagnostic IPC methods reject excess payloads before touching the bound request",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const read = yield* f.service.read("A", () => true, f.input).pipe(Effect.forkScoped);
        const binding = yield* Queue.take(f.requests);
        let respondCalls = 0;
        let invalidateCalls = 0;
        const service = MainRendererDiagnostics.of({
          ...f.service,
          respond: (input, event) =>
            Effect.sync(() => {
              respondCalls++;
            }).pipe(Effect.andThen(f.service.respond(input, event))),
          invalidate: (input, event) =>
            Effect.sync(() => {
              invalidateCalls++;
            }).pipe(Effect.andThen(f.service.invalidate(input, event))),
        });
        const layer = Layer.succeed(MainRendererDiagnostics, service);
        const ready = response(binding);
        const invalidation = { binding, rendererEpoch: 1, revision: 1 };
        const topReply = yield* respondMethod
          .handler({ ...ready, rawSettings: "refused" }, sender)
          .pipe(Effect.provide(layer), Effect.exit);
        const nestedReply = yield* respondMethod
          .handler(
            { ...ready, binding: { ...binding, target: { ...target, rawSettings: "refused" } } },
            sender,
          )
          .pipe(Effect.provide(layer), Effect.exit);
        const topInvalidation = yield* invalidateMethod
          .handler({ ...invalidation, rawSettings: "refused" }, sender)
          .pipe(Effect.provide(layer), Effect.exit);
        const nestedInvalidation = yield* invalidateMethod
          .handler({ ...invalidation, binding: { ...binding, rawSettings: "refused" } }, sender)
          .pipe(Effect.provide(layer), Effect.exit);
        assert.isTrue(Exit.isFailure(topReply));
        assert.isTrue(Exit.isFailure(nestedReply));
        assert.isTrue(Exit.isFailure(topInvalidation));
        assert.isTrue(Exit.isFailure(nestedInvalidation));
        assert.equal(respondCalls, 0);
        assert.equal(invalidateCalls, 0);
        assert.equal(yield* respondMethod.handler(ready, sender).pipe(Effect.provide(layer)), true);
        assert.equal(respondCalls, 1);
        assert.equal((yield* Fiber.join(read)).status, "ready");
        const second = yield* f.service
          .read("A", () => true, { ...f.input, requestId: "read-2", requestNonce: "caller-2" })
          .pipe(Effect.forkScoped);
        const nextBinding = yield* Queue.take(f.requests);
        assert.equal(
          yield* invalidateMethod
            .handler({ binding: nextBinding, rendererEpoch: 1, revision: 1 }, sender)
            .pipe(Effect.provide(layer)),
          true,
        );
        assert.equal(invalidateCalls, 1);
        assert.equal((yield* Fiber.join(second)).status, "unavailable");
      }).pipe(Effect.scoped),
  );

  it("actual legacy hello decoder accepts the optional advertisement without diagnostic emission", () => {
    // Exact pre-feature hello schema, not the new union decoding itself.
    const oldHello = Schema.Struct({
      version: Schema.Literal(1),
      type: Schema.Literal("desktopTelemetryHello"),
      electronPid: PositiveInt,
    });
    const hello = {
      version: 1,
      type: "desktopTelemetryHello",
      electronPid: 1,
      mainRendererDiagnostics: { revision: 1, desktopNonce: "nonce" },
    } as const;
    assert.deepEqual(Schema.decodeUnknownSync(oldHello)(hello), {
      version: 1,
      type: "desktopTelemetryHello",
      electronPid: 1,
    });
    assert.equal(Option.isSome(Schema.decodeUnknownOption(DesktopHostTelemetryHello)(hello)), true);
  });
});
