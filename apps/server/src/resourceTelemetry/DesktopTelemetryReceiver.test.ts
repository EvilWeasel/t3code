import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Queue from "effect/Queue";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DesktopTelemetryControlMessage, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import type * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import { assert, describe, expect } from "vite-plus/test";

import {
  make,
  type DesktopTelemetryReceiverHealth,
  initialDesktopTelemetryContactAt,
  isDesktopTelemetryContactStale,
  recordDesktopTelemetrySampleHealth,
  requireDesktopTelemetryWriteProgress,
  resolveDesktopTelemetrySnapshotStaleAfterMs,
  writeAllToFileDescriptor,
} from "./DesktopTelemetryReceiver.ts";

describe("DesktopTelemetryReceiver", () => {
  it("degrades a hello-only stream after the first-sample deadline", () => {
    expect(isDesktopTelemetryContactStale(Option.some(1_000), 90_999)).toBe(false);
    expect(isDesktopTelemetryContactStale(Option.some(1_000), 91_000)).toBe(true);
    expect(isDesktopTelemetryContactStale(Option.none(), 1_000_000)).toBe(false);
  });

  it("starts the stale deadline as soon as a telemetry descriptor is opened", () => {
    expect(initialDesktopTelemetryContactAt(7, 1_000)).toEqual(Option.some(1_000));
    expect(initialDesktopTelemetryContactAt(undefined, 1_000)).toEqual(Option.none());
  });

  it("keeps the snapshot deadline beyond the configured idle polling interval", () => {
    expect(resolveDesktopTelemetrySnapshotStaleAfterMs(30_000, 120_000)).toBe(150_000);
    expect(resolveDesktopTelemetrySnapshotStaleAfterMs(60_000, 600_000)).toBe(630_000);
    expect(resolveDesktopTelemetrySnapshotStaleAfterMs(1_000, 1_000)).toBe(90_000);
  });

  it.effect("publishes the latest sample timestamp while health remains healthy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initialSample = DateTime.makeUnsafe(1_000);
        const nextSample = DateTime.makeUnsafe(2_000);
        const health = yield* Ref.make<DesktopTelemetryReceiverHealth>({
          status: "healthy",
          lastSampleAt: Option.some(initialSample),
          lastError: Option.none<string>(),
        });
        const healthChanges = yield* PubSub.sliding<DesktopTelemetryReceiverHealth>(4);
        const subscription = yield* PubSub.subscribe(healthChanges);

        yield* recordDesktopTelemetrySampleHealth(health, healthChanges, nextSample);
        const published = yield* PubSub.take(subscription).pipe(Effect.timeout("1 second"));

        expect(DateTime.toEpochMillis(Option.getOrThrow(published.lastSampleAt))).toBe(2_000);
      }),
    ),
  );

  it.effect("writes control messages through the asynchronous descriptor path", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const directory = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-desktop-telemetry-control-test-"),
        );
        const path = NodePath.join(directory, "control.ndjson");
        return {
          directory,
          path,
          fd: NodeFS.openSync(path, "w"),
        };
      }),
      ({ fd, path }) =>
        Effect.gen(function* () {
          const payload = Buffer.from('{"type":"setDiagnosticsDemand","enabled":true}\n');
          yield* writeAllToFileDescriptor(fd, payload);
          NodeFS.fsyncSync(fd);

          assert.equal(NodeFS.readFileSync(path, "utf8"), payload.toString("utf8"));
        }),
      ({ directory, fd }) =>
        Effect.sync(() => {
          NodeFS.closeSync(fd);
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }),
    ),
  );

  it.effect("models a zero-byte control write as a stalled descriptor", () =>
    Effect.gen(function* () {
      const error = yield* requireDesktopTelemetryWriteProgress(7, 42, 0).pipe(Effect.flip);

      expect(error._tag).toBe("DesktopTelemetryControlStalled");
      expect(error.fd).toBe(7);
      expect(error.remainingBytes).toBe(42);
      expect(error.message).toBe(
        "Desktop telemetry control stalled on fd 7 with 42 bytes remaining.",
      );
      yield* requireDesktopTelemetryWriteProgress(7, 42, 1);
    }),
  );
});

for (const extra of ["none", "top", "nested"] as const) {
  it.effect(
    `requires paired support and strict ${extra} reply fields on the actual NDJSON receiver`,
    () =>
      Effect.gen(function* () {
        const inputQueue = yield* Queue.unbounded<string, Cause.Done>();
        const inputStream = yield* NodeStream.toReadable(Stream.fromQueue(inputQueue));
        const requestSeen =
          yield* Deferred.make<
            Extract<DesktopTelemetryControlMessage, { type: "mainRendererDiagnosticsRequest" }>
          >();
        const commands: DesktopTelemetryControlMessage[] = [];
        const config = yield* ServerConfig.ServerConfig;
        const decodeControl = Schema.decodeUnknownEffect(
          Schema.fromJsonString(DesktopTelemetryControlMessage),
        );
        const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
        const receiver = yield* make({
          readable: inputStream,
          write: (_fd, bytes) =>
            Effect.gen(function* () {
              const message = yield* decodeControl(new TextDecoder().decode(bytes)).pipe(
                Effect.orDie,
              );
              commands.push(message);
              if (message.type === "mainRendererDiagnosticsRequest")
                yield* Deferred.succeed(requestSeen, message);
            }),
        }).pipe(
          Effect.provideService(ServerConfig.ServerConfig, {
            ...config,
            desktopTelemetryFd: 7,
            desktopTelemetryControlFd: 8,
          }),
        );
        const request = {
          requestId: "read",
          requestNonce: "nonce",
          optIn: true as const,
          expiresAtMs: DateTime.toEpochMillis(yield* DateTime.now) + 5_000,
          target: {
            environmentId: "24efa85c-862c-4de4-9b5e-aaaa041e28a4" as const,
            threadId: "7cd05d6b-5e09-4691-a664-0b56c6283f12" as const,
            providerInstanceId: "codex",
          },
        };
        assert.deepEqual(
          yield* receiver.readMainRendererDiagnostics!(request, request.target.environmentId),
          {
            status: "unavailable",
            reason: "unsupported",
            unsupportedDiagnostic: { site: "fd-peer-missing" },
          },
        );
        assert.equal(
          commands.some((m) => m.type === "mainRendererDiagnosticsPeer"),
          false,
        );
        yield* Queue.offer(
          inputQueue,
          (yield* encode({
            version: 1,
            type: "desktopTelemetryHello",
            electronPid: 1,
            legacyExtra: "preserved compatibility",
            mainRendererDiagnostics: { revision: 1, desktopNonce: "desktop" },
          })) + "\n",
        );
        // This actual decoded hello updates health; subscribe-before-write provides the milestone.
        const read = yield* Effect.gen(function* () {
          const health = yield* receiver.subscribeHealth;
          if (health.latest.status !== "healthy")
            yield* health.changes.pipe(
              Stream.filter((v) => v.status === "healthy"),
              Stream.runHead,
            );
          return yield* receiver.readMainRendererDiagnostics!(
            request,
            request.target.environmentId,
          );
        }).pipe(Effect.forkScoped);
        const sent = yield* Deferred.await(requestSeen);
        const reply = {
          version: 1,
          type: "mainRendererDiagnosticsReply",
          desktopNonce: "desktop",
          serverNonce: sent.serverNonce,
          requestId: request.requestId,
          requestNonce: request.requestNonce,
          result: { status: "unavailable", reason: "off" },
        } as const;
        yield* Queue.offer(
          inputQueue,
          (yield* encode({
            ...reply,
            requestNonce: "wrong",
            result: { status: "unavailable", reason: "invalid-response" },
          })) + "\n",
        );
        const rawReply =
          extra === "top"
            ? { ...reply, rawSettings: "refused" }
            : extra === "nested"
              ? { ...reply, result: { ...reply.result, rawSettings: "refused" } }
              : reply;
        yield* Queue.offer(inputQueue, (yield* encode(rawReply)) + "\n");
        assert.deepEqual(yield* Fiber.join(read), {
          status: "unavailable",
          reason: extra === "none" ? "off" : "source-closed",
        });
        if (extra !== "none") {
          assert.equal((yield* receiver.subscribeHealth).latest.status, "degraded");
        }
        assert.equal(commands.filter((m) => m.type === "mainRendererDiagnosticsPeer").length, 1);
        assert.equal(commands.filter((m) => m.type === "mainRendererDiagnosticsRequest").length, 1);
        yield* Queue.end(inputQueue);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            ServerConfig.layerTest("/fixture", { prefix: "main-renderer-receiver" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
              subscribeChanges: Effect.succeed(Stream.empty),
            }),
          ),
        ),
      ),
  );
}
